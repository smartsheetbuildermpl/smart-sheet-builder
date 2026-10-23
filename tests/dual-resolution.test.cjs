const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

const hook = `
window.dual={get designs(){return designs},get sheets(){return sheets},previewSource,preparePreview:interactivePreview.prepare,updateDesignCanvas,refreshLayoutAfterImageEdit,
  drawSheetCanvas,downloadPng,downloadTiff,getExportProfile,history:layoutHistory,
  signature:function(){return JSON.stringify(sheets.map(s=>s.placements.map(p=>[p.x,p.y,p.w,p.h,p.inst.rotation])))},
  seed:function(count){
    var d=designs[0];dpiGlobal=300;d.widthIn=5;d.heightIn=5;
    instances=Array.from({length:count},(_,n)=>({id:n+1,designId:d.id,canvas:d.trimmed.canvas,baseW:count===1?1500:180,baseH:count===1?1500:180,rotation:0,vibrance:0}));
    sheets=[{widthPx:count===1?1800:6900,heightPx:count===1?2100:11700,gapPx:0,headerHeightPx:0,placements:instances.map((inst,n)=>({inst,x:90+n%10*200,y:90+Math.floor(n/10)*200,w:inst.baseW,h:inst.baseH}))}];
    selectedInstanceIds=new Set([instances[count-1].id]);renderAllSheets();
  },
  inspect:function(){var d=designs[0],proxy=previewSource(d.trimmed.canvas);return {original:[d.originalCanvas.width,d.originalCanvas.height],active:[d.trimmed.w,d.trimmed.h],proxy:[proxy.width,proxy.height],cached:proxy===previewSource(d.trimmed.canvas)};}
};
exportDelivery=SmartSheetExportDelivery.create({gate:async()=>({allowed:true,authorization:'dual-resolution-fixture'}),save:saveExportBlob});
const originalPreview=drawSheetPreview,originalExport=drawSheetCanvas,originalOverlay=renderOverlayFor;
window.screenDraws=0;window.nativeDraws=0;window.overlays=0;
drawSheetPreview=function(){screenDraws++;return originalPreview.apply(this,arguments)};
drawSheetCanvas=function(){nativeDraws++;return originalExport.apply(this,arguments)};
renderOverlayFor=function(){overlays++;return originalOverlay.apply(this,arguments)};
`;
const html = fs.readFileSync('public/builder.html','utf8').replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
function tags(bytes) {
  const result={}; let offset=bytes.readUInt32LE(4), count=bytes.readUInt16LE(offset);
  for(let n=0;n<count;n++) {
    const at=offset+2+n*12,tag=bytes.readUInt16LE(at),type=bytes.readUInt16LE(at+2),size=bytes.readUInt32LE(at+4);
    if(size!==1)continue;
    if(type===3)result[tag]=bytes.readUInt16LE(at+8);
    if(type===4)result[tag]=bytes.readUInt32LE(at+8);
    if(type===5){const value=bytes.readUInt32LE(at+8);result[tag]=bytes.readUInt32LE(value)/bytes.readUInt32LE(value+4);}
  } return result;
}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
    page.setDefaultTimeout(120000);page.on('pageerror',e=>errors.push(e.message));
    await require('./preflight-review-helper.cjs')(page);
    await page.route('http://localhost:4206/**',r=>{
      const p=new URL(r.request().url()).pathname;
      if(/^\/(sheet-workspace|background-editor|print-optimizer|export-delivery|sheet-packing|builder-shell|workspace-theme)\.(js|css)$/.test(p))return r.fulfill({body:fs.readFileSync('public'+p),contentType:p.endsWith('.js')?'text/javascript':'text/css'});
      return r.fulfill({body:p==='/builder.html'?html:'<iframe src="/builder.html" style="width:100%;height:950px;border:0"></iframe>',contentType:'text/html'});
    });
    await page.goto('http://localhost:4206');const doc=page.frames().find(f=>f.url().endsWith('/builder.html')),frame=page.frameLocator('iframe');
    await doc.waitForFunction(()=>window.dual);
    const fixture=new PNG({width:4500,height:4500});
    // Semi-transparent field and one-pixel details; visible corners avoid crop.
    for(let y=0;y<4500;y++)for(let x=0;x<4500;x++){
      const i=(y*4500+x)*4;fixture.data[i]=x%256;fixture.data[i+1]=y%256;fixture.data[i+2]=160;
      fixture.data[i+3]=(x+y)%7===0?0:(x%11===0?1:128);
    }
    fixture.data[3]=fixture.data[fixture.data.length-1]=255;
    const buffer=PNG.sync.write(fixture);
    await frame.locator('#fileInput').setInputFiles({name:'large-transparent.png',mimeType:'image/png',buffer});
    await doc.waitForFunction(()=>dual.designs.length===1);
    const sizes=await doc.evaluate(()=>dual.inspect());
    assert.deepEqual(sizes,{original:[4500,4500],active:[4500,4500],proxy:[1600,1600],cached:true});
    assert.equal(await doc.evaluate(async()=>{const b=await dual.designs[0].file.arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('')}),crypto.createHash('sha256').update(buffer).digest('hex'));
    await doc.evaluate(()=>dual.seed(1));
    const expected=await doc.evaluate(async()=>{
      const s=dual.sheets[0],c=document.createElement('canvas');dual.drawSheetCanvas(c,s);
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',pixels)),b=>b.toString(16).padStart(2,'0')).join('');c.width=c.height=0;
      const proxy=dual.previewSource(dual.designs[0].trimmed.canvas);proxy.getContext('2d').clearRect(0,0,proxy.width,proxy.height);
      let rejected=false;try{dual.drawSheetCanvas(document.createElement('canvas'),{...s,placements:s.placements.map(p=>({...p,inst:{...p.inst,canvas:proxy}}))});}catch(e){rejected=/previews cannot/.test(e.message);}
      window.usedSources=[];const draw=CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage=function(source,...args){usedSources.push([source.width,source.height]);return draw.call(this,source,...args)};
      return {hash,rejected};
    });
    assert(expected.rejected,'export renderer rejects a proxy even if assigned as an instance source');
    const pngEvent=page.waitForEvent('download');await doc.evaluate(()=>dual.downloadPng(dual.sheets[0],0));
    const bytes=fs.readFileSync(await(await pngEvent).path()),png=PNG.sync.read(bytes);
    assert.deepEqual([png.width,png.height],[1800,2100]);
    const actual=await doc.evaluate(async b64=>{
      const img=await createImageBitmap(await(await fetch('data:image/png;base64,'+b64)).blob()),c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',c.getContext('2d').getImageData(0,0,c.width,c.height).data)),b=>b.toString(16).padStart(2,'0')).join('');
    },bytes.toString('base64'));
    assert.equal(actual,expected.hash,'export pixels/alpha equal native reference despite erased proxy');
    const outputs={png:[png.width,png.height]};
    for(const color of ['rgb','cmyk']){
      const event=page.waitForEvent('download');await doc.evaluate(color=>dual.downloadTiff(dual.sheets[0],0,dual.getExportProfile(color)),color);
      const t=tags(fs.readFileSync(await(await event).path()));
      assert.deepEqual([t[256],t[257],t[282],t[283]],[1800,2100,300,300]);outputs[color]=[t[256],t[257]];
    }
    assert((await doc.evaluate(()=>usedSources.filter(s=>s[0]===4500&&s[1]===4500).length))>=3,'each format reads native source');
    assert.equal(await doc.evaluate(()=>usedSources.some(s=>s[0]===1600)),false,'no export sampled the proxy');
    // Active-source replacement regenerates its proxy; restoring original reuses its identity.
    assert(await doc.evaluate(async()=>{
      const d=dual.designs[0],old=d.trimmed.canvas,c=document.createElement('canvas');c.width=3200;c.height=2400;
      dual.updateDesignCanvas(d,{canvas:c,w:3200,h:2400});dual.refreshLayoutAfterImageEdit(d);
      await dual.preparePreview(c,1600);
      const valid=dual.inspect().proxy.join() === '1600,1200' && dual.sheets[0].placements[0].inst.canvas===c;
      dual.updateDesignCanvas(d,{canvas:d.originalCanvas,w:4500,h:4500});dual.refreshLayoutAfterImageEdit(d);
      return valid&&d.trimmed.canvas===old&&dual.inspect().active.join()==='4500,4500';
    }));
    await doc.evaluate(()=>dual.seed(200));
    const handle=frame.locator('.drag-handle[data-instance-id="200"]');await handle.scrollIntoViewIfNeeded();
    const corner=frame.locator('.drag-handle[data-instance-id="200"] .resize-handle.se'),box=await corner.boundingBox();
    const before=await doc.evaluate(()=>dual.signature());
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    assert.equal(await frame.locator('.layout-drag-preview').count(),1,'resize preview starts on pointer down');
    await doc.evaluate(()=>{screenDraws=nativeDraws=overlays=0;window.frames=[];window.previous=performance.now();window.tick=()=>{const now=performance.now();frames.push(now-previous);previous=now;window.frame=requestAnimationFrame(tick)};frame=requestAnimationFrame(tick)});
    await page.mouse.move(box.x-8,box.y-8,{steps:60});
    const perf=await doc.evaluate(()=>{cancelAnimationFrame(frame);return {screenDraws,nativeDraws,overlays,signature:dual.signature(),frames}});
    assert.equal(perf.signature,before,'resize commits only at release');assert.deepEqual([perf.screenDraws,perf.nativeDraws,perf.overlays],[0,0,0]);
    await page.mouse.up();const after=await doc.evaluate(()=>dual.signature());assert(after!==before,await frame.locator('#layoutHistoryStatus').textContent() || 'resize must commit a new size');
    await frame.getByRole('button',{name:'Undo layout',exact:true}).click();assert.equal(await doc.evaluate(()=>dual.signature()),before);
    await frame.getByRole('button',{name:'Redo layout',exact:true}).click();assert.equal(await doc.evaluate(()=>dual.signature()),after);
    assert.deepEqual(errors,[]);
    const sorted=perf.frames.sort((a,b)=>a-b);
    console.log(JSON.stringify({sizes,outputs,sheetInches:[6,7],designInches:5,dpi:300,rgbaIdentical:true,proxyRejected:true,resize:{pieces:200,sheetDraws:0,overlayRebuilds:0,p95FrameMs:sorted[Math.floor(sorted.length*.95)]}},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
