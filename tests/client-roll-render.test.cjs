const assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {createHash,randomUUID}=require('node:crypto'),{inflateSync,createInflate}=require('node:zlib'),{Readable}=require('node:stream');
const {PNG}=require('pngjs'),{chromium}=require('playwright'),{NextRequest}=require('next/server');
const {fixture,png,load}=require('./client-jobs.test.cjs');
const render=load('app/api/_lib/roll-strip-renderer.js');
const limits=load('app/lib/client-portal-limits.js');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'roll-render-'));
const base=process.env.SMART_SHEET_TEST_URL||'http://localhost:3114';
const sha=b=>createHash('sha256').update(b).digest('hex');
function tags(b){
  const result={},offset=b.readUInt32LE(4),sizes={1:1,2:1,3:2,4:4,5:8,7:1};
  for(let n=0;n<b.readUInt16LE(offset);n++){
    const at=offset+2+n*12,tag=b.readUInt16LE(at),type=b.readUInt16LE(at+2),count=b.readUInt32LE(at+4),start=count*sizes[type]<=4?at+8:b.readUInt32LE(at+8);
    result[tag]=[1,2,7].includes(type)?b.subarray(start,start+count):Array.from({length:count},(_,i)=>type===3?b.readUInt16LE(start+i*2):type===4?b.readUInt32LE(start+i*4):b.readUInt32LE(start+i*8)/b.readUInt32LE(start+i*8+4));
  }return result;
}
async function eventsFile(job,kind,source){
  const filename=path.join(out,`${randomUUID()}.ndjson`),file=fs.openSync(filename,'w'),start=performance.now();let strips=0;
  try{for await(const e of render.rollRenderEvents(job,kind,async()=>new Response(source),()=>{})){
    if(e.type==='strip')strips++;fs.writeSync(file,JSON.stringify(e)+'\n');
  }fs.writeSync(file,'{"type":"complete"}\n');}finally{fs.closeSync(file);}
  return {filename,ms:Math.round(performance.now()-start),strips};
}
(async()=>{
  const f=await fixture();let browser;
  try{
    const pattern=new PNG({width:17,height:73});
    for(let y=0;y<73;y++)for(let x=0;x<17;x++){const i=(y*17+x)*4;pattern.data[i]=x*11;pattern.data[i+1]=y*3;pattern.data[i+2]=87;pattern.data[i+3]=[4,128,255][(x+y)%3];}
    const patternPath=path.join(out,'native-pattern.png'),rawPath=path.join(out,'native-pattern.rgba');
    fs.writeFileSync(patternPath,PNG.sync.write(pattern));
    await render.decodeOriginal(patternPath,rawPath,{width:17,height:73,crop:{x:0,y:0,w:17,h:73}},()=>{});
    const nativeFile=await fs.promises.open(rawPath,'r');
    try{for(const rotation of [0,90,180,270]){
      const p={assetId:'pattern',x:2,y:2,w:rotation%180?73:17,h:rotation%180?17:73,rotation};
      const sheet={widthPx:p.w+4,heightPx:p.h+4,placements:[p]};
      for(let top=0;top<sheet.heightPx;top+=32){const rows=Math.min(32,sheet.heightPx-top),strip=await render.renderStrip(sheet,{pattern:{file:nativeFile,w:17,h:73}},top,rows,()=>{});
        for(let dy=Math.max(0,top-2);dy<Math.min(p.h,top+rows-2);dy++)for(let dx=0;dx<p.w;dx++){
          const [sx,sy]=rotation===0?[dx,dy]:rotation===90?[dy,72-dx]:rotation===180?[16-dx,72-dy]:[16-dy,dx];
          const at=((dy+2-top)*sheet.widthPx+dx+2)*4,src=(sy*17+sx)*4;
          assert.deepEqual(strip.subarray(at,at+4),pattern.data.subarray(src,src+4),`native ${rotation}° pixels/alpha preserved across strips`);
        }
      }
    }}finally{await nativeFile.close();}
    const config={...f.lib.defaults,shopName:'Print test shop',email:'shop@example.test',mediaMode:'continuous',leadIn:.5,trailIn:.5};
    const token=await f.portal('basic',config),confirmed=await f.confirmed(token,1,png(90,120));
    let job=await f.lib.jobs('get',{p_owner:f.users.basic.id,p_job:confirmed.job.id});
    const source=png(90,120),a={...job.assets[0],crop:{x:0,y:0,w:90,h:120},width:90,height:120,sha256:sha(source),bytes:source.length,widthIn:.3,heightIn:.4,qty:1};
    const smallConfig={...config,widthIn:3};
    job={...job,assets:[a],manifest:f.lib.layout([a],smallConfig)};
    const smallPng=await eventsFile(job,'png',source),smallTiff=await eventsFile(job,'tiff',source);
    // Exercise the shipped iframe/profile helpers and streaming browser encoder.
    browser=await chromium.launch({channel:'chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1360,height:950}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const hook='window.rollHelpers={getExportProfile,getColorAssets,spot:spotMaskValue,pack:packBitsRow,concat:concatBytes,u16:u16le,shorts:shortsLE,layer:buildPhotoshopLayerBlock,prefix:buildTiffPrefix,resources:buildPhotoshopResources};';
    const originalHtml=fs.readFileSync('public/builder.html','utf8');
    await page.route('**/builder.html*',r=>r.fulfill({body:originalHtml.replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>'),contentType:'text/html'}));
    const streams=new Map([['small-png',smallPng.filename],['small-tiff',smallTiff.filename]]);
    await page.route('**/test-stream/*',r=>r.fulfill({path:streams.get(new URL(r.request().url()).pathname.split('/').at(-1)),contentType:'application/x-ndjson'}));
    await page.goto(`${base}/builder.html?clientJob=1`);
    await page.addScriptTag({url:base+'/client-roll-export.js'});
    await page.waitForFunction(()=>window.rollHelpers&&window.SmartSheetRollExport);
    async function encode(job,kind,key,mode='rgb'){
      const start=performance.now();
      const b64=await page.evaluate(async({job,kind,key,mode})=>{
        const h=rollHelpers,profile=h.getExportProfile(mode),color=mode==='cmyk'?await h.getColorAssets():null;
        window.stripProgress=[];
        const blob=await SmartSheetRollExport.encode({job,kind,profile,color,helpers:h,request:()=>fetch('/test-stream/'+key),progress:msg=>stripProgress.push(msg)});
        const buffer=await blob.arrayBuffer();let text='';const b=new Uint8Array(buffer);for(let i=0;i<b.length;i+=32768)text+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(text);
      },{job,kind,key,mode});
      return {buffer:Buffer.from(b64,'base64'),ms:Math.round(performance.now()-start)};
    }
    const native=PNG.sync.read(source),p=await encode(job,'png','small-png'),decoded=PNG.sync.read(p.buffer),s=job.manifest.sheets[0],placement=s.placements[0];
    for(let y=0;y<120;y++)for(let x=0;x<90;x++)assert.deepEqual(decoded.data.subarray(((placement.y+y)*s.widthPx+placement.x+x)*4,((placement.y+y)*s.widthPx+placement.x+x)*4+4),native.data.subarray((y*90+x)*4,(y*90+x)*4+4),'full native RGBA, including low alpha, matches exactly');
    let ph=8;while(p.buffer.toString('ascii',ph+4,ph+8)!=='pHYs')ph+=p.buffer.readUInt32BE(ph)+12;
    assert.equal(p.buffer.readUInt32BE(ph+8),11811);assert.equal(p.buffer[ph+16],1);
    for(const mode of ['rgb','cmyk']){
      const result=await encode(job,'tiff','small-tiff',mode),t=tags(result.buffer);
      assert.deepEqual([t[256][0],t[257][0]],[s.widthPx,s.heightPx]);assert.equal(t[259][0],8);assert.equal(t[282][0],300);assert.equal(t[283][0],300);
      assert.equal(t[262][0],mode==='rgb'?2:5);assert.equal(t[277][0],mode==='rgb'?4:5);assert.deepEqual(t[338],[0]);
      assert(Buffer.from(t[34377]).includes(Buffer.from('W1\0')));assert(t[37724].length>0);
      const samples=t[277][0],pixels=Buffer.concat(t[273].map((off,i)=>inflateSync(result.buffer.subarray(off,off+t[279][i]))));
      assert.equal(pixels.length,s.widthPx*s.heightPx*samples);
      if(mode==='rgb')for(let y=0;y<120;y++)for(let x=0;x<90;x++){
        const i=(y*90+x)*4,o=((placement.y+y)*s.widthPx+placement.x+x)*4,alpha=native.data[i+3];
        for(let c=0;c<3;c++)assert.equal(pixels[o+c],alpha?Math.floor((native.data[i+c]*alpha+127)/255):255,'existing RGB+W1 color samples unchanged at strip boundaries');
      }
      fs.writeFileSync(path.join(out,`small-${mode}.tif`),result.buffer);
    }
    // A truncated stream must never produce a downloadable partial file.
    const broken=path.join(out,'broken.ndjson');fs.writeFileSync(broken,fs.readFileSync(smallTiff.filename,'utf8').replace('{"type":"complete"}\n',''));streams.set('broken',broken);
    await assert.rejects(()=>encode(job,'tiff','broken'),/interrupted/);
    // Guard remains intact for fixed profiles, and width/roll safety is explicit.
    const largeAsset={...a,width:6600,height:11700,crop:{x:0,y:0,w:6600,h:11700},widthIn:21.7,heightIn:38.56};
    const manifest=f.lib.layout([largeAsset],config);
    assert.equal(manifest.meters,1.004824);assert.deepEqual([manifest.sheets[0].widthPx,manifest.sheets[0].heightPx],[6900,11868]);
    assert.equal(limits.outputProblem(manifest,0,[largeAsset]),'');
    assert.match(limits.outputProblem({...manifest,mediaMode:'fixed'},0,[largeAsset]),/32 Mi pixels/);
    const endpoint=load('app/api/client-jobs/[id]/render/route.js');
    assert.equal((await endpoint.POST(f.req('/render',{},'basic'),{params:{id:job.id}})).status,403);
    assert.equal((await endpoint.POST(f.req('/render',{}),{params:{id:job.id}})).status,401);
    // Server-prepared tokens retain account, job, fingerprint and kind binding.
    const requestKey=randomUUID(),operation={action:'prepare',jobId:job.id,exportKind:'tiff',requestKey,fingerprint:'roll-render-test'};
    const prepared=await (await f.consume.POST(f.req('/export',operation,'basic'))).json();assert(prepared.allowed);
    await f.db.query('update client_jobs set assets=$2,manifest=$3 where id=$1',[job.id,JSON.stringify([a]),JSON.stringify(job.manifest)]);
    let response=await endpoint.POST(f.req('/render',{...operation,authorization:prepared.authorization},'basic'),{params:{id:job.id}});
    assert.equal(response.status,200);assert.match(await response.text(),/"type":"complete"/);
    assert.equal((await endpoint.POST(f.req('/render',{...operation,authorization:prepared.authorization},'unlimited'),{params:{id:job.id}})).status,403);
    assert.equal((await endpoint.POST(f.req('/render',{...operation,exportKind:'png',authorization:prepared.authorization},'basic'),{params:{id:job.id}})).status,403);

    let largeReport='Skipped (ROLL_RENDER_LARGE=0)';
    if(process.env.ROLL_RENDER_LARGE!=='0'){
      const sourcePath=process.env.ROLL_RENDER_FILE||path.join(os.homedir(),'Downloads','BORACAY 22x39.png');
      const original=fs.existsSync(sourcePath)?fs.readFileSync(sourcePath):png(6600,11700);
      const asset={...largeAsset,width:original.readUInt32BE(16),height:original.readUInt32BE(20),bytes:original.length,sha256:sha(original)};
      asset.crop={x:0,y:0,w:asset.width,h:asset.height};
      const largeJob={...job,assets:[asset],manifest:f.lib.layout([asset],config)};
      const largeTiff=await eventsFile(largeJob,'tiff',original);streams.set('large-tiff',largeTiff.filename);
      const result=await encode(largeJob,'tiff','large-tiff'),t=tags(result.buffer);
      assert.deepEqual([t[256][0],t[257][0],t[282][0],t[283][0]],[6900,11868,300,300]);
      assert.equal(t[273].length,371);assert.equal(t[278][0],32);
      // Digest every final TIFF sample against the original rendered strips,
      // including W1 halos at EVERY boundary; no gaps/duplicate output rows.
      const expected=createHash('sha256'),actual=createHash('sha256'),rgbaHash=createHash('sha256');let index=0;
      for(const line of fs.readFileSync(largeTiff.filename,'utf8').trim().split('\n')){
        const e=JSON.parse(line);if(e.type!=='strip')continue;
        const rgba=inflateSync(Buffer.from(e.data,'base64')),width=6900,bytes=Buffer.alloc(width*e.rows*4);
        rgbaHash.update(rgba.subarray((e.y-e.top)*width*4,(e.y-e.top+e.rows)*width*4));
        for(let row=0;row<e.rows;row++)for(let x=0;x<width;x++){
          const i=((e.y+row-e.top)*width+x)*4,o=(row*width+x)*4,alpha=rgba[i+3];
          for(let c=0;c<3;c++)bytes[o+c]=alpha?Math.floor((rgba[i+c]*alpha+127)/255):255;
          let spot=0;if(alpha&&x>0&&x<width-1&&e.y+row>0&&e.y+row<11867)spot=Math.min(alpha,rgba[i-1],rgba[i+7],rgba[i-width*4+3],rgba[i+width*4+3],rgba[i-width*4-1],rgba[i-width*4+7],rgba[i+width*4-1],rgba[i+width*4+7]);
          bytes[o+3]=255-spot;
        }
        expected.update(bytes);const decodedStrip=inflateSync(result.buffer.subarray(t[273][index],t[273][index]+t[279][index]));assert.equal(decodedStrip.length,bytes.length);actual.update(decodedStrip);index++;
      }
      assert.equal(actual.digest('hex'),expected.digest('hex'));
      fs.writeFileSync(path.join(out,'boracay-full-resolution.tif'),result.buffer);
      const largePng=await eventsFile(largeJob,'png',original);streams.set('large-png',largePng.filename);
      const pngFile=await encode(largeJob,'png','large-png');fs.writeFileSync(path.join(out,'boracay-full-resolution.png'),pngFile.buffer);
      assert.equal(pngFile.buffer.readUInt32BE(16),6900);assert.equal(pngFile.buffer.readUInt32BE(20),11868);
      const idat=[];let physCount=0;
      for(let pos=8;pos<pngFile.buffer.length;){const size=pngFile.buffer.readUInt32BE(pos),type=pngFile.buffer.toString('ascii',pos+4,pos+8);if(type==='IDAT')idat.push(pngFile.buffer.subarray(pos+8,pos+8+size));if(type==='pHYs'){physCount++;assert.equal(pngFile.buffer.readUInt32BE(pos+8),11811);assert.equal(pngFile.buffer.readUInt32BE(pos+12),11811);assert.equal(pngFile.buffer[pos+16],1);}pos+=size+12;}
      assert.equal(physCount,1);
      const inflater=createInflate(),pngHash=createHash('sha256');let rowOffset=0,decodedBytes=0;
      Readable.from(idat).pipe(inflater);
      for await(const part of inflater){let at=0;while(at<part.length){if(rowOffset===0){assert.equal(part[at++],0);rowOffset=1;if(at===part.length)break;}const take=Math.min(6900*4+1-rowOffset,part.length-at);pngHash.update(part.subarray(at,at+take));decodedBytes+=take;at+=take;rowOffset=(rowOffset+take)%(6900*4+1);}}
      assert.equal(decodedBytes,6900*11868*4);assert.equal(rowOffset,0);assert.equal(pngHash.digest('hex'),rgbaHash.digest('hex'),'every final PNG RGBA sample matches TIFF original-source geometry, including all strip and meter boundaries');
      assert.equal(sha(original),asset.sha256,'immutable original bytes never change');
      largeReport={source:[asset.width,asset.height],sourceMP:asset.width*asset.height/1e6,sourceSha256:asset.sha256,pixels:[6900,11868],ppi:300,inches:[23,39.56],meters:1.004824,stripRows:32,strips:371,serverTiffMs:largeTiff.ms,clientTiffMs:result.ms,serverPngMs:largePng.ms,clientPngMs:pngFile.ms,tiffBytes:result.buffer.length,pngBytes:pngFile.buffer.length,allTiffStrips:'exact sample hashes including alpha-derived W1'};
      await f.db.query('update client_jobs set assets=$2,manifest=$3,quantity=1,meters=$4 where id=$1',[job.id,JSON.stringify([asset]),JSON.stringify(largeJob.manifest),largeJob.manifest.meters]);
      f.objects.set(asset.path,original);
      const owner=await browser.newPage({viewport:{width:1400,height:1000}}),user=f.users.basic;
      const jwt=`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),role:'authenticated'})).toString('base64url')}.test-signature`;
      await owner.addInitScript(({user,jwt})=>localStorage.setItem('smart-sheet-builder-v53b-session',JSON.stringify({accessToken:jwt,refreshToken:'fixture-refresh',user})),{user,jwt});
      await owner.route('**/auth/v1/**',r=>r.fulfill({json:r.request().url().includes('/token')?{access_token:jwt,refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user}:user}));
      let renderRequests=0;
      await owner.route('**/api/**',async route=>{
        const r=route.request(),url=new URL(r.url()),req=new NextRequest(r.url(),{method:r.method(),headers:{...r.headers(),authorization:'Bearer basic'},...(r.method()==='POST'?{body:r.postDataBuffer()}:{})});
        const file=url.pathname.match(/^\/api\/client-jobs\/([^/]+)\/files\/([^/]+)$/);let response;
        if(file)response=await f.files.GET(req,{params:{id:file[1],file:file[2]}});
        else if(url.pathname.endsWith('/render')){renderRequests++;response=await endpoint.POST(req,{params:{id:job.id}});}
        else if(url.pathname==='/api/client-jobs')response=await f.owner[r.method()](req);
        else if(url.pathname==='/api/auth/me')response=await f.me.GET(req);
        else if(url.pathname==='/api/export/status')response=await f.status.GET(req);
        else if(url.pathname==='/api/export/consume')response=await f.consume.POST(req);
        else response=Response.json({history:[],profile:{},credits:{balance:2}});
        await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
      });
      await owner.goto(`${base}/?clientJob=${job.id}`);
      await owner.getByRole('region',{name:'Roll usage estimate'}).waitFor({timeout:60000});
      await owner.waitForFunction(()=>document.querySelector('.client-preview canvas')&&!document.querySelector('.client-preview[hidden]'),{},{timeout:60000});
      const bounds=await owner.locator('.client-detail-panel').evaluate(el=>[el.getBoundingClientRect().width,el.parentElement.getBoundingClientRect().width]);
      assert(bounds[0]>bounds[1]*.9);
      await owner.locator('.client-detail-panel').scrollIntoViewIfNeeded();
      await owner.screenshot({path:path.join(out,'boracay-owner-preview.png')});
      const download=owner.waitForEvent('download',{timeout:120000});
      const productionFrame=owner.frames().find(frame=>frame.url().includes('clientJob=1'));
      await productionFrame.evaluate(()=>{window.nativeExportAllocations={bitmaps:0,canvases:0};const create=window.createImageBitmap;window.createImageBitmap=(...args)=>{nativeExportAllocations.bitmaps++;return create(...args);};const element=document.createElement.bind(document);document.createElement=(name,...args)=>{if(name==='canvas')nativeExportAllocations.canvases++;return element(name,...args);};});
      await owner.getByRole('button',{name:'Convert layout to TIFF',exact:true}).click();
      const frame=owner.frameLocator('iframe[title="Client submission production export"]');
      await frame.locator('#dtfCheckConfirm').click();
      await owner.getByText('Preparing full-resolution print file…',{exact:true}).waitFor();
      await owner.screenshot({path:path.join(out,'boracay-render-progress.png')});
      const final=fs.readFileSync(await (await download).path()),finalTags=tags(final);
      assert.deepEqual([finalTags[256][0],finalTags[257][0],finalTags[282][0]],[6900,11868,300]);
      assert.equal(renderRequests,1,'one click, one native render');
      assert.deepEqual(await productionFrame.evaluate(()=>nativeExportAllocations),{bitmaps:0,canvases:0},'roll TIFF never allocates a native browser image or full-roll canvas');
      await owner.setViewportSize({width:390,height:750});
      assert(await owner.evaluate(()=>document.querySelector('.client-jobs-dialog').scrollWidth<=document.querySelector('.client-jobs-dialog').clientWidth+1));
      await owner.screenshot({path:path.join(out,'boracay-owner-mobile.png')});
      largeReport.ownerConversion='PASS: actual Convert layout to TIFF → profile confirmation → signed private renderer → credit-gated download';
    }
    await f.db.query("update client_jobs set expires_at=now()-interval '1 second' where id=$1",[job.id]);
    const expired=await endpoint.POST(f.req('/render',{...operation,authorization:prepared.authorization},'basic'),{params:{id:job.id}});assert.equal(expired.status,410);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:['native PNG pixel/alpha identity','300 PPI PNG pHYs','TIFF RGB/CMYK + W1 + Photoshop transparency','strip continuity','fixed-sheet guard unchanged','truncated stream blocks saving','owner-only signed authorization','24-hour expiry','immutable source checksum'],largeReport,artifacts:out},null,2));
  }finally{await browser?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
