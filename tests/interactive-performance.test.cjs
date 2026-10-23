const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process'),{chromium}=require('playwright'),{PNG}=require('pngjs');
const baseline=execFileSync('git',['show','a592230:public/builder.html'],{encoding:'utf8',maxBuffer:4e6});
const hook=`window.interactiveTest={get designs(){return designs},get sheets(){return sheets},get engine(){return typeof interactivePreview==='undefined'?null:interactivePreview},
 add:function(){var d=designs[0];d.widthIn=21.7;d.heightIn=38.6;d.qty=1;appendDesignToCurrentLayout(d);},
 stats:function(){var d=designs[0],p=sheets[0].placements[0];return {original:[d.originalCanvas.width,d.originalCanvas.height],active:[d.trimmed.w,d.trimmed.h],placed:[p.x,p.y,p.w,p.h],native:p.inst.canvas===d.trimmed.canvas};},
};window.perfLog={nativeDraws:0,detailDraws:0,decodeCalls:0,longTasks:[],frames:[]};
var originalLoad=loadImage;loadImage=function(){perfLog.decodeCalls++;return originalLoad.apply(this,arguments);};
if(typeof paintEditorRegion==='function'){var originalRegion=paintEditorRegion;paintEditorRegion=function(){perfLog.detailDraws++;return originalRegion.apply(this,arguments);};}
var originalDraw=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(source){if(designs.some(d=>d.trimmed.canvas===source))perfLog.nativeDraws++;return originalDraw.apply(this,arguments);};
new PerformanceObserver(list=>perfLog.longTasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});
`;
const out=fs.mkdtempSync(path.join(os.tmpdir(),'interactive-performance-'));
function percentile(a,p){return a.length?a.slice().sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))]:0;}
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const results=[];
  const repeats=Math.max(1,Number(process.env.PERF_REPEATS)||1),order=process.argv.includes('--baseline')?[true]:Array.from({length:repeats},(_,i)=>i%2?[false,true]:[true,false]).flat();
  for(const old of order){
   const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(180000);
   const html=(old?baseline:fs.readFileSync('public/builder.html','utf8')).replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
   await page.route('http://localhost:4251/**',r=>{const p=new URL(r.request().url()).pathname;return r.fulfill({body:p==='/builder.html'?html:/\.(css|js)$/.test(p)?fs.readFileSync('public'+p):'<style>body{margin:0}iframe{width:100%;height:980px;border:0}</style><iframe src="/builder.html"></iframe>',contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});});
   await page.goto('http://localhost:4251');const frame=page.frameLocator('iframe'),doc=page.frames().find(f=>f.url().endsWith('/builder.html'));await doc.waitForFunction(()=>window.interactiveTest);
   let file=process.env.PREVIEW_PNG_PATH;
   if(!file){const p=new PNG({width:6511,height:11581});for(let i=0;i<p.data.length;i+=4){p.data[i]=i%251;p.data[i+1]=120;p.data[i+2]=180;p.data[i+3]=128;}file={name:'6511x11581.png',mimeType:'image/png',buffer:PNG.sync.write(p)};}
   await doc.evaluate(()=>{perfLog.longTasks=[];window.uploadFrames=[];var previous=performance.now();function tick(now){uploadFrames.push(now-previous);previous=now;window.uploadRaf=requestAnimationFrame(tick);}window.uploadRaf=requestAnimationFrame(tick);});
   const start=Date.now();await frame.locator('#fileInput').setInputFiles(file);await doc.waitForFunction(()=>interactiveTest.designs.length===1);const uploadMs=Date.now()-start;
   const upload=await doc.evaluate(()=>{cancelAnimationFrame(uploadRaf);return {maxFrameGap:Math.max(0,...uploadFrames),maxLongTask:Math.max(0,...perfLog.longTasks),longTaskMs:perfLog.longTasks.reduce((n,v)=>n+v,0)};});
   const addMs=await doc.evaluate(()=>{const t=performance.now();interactiveTest.add();return performance.now()-t;});await frame.getByLabel('Sheet preview zoom').selectOption('1');await page.waitForTimeout(500);if(!old)await doc.waitForFunction(()=>!interactiveTest.engine.stats().running&&interactiveTest.engine.stats().queued===0);
   const before=await doc.evaluate(()=>interactiveTest.stats());
   const measured=await doc.evaluate(async()=>{
    perfLog.nativeDraws=perfLog.detailDraws=perfLog.decodeCalls=0;perfLog.longTasks=[];perfLog.frames=[];
    const c=document.querySelector('.sheet-canvas'),stage=c.parentElement,wrap=c.closest('.canvas-wrap'),preps=interactiveTest.engine?.stats().bitmapPreparations||0;let previous=performance.now(),start=previous;
    for(let n=0;n<48;n++){await new Promise(requestAnimationFrame);const now=performance.now();perfLog.frames.push(now-previous);previous=now;wrap.scrollTop=1000+n*12;wrap.scrollLeft=100+n*4;const r=wrap.getBoundingClientRect();for(let j=0;j<3;j++)stage.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+120+n*2+j,clientY:r.top+150,bubbles:true}));}
    return {elapsed:performance.now()-start,hotBitmapPreparations:(interactiveTest.engine?.stats().bitmapPreparations||0)-preps,...perfLog};
   });await page.waitForTimeout(700);
   const result={mode:old?'before':'after',uploadMs,upload,addMs,interactionMs:measured.elapsed,frameP95:percentile(measured.frames,.95),longTasks:measured.longTasks.length,longTaskMs:measured.longTasks.reduce((n,v)=>n+v,0),nativeDraws:measured.nativeDraws,detailDraws:measured.detailDraws,decodeCalls:measured.decodeCalls,hotBitmapPreparations:measured.hotBitmapPreparations,before,after:await doc.evaluate(()=>interactiveTest.stats())};
   assert.deepEqual(result.before,result.after,'interactions must not change placement/source');assert.equal(result.decodeCalls,0);
   if(!old){assert.equal(result.nativeDraws,0,'no synchronous native-source draw in pointer/scroll hot path');assert.equal(result.detailDraws,0);assert.equal(result.hotBitmapPreparations,0,'tile preparation waits for idle rather than resampling on pointer frames');result.cache=await doc.evaluate(()=>interactiveTest.engine.stats());}
   await page.screenshot({path:path.join(out,result.mode+'.png')});assert.deepEqual(errors,[]);results.push(result);console.log(JSON.stringify(result,null,2));await page.close();
  }
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log('Evidence: '+out);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
