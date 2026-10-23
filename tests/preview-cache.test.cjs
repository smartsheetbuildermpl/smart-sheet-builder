const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('playwright'),{PNG}=require('pngjs');
const hook=`window.cacheTest={engine:interactivePreview,get designs(){return designs},get sheets(){return sheets},
  describe:function(x,y,size){var d=designs[0],inst={canvas:d.trimmed.canvas,baseW:d.trimmed.w,baseH:d.trimmed.h,rotation:0,vibrance:0};return interactivePreview.describe({placements:[{inst:inst,x:0,y:0,w:inst.baseW,h:inst.baseH}]},{x:x,y:y,w:size,h:size},256,256,null);},
  seed:function(){var c=document.createElement('canvas');c.width=6511;c.height=11581;var ctx=c.getContext('2d');ctx.fillStyle='#138e9c';ctx.fillRect(0,0,c.width,c.height);ctx.clearRect(600,600,40,40);designs=[{id:1,trimmed:{canvas:c,w:c.width,h:c.height}}];},
  size:function(){designs.forEach(d=>{d.widthIn=4;d.heightIn=3;d.qty=1;});renderAllDesigns();},
  signature:function(){return JSON.stringify(sheets.map(s=>s.placements.map(p=>[p.inst.id,p.x,p.y,p.w,p.h,p.inst.rotation])));}
};`;
const html=fs.readFileSync('public/builder.html','utf8').replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});try{
 async function setup(fallback=false){const p=await browser.newPage({viewport:{width:1440,height:1000}});p.setDefaultTimeout(60000);if(fallback)await p.addInitScript(()=>{window.Worker=undefined;window.OffscreenCanvas=undefined;});const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.route('http://localhost:4252/**',r=>{const u=new URL(r.request().url()).pathname;return r.fulfill({body:u==='/builder.html'?html:/\.(js|css)$/.test(u)?fs.readFileSync('public'+u):'<style>body{margin:0}iframe{width:100%;height:980px;border:0}</style><iframe src="/builder.html"></iframe>',contentType:u.endsWith('.js')?'text/javascript':u.endsWith('.css')?'text/css':'text/html'});});await p.goto('http://localhost:4252');const d=p.frames().find(f=>f.url().endsWith('/builder.html'));await d.waitForFunction(()=>window.cacheTest);return {p,d,f:p.frameLocator('iframe'),errors};}
 let t=await setup();
 const cache=await t.d.evaluate(async()=>{
  cacheTest.seed();var engine=cacheTest.engine,signal=new AbortController().signal,request=cacheTest.describe(200,200,512);
  await engine.render('cache-test',request,signal);var first=engine.stats();await engine.render('cache-test',request,signal);var second=engine.stats();
  if(second.bitmapPreparations!==first.bitmapPreparations||second.cacheHits<=first.cacheHits)throw Error('Warm viewport did not reuse cached pixels');
  // Deliberately overlap native bitmap preparation, then replace queued work.
  var bitmap=window.createImageBitmap;window.createImageBitmap=async function(){await new Promise(r=>setTimeout(r,15));return bitmap.apply(window,arguments);};
  var cancel=new AbortController(),a=engine.render('latest',cacheTest.describe(5000,9000,512),cancel.signal);
  var b=engine.render('latest',cacheTest.describe(4000,9000,512),signal),c=engine.render('latest',cacheTest.describe(3000,9000,512),signal);cancel.abort();
  var results=await Promise.all([a,b,c]);window.createImageBitmap=bitmap;
  if(results[0]!==null||results[1]!==null||!results[2])throw Error('Stale preview work was not cancelled');
  // Visit enough disjoint native regions to exercise both LRU budgets.
  for(var n=0;n<110;n++)await engine.render('cache-test',cacheTest.describe((n%10)*570,Math.floor(n/10)*1000,512),signal);
  for(var n=0;n<3;n++){var source=document.createElement('canvas');source.width=source.height=3072;source.getContext('2d').fillRect(0,0,3072,3072);await engine.prepare(source,3072);}
  var original=window.createImageBitmap,active=0,peak=0;window.createImageBitmap=async function(){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));try{return await original.apply(window,arguments);}finally{active--;}};
  await Promise.all(Array.from({length:8},()=>{var source=document.createElement('canvas');source.width=source.height=800;source.getContext('2d').fillRect(0,0,800,800);return engine.prepare(source,1600);}));window.createImageBitmap=original;
  return {first:first,second:second,peakProxyPreparations:peak,after:engine.stats()};
 });
 assert.equal(cache.peakProxyPreparations,2);assert(cache.after.cancelled>=2);assert(cache.after.tileEvictions>0&&cache.after.frameEvictions>0&&cache.after.proxyEvictions>0);assert(cache.after.tileBytes<=64*1024*1024);assert(cache.after.frameBytes<=24*1024*1024);assert(cache.after.proxyBytes<=48*1024*1024);assert.equal(cache.after.queued,0);assert.equal(cache.after.proxyQueued,0);assert.deepEqual(t.errors,[]);await t.p.close();
 // The safe fallback remains usable when Worker/OffscreenCanvas are absent.
 t=await setup(true);const fallback=await t.d.evaluate(async()=>{cacheTest.seed();var e=cacheTest.engine,bitmap=await e.render('fallback',cacheTest.describe(200,200,512),new AbortController().signal),c=document.createElement('canvas');c.width=c.height=256;c.getContext('2d').drawImage(bitmap,0,0);return {stats:e.stats(),pixel:Array.from(c.getContext('2d').getImageData(10,10,1,1).data)};});assert.equal(fallback.stats.worker,false);assert.deepEqual(fallback.pixel,[19,142,156,255]);assert.deepEqual(t.errors,[]);await t.p.close();
 // Real multiple-upload, Add, modes, manual drag, rotation and history controls.
 t=await setup();const image=new PNG({width:600,height:400});for(let i=0;i<image.data.length;i+=4){image.data[i]=19;image.data[i+1]=142;image.data[i+2]=156;image.data[i+3]=i%28?128:0;}image.data[3]=image.data[image.data.length-1]=255;
 const png=PNG.sync.write(image);await t.f.locator('#fileInput').setInputFiles(['a','b','c'].map(n=>({name:n+'.png',mimeType:'image/png',buffer:png})));await t.d.waitForFunction(()=>cacheTest.designs.length===3&&document.querySelectorAll('.design-item').length===3);await t.d.evaluate(()=>cacheTest.size());
 for(let n=0;n<3;n++){await t.f.locator('.design-item').nth(n).getByRole('button',{name:'Add to layout',exact:true}).click();await t.d.waitForFunction(count=>cacheTest.sheets.reduce((n,s)=>n+s.placements.length,0)===count,n+1);}
 assert.equal(await t.d.evaluate(()=>cacheTest.sheets.length),1);assert.equal(await t.d.evaluate(()=>cacheTest.sheets[0].placements.length),3);
 for(const mode of ['standard','max-fill']){const before=await t.d.evaluate(()=>cacheTest.signature());await t.f.getByLabel('Arrange mode',{exact:true}).selectOption(mode);await t.f.locator('#packBtn').click();await t.d.waitForFunction(()=>!document.getElementById('packBtn').disabled);if(await t.d.evaluate(()=>cacheTest.signature())!==before){const after=await t.d.evaluate(()=>cacheTest.signature());await t.f.getByRole('button',{name:'Undo layout',exact:true}).click();assert.equal(await t.d.evaluate(()=>cacheTest.signature()),before);await t.f.getByRole('button',{name:'Redo layout',exact:true}).click();assert.equal(await t.d.evaluate(()=>cacheTest.signature()),after);}}
 const handle=t.f.locator('.drag-handle').first();await handle.scrollIntoViewIfNeeded();const box=await handle.boundingBox();await t.p.mouse.move(box.x+box.width/2,box.y+box.height/2);await t.p.mouse.down();await t.p.mouse.move(box.x+box.width/2+12,box.y+box.height/2+22,{steps:20});await t.p.mouse.up();
 const rotatedBefore=await t.d.evaluate(()=>cacheTest.signature());await t.f.locator('.rotate-btn').first().click();const rotatedAfter=await t.d.evaluate(()=>cacheTest.signature());assert.notEqual(rotatedAfter,rotatedBefore);await t.f.getByRole('button',{name:'Undo layout',exact:true}).click();assert.equal(await t.d.evaluate(()=>cacheTest.signature()),rotatedBefore);await t.f.getByRole('button',{name:'Redo layout',exact:true}).click();assert.equal(await t.d.evaluate(()=>cacheTest.signature()),rotatedAfter);
 assert.deepEqual(t.errors,[]);await t.p.close();console.log(JSON.stringify({cache,fallback,multipleDesigns:'3 uploads / 1 sheet, Add / Standard / Max Fill / drag / rotate / Undo / Redo passed'},null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
