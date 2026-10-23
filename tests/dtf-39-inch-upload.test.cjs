const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createDeflate } = require('node:zlib');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const crc32 = require('pngjs/lib/crc').crc32;
const baseline = execFileSync('git', ['show', '204cac5:public/builder.html'], { encoding:'utf8', maxBuffer:4*1024*1024 });
const current = fs.readFileSync('public/builder.html','utf8');
const out = fs.mkdtempSync(path.join(os.tmpdir(),'dtf-39-inch-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hook = `
window.dtf39={get designs(){return designs},get sheets(){return sheets},get instances(){return instances},
  settings:getSheetPixelSettings,proxy:previewSource,report:printReadinessReport,draw:drawSheetCanvas,
  downloadPng,downloadTiff,getExportProfile,isProxy:source=>previewBitmaps.has(source),
  setSize:function(w,h){designs[0].widthIn=w;designs[0].heightIn=h;designs[0].lockAspect=false;renderAllDesigns();},
  nativeGuard:assertNativeImageDimensions,
  nativeSamples:function(){var d=designs[0],c=d.trimmed.canvas;return {original:[d.originalCanvas.width,d.originalCanvas.height],active:[c.width,c.height],
    proxy:[previewSource(c).width,previewSource(c).height],same:d.originalCanvas===c,source:Array.from(c.getContext('2d').getImageData(0,0,2,1).data)};},
  seedSmall:function(){var d=designs[0];d.widthIn=1.5;d.heightIn=1;d.qty=1;document.getElementById('sheetWidth').value=3;document.getElementById('sheetLength').value=3;document.getElementById('dpi').value=60;
    var s=getSheetPixelSettings();instances=createInstancesForDesign(d,s.dpi);sheets=[{widthPx:180,heightPx:180,gapPx:6,headerHeightPx:0,placements:[{inst:instances[0],x:12,y:18,w:90,h:60}]}];renderAllSheets();return sheets[0];},
  smallPixels:async function(){var sheet=this.seedSmall(),c=document.createElement('canvas');drawSheetCanvas(c,sheet);var digest=await crypto.subtle.digest('SHA-256',c.getContext('2d').getImageData(0,0,c.width,c.height).data);c.width=c.height=0;return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');}
};
exportDelivery=SmartSheetExportDelivery.create({gate:async()=>({allowed:true,authorization:'39-inch-test-only'}),save:saveExportBlob});
`;
// Stream PNG construction so the test itself never needs an 80-MP Node buffer.
async function makePng(width,height) {
  const row=Buffer.alloc(1+width*4);
  for(let x=0;x<width;x++){const i=1+x*4;row[i]=18;row[i+1]=92;row[i+2]=166;row[i+3]=x%23===1?128:x%29===2?0:255;}
  const zip=createDeflate(),parts=[];zip.on('data',bytes=>parts.push(bytes));
  const ended=once(zip,'end');
  for(let y=0;y<height;y++)if(!zip.write(row))await once(zip,'drain');
  zip.end();await ended;
  function chunk(type,bytes){const b=Buffer.alloc(bytes.length+12);b.writeUInt32BE(bytes.length);b.write(type,4);bytes.copy(b,8);b.writeInt32BE(crc32(b.subarray(4,-4)),b.length-4);return b;}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',Buffer.concat(parts)),chunk('IEND',Buffer.alloc(0))]);
}
function tiffTags(bytes) {
  const offset=bytes.readUInt32LE(4),tags={};
  for(let n=0;n<bytes.readUInt16LE(offset);n++){
    const at=offset+2+n*12,tag=bytes.readUInt16LE(at),type=bytes.readUInt16LE(at+2),count=bytes.readUInt32LE(at+4);
    if(count===1){let value=bytes.readUInt32LE(at+8);if(type===3)value=bytes.readUInt16LE(at+8);if(type===5)value=bytes.readUInt32LE(value)/bytes.readUInt32LE(value+4);tags[tag]=value;}
  }return tags;
}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[];
  async function setup(old=false){
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(180000);page.on('pageerror',e=>errors.push(e.message));
    await require('./preflight-review-helper.cjs')(page);
    const html=(old?baseline:current).replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
    await page.route('http://localhost:4240/**',r=>{
      const p=new URL(r.request().url()).pathname;
      if(p==='/builder.html')return r.fulfill({body:html,contentType:'text/html'});
      if(/\.(js|css)$/.test(p))return r.fulfill({body:fs.readFileSync('public'+p),contentType:p.endsWith('.js')?'text/javascript':'text/css'});
      return r.fulfill({body:'<style>iframe{width:100%;height:980px;border:0}body{margin:0}</style><iframe src="/builder.html"></iframe>',contentType:'text/html'});
    });
    await page.goto('http://localhost:4240/');const doc=page.frames().find(f=>f.url().endsWith('/builder.html')),frame=page.frameLocator('iframe');
    await doc.waitForFunction(()=>window.dtf39);return {page,doc,frame};
  }
  async function upload(test,buffer,name){await test.frame.locator('#fileInput').setInputFiles({name,mimeType:'image/png',buffer});await test.doc.waitForFunction(name=>dtf39.designs.some(d=>d.file.name===name),name);}
  try{
    const native=await makePng(6900,11700),low=await makePng(1155,2048),small=await makePng(120,80);
    console.log('Fixtures ready: native 6900 x 11700, low-resolution 1155 x 2048, small 120 x 80.');
    let t=await setup(true);
    assert(await t.doc.evaluate(()=>{try{dtf39.nativeGuard(6900,11700,'PNG upload');return false;}catch(e){return /8192/.test(e.message);}}),'baseline software guard reproduces exact regression');
    await upload(t,small,'small.png');const smallBefore=await t.doc.evaluate(()=>dtf39.smallPixels());await t.page.close();
    t=await setup();
    assert.deepEqual(await t.doc.evaluate(()=>{const s=dtf39.settings(),c=document.querySelector('.sheet-canvas');return {sheet:[s.sheetWidthPx,s.sheetLengthPx],edge:s.autoEdgeAllowancePx,gap:s.gapPx,preview:[c.width,c.height]};}),{sheet:[6900,11700],edge:30,gap:30,preview:[1415,2400]});
    await upload(t,native,'production-6900x11700.png');
    const accepted=await t.doc.evaluate(()=>dtf39.nativeSamples());
    assert.deepEqual(accepted.original,[6900,11700]);assert.deepEqual(accepted.active,[6900,11700]);assert.deepEqual(accepted.proxy,[944,1600]);assert(accepted.same);
    assert.equal(await t.doc.evaluate(async()=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await dtf39.designs[0].file.arrayBuffer())),x=>x.toString(16).padStart(2,'0')).join('')),hash(native));
    assert(!await t.frame.locator('#errorMsg').isVisible());
    console.log('PASS: native 6900 x 11700 upload, immutable File, 944 x 1600 proxy.');
    await t.page.screenshot({path:path.join(out,'native-6900x11700-accepted.png')});await t.page.close();

    t=await setup();await upload(t,low,'1155x2048.png');
    const card=t.frame.locator('.design-item');await card.getByRole('checkbox',{name:'Lock aspect ratio',exact:true}).uncheck();
    await card.getByRole('spinbutton',{name:'Width',exact:true}).fill('22');await card.getByRole('spinbutton',{name:'Height',exact:true}).fill('39');
    assert.match(await card.locator('.source-quality').innerText(),/1155 × 2048 px.*52.5 PPI.*22 × 39 in.*Low resolution/);
    const unchanged=await t.doc.evaluate(()=>dtf39.nativeSamples());assert.deepEqual(unchanged.active,[1155,2048]);
    await card.getByRole('button',{name:'Add to layout',exact:true}).click();await t.doc.waitForFunction(()=>!document.querySelector('.design-item button[title="Add the remaining copies into open space, keeping current pieces in place."]')?.disabled&&dtf39.sheets.length===1);
    assert.match(await card.locator('.auto-fit-notice').innerText(),/22 × 39 in → 21.89 × 38.8 in/);assert.equal(await t.doc.evaluate(()=>dtf39.sheets.length),1);
    await t.page.screenshot({path:path.join(out,'22x39-auto-fit-explanation.png')});
    for(const mode of ['standard','max-fill']){
      await t.frame.getByLabel('Arrange mode',{exact:true}).selectOption(mode);await t.frame.locator('#packBtn').click();await t.doc.waitForFunction(()=>!document.getElementById('packBtn').disabled);
      assert.equal(await t.doc.evaluate(()=>dtf39.sheets.length),1);assert.deepEqual(await t.doc.evaluate(()=>{const p=dtf39.sheets[0].placements[0];return [p.inst.baseW,p.inst.baseH];}),[6566,11640]);
    }
    // Restore the pre-fit state before exercising edge-to-edge manual placement.
    await t.doc.evaluate(()=>{while(dtf39.sheets.length)document.getElementById('layoutUndo').click();});
    // Exercise the existing manual API, then real drag and selected-size controls.
    await t.doc.evaluate(async()=>{var file=dtf39.designs[0].file;await smartSheetWorkspace.addFile(file,{sheetIndex:0,x:150,y:150});smartSheetWorkspace.setOpen(true);});
    let handle=t.frame.locator('.drag-handle').first();await handle.scrollIntoViewIfNeeded();let box=await handle.boundingBox();
    await t.page.mouse.move(box.x+box.width/2,box.y+box.height/2);await t.page.mouse.down();await t.page.mouse.move(box.x-220,box.y-220,{steps:8});await t.page.mouse.up();
    await t.doc.waitForFunction(()=>dtf39.sheets[0].placements[0].x===0&&dtf39.sheets[0].placements[0].y===0);
    await t.frame.locator('#sw-lock').uncheck();await t.frame.locator('#sw-width').fill('22');await t.frame.locator('#sw-height').fill('39');await t.frame.getByRole('button',{name:'Apply',exact:true}).click();
    assert.deepEqual(await t.doc.evaluate(()=>{var p=dtf39.sheets[0].placements[0];return[p.x,p.y,p.w,p.h,p.inst.canvas.width,p.inst.canvas.height];}),[0,0,6600,11700,1155,2048]);
    const manual=await t.doc.evaluate(()=>dtf39.report(dtf39.sheets[0]));assert.equal(manual.blocking,false);assert(manual.issues.some(i=>i.level==='info'&&/machine\/cutting tolerance/.test(i.message)));
    assert.equal(manual.details[0].ppi,52.5);
    await t.doc.evaluate(()=>smartSheetWorkspace.setOpen(false));await t.frame.locator('.print-readiness > summary').click();await t.frame.getByText(/Edge-to-edge print may be clipped depending on machine\/cutting tolerance/).first().waitFor();
    await t.page.screenshot({path:path.join(out,'22x39-manual-full-bleed.png')});
    // Erase the display proxy. A real export must still draw native pixels.
    await t.doc.evaluate(()=>{
      const s=dtf39.sheets[0];s.placements.forEach(p=>{const proxy=dtf39.proxy(p.inst.canvas);proxy.getContext('2d').clearRect(0,0,proxy.width,proxy.height);});
      window.draws=[];const draw=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(source,...args){if(this.canvas.width===6900&&this.canvas.height===11700)draws.push({source:[source.width,source.height],proxy:dtf39.isProxy(source)});return draw.call(this,source,...args);};
    });
    const outputs={};
    for(const kind of ['png','rgb','cmyk']){
      console.log('Preparing full-resolution 6900 x 11700 '+kind+' export.');
      const download=t.page.waitForEvent('download',{timeout:180000});
      await t.doc.evaluate(kind=>kind==='png'?dtf39.downloadPng(dtf39.sheets[0],0):dtf39.downloadTiff(dtf39.sheets[0],0,dtf39.getExportProfile(kind)),kind);
      const bytes=fs.readFileSync(await(await download).path());
      if(kind==='png'){
        assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[6900,11700]);
        let at=8,physical;
        while(at<bytes.length){const n=bytes.readUInt32BE(at);if(bytes.toString('ascii',at+4,at+8)==='pHYs')physical=[bytes.readUInt32BE(at+8),bytes.readUInt32BE(at+12),bytes[at+16]];at+=n+12;}
        assert.deepEqual(physical,[11811,11811,1]);
        const png=PNG.sync.read(bytes);assert(png.data[3]>0,'erased proxy cannot erase exported full-resolution artwork');assert.equal(png.data[(6900-1)*4+3],0,'remaining sheet width stays transparent');
        outputs.png={pixels:[png.width,png.height],pHYs:physical};
      }else{
        const tags=tiffTags(bytes);assert.deepEqual([tags[256],tags[257],tags[282],tags[283]],[6900,11700,300,300]);outputs[kind]={pixels:[tags[256],tags[257]],ppi:tags[282]};
      }
    }
    const draws=await t.doc.evaluate(()=>draws);assert(draws.length>=3&&draws.every(d=>!d.proxy&&d.source.join()==='1155,2048'));
    assert.deepEqual(await t.doc.evaluate(()=>dtf39.nativeSamples().active),[1155,2048]);await t.page.close();
    t=await setup();await upload(t,small,'small.png');const smallAfter=await t.doc.evaluate(()=>dtf39.smallPixels());assert.equal(smallAfter,smallBefore,'normal small-sheet native raster remains pixel-identical to 204cac5');await t.page.close();
    assert.deepEqual(errors,[]);console.log(JSON.stringify({nativeUpload:accepted,preview:[1415,2400],sourcePpi:52.5,autoUsableIn:[22.8,38.8],existingHeaderUsableHeightIn:38.54,manual:'22 x 39 at real physical edge allowed',outputs,nativeSourceDraws:draws,smallRasterIdentical:true,screenshots:out},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
