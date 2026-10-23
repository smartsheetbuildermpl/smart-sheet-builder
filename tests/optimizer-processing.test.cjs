const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'optimizer-processing-'));
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.setDefaultTimeout(240000);page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4198/**',r=>{
      const name=new URL(r.request().url()).pathname;
      if(/^\/print-optimizer(?:-worker)?\.(js|css)$/.test(name))return r.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('js')?'text/javascript':'text/css'});
      return r.fulfill({body:'<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/print-optimizer.css"><script src="/print-optimizer.js"></script>',contentType:'text/html'});
    });
    await page.goto('http://localhost:4198');
    await page.evaluate(()=>{
      window.workerRuns=0;window.workerStops=0;window.liveWorkers=0;window.peakWorkers=0;const NativeWorker=Worker;
      window.Worker=class extends NativeWorker{constructor(...args){super(...args);liveWorkers++;peakWorkers=Math.max(peakWorkers,liveWorkers);}postMessage(m,...args){if(m.type==='run')workerRuns++;return super.postMessage(m,...args);}terminate(){workerStops++;liveWorkers--;return super.terminate();}};
      window.makeFixture=(w,h)=>{
        const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true}),tile=ctx.createImageData(100,100);
        for(let y=0;y<100;y++)for(let x=0;x<100;x++){const d=Math.max(30-x,x-69,30-y,y-69,0);if(d<=6)tile.data.set(d?[0,0,0,[0,196,172,140,100,60,20][d]]:[30,100,210,255],(y*100+x)*4);}
        ctx.putImageData(tile,Math.floor(w/2)-50,Math.floor(h/2)-50);ctx.fillStyle='black';ctx.fillRect(2,2,1,1);return c;
      };
      window.source=makeFixture(257,263);window.snapshot=source.toDataURL();window.applied=null;window.undos=0;
      window.openOptimizer=()=>{PrintOptimizer.open({canvas:source,widthIn:source.width/300,heightIn:source.height/300,nativeScale:1,canUndo:true,undo(){undos++;},apply(c,f,n,text){applied={c,f,n,text};}});};
    });
    const ready=()=>page.waitForFunction(()=>document.querySelector('[data-apply]')&&!document.querySelector('[data-apply]').disabled);
    const choose=async(strength,mode='auto')=>{await page.locator('[data-edge-strength]').selectOption(strength);if(await page.locator('[data-enhancement]').inputValue()!==mode)await page.locator('[data-enhancement]').selectOption(mode);await ready();};
    await page.evaluate(()=>openOptimizer());await ready();
    const parity=[];
    for(const strength of ['safe','balanced','strong']){
      await choose(strength);
      const result=await page.evaluate(async s=>{
        const expected=await PrintOptimizer.prepare(source,null,s),actual=document.querySelector('.print-after .print-image');
        const equal=actual.toDataURL()===expected.canvas.toDataURL();if(expected.canvas!==source)expected.canvas.width=0;
        return {s,equal,backend:document.querySelector('.print-optimizer').dataset.processingBackend};
      },strength);assert(result.equal,`${strength} worker/cached native pixels exactly equal unchanged cleanup`);assert.equal(result.backend,'worker');parity.push(result);
    }
    const runs=await page.evaluate(()=>workerRuns);await choose('balanced');assert.equal(await page.locator('.print-optimizer').getAttribute('data-cache-hit'),'true');assert.equal(await page.evaluate(()=>workerRuns),runs);
    await choose('strong','force');
    const forceRuns=await page.evaluate(()=>workerRuns);await choose('strong','auto');await choose('strong','force');assert.equal(await page.evaluate(()=>workerRuns),forceRuns,'cached Force performs no cleanup/enhancement recomputation');assert.equal(await page.locator('.print-optimizer').getAttribute('data-cache-hit'),'true');
    await page.locator('[data-apply]').click();
    const forceParity=await page.evaluate(async()=>{const clean=await PrintOptimizer.prepare(source,null,'strong'),expected=await PrintOptimizer.forceEnhance(clean.canvas),actual=applied.c;const a=expected.getContext('2d').getImageData(0,0,514,526).data,b=actual.getContext('2d').getImageData(0,0,514,526).data;let diffs=0,max=0,first=[];for(let i=0;i<a.length;i++)if(a[i]!==b[i]){diffs++;max=Math.max(max,Math.abs(a[i]-b[i]));if(first.length<12)first.push([i,a[i],b[i]]);}expected.width=0;if(clean.canvas!==source)clean.canvas.width=0;return {diffs,max,first};});
    assert.equal(forceParity.diffs,0,'Force worker output exactly equals existing enhancement pixels '+JSON.stringify(forceParity));
    assert(await page.evaluate(()=>applied.c.width===514&&applied.c.height===526&&applied.f===2&&source.toDataURL()===snapshot));
    await page.evaluate(()=>{applied.c.width=0;applied=null;openOptimizer();});await ready();await page.locator('[data-undo]').click();assert.equal(await page.evaluate(()=>undos),1);
    // Exact required dimensions, encoded/decoded as a real transparent PNG.
    const actual=process.env.OPTIMIZER_PNG_PATH?fs.readFileSync(process.env.OPTIMIZER_PNG_PATH).toString('base64'):null;
    await page.evaluate(async actual=>{
      source.width=0;let encoded=actual?null:makeFixture(6511,11581);const blob=actual?await (await fetch('data:image/png;base64,'+actual)).blob():await new Promise(r=>encoded.toBlob(r,'image/png'));const bitmap=await createImageBitmap(blob);if(encoded)encoded.width=0;
      source=document.createElement('canvas');source.width=bitmap.width;source.height=bitmap.height;source.getContext('2d',{willReadFrequently:true}).drawImage(bitmap,0,0);bitmap.close();
      if(actual){const b=PrintOptimizer.analyze(source,22,39).bounds,c=document.createElement('canvas');c.width=b.w+2;c.height=b.h+2;c.getContext('2d',{willReadFrequently:true}).drawImage(source,b.x-1,b.y-1,b.w+2,b.h+2,0,0,c.width,c.height);source.width=0;source=c;}
      window.largeDimensions=[source.width,source.height];
      window.largeSamples=()=>[source.getContext('2d').getImageData(2,2,1,1).data.join(','),source.getContext('2d').getImageData(3200,5700,100,100).data.reduce((n,v)=>n+v,0)];window.initialSamples=largeSamples();
      window.ticks=0;window.maxGap=0;window.lastTick=performance.now();window.heartbeat=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-lastTick);lastTick=now;ticks++;},16);
      window.progressSeen=[];window.observer=new MutationObserver(()=>{const p=document.querySelector('[role="progressbar"]');if(p)progressSeen.push(p.getAttribute('aria-valuetext'));});observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-valuetext']});openOptimizer();
    },actual);
    await page.locator('[data-progress]:not([hidden])').waitFor();assert(await page.locator('[data-apply]').isDisabled());assert(await page.locator('[data-cancel]').isEnabled());
    await page.screenshot({path:path.join(artifacts,'large-processing.png')});
    await page.setViewportSize({width:375,height:640});assert(await page.locator('[data-cancel]').evaluate(b=>{const r=b.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'Cancel remains visible on a short mobile viewport');await page.screenshot({path:path.join(artifacts,'large-processing-mobile.png')});await page.setViewportSize({width:1440,height:1000});
    // Rapid changes while the first native job is genuinely still processing.
    await page.evaluate(()=>{for(const value of ['safe','strong','balanced']){const select=document.querySelector('[data-edge-strength]');select.value=value;select.dispatchEvent(new Event('change'));}});await ready();
    const timings={balanced:Number(await page.locator('.print-optimizer').getAttribute('data-processing-ms'))};
    for(const strength of ['safe','strong']){await choose(strength);timings[strength]=Number(await page.locator('.print-optimizer').getAttribute('data-processing-ms'));}
    const beforeHit=await page.evaluate(()=>workerRuns),hitStart=Date.now();await choose('balanced');timings.cachedBalancedMs=Date.now()-hitStart;
    assert.equal(await page.evaluate(()=>workerRuns),beforeHit);assert.equal(await page.locator('.print-optimizer').getAttribute('data-cache-hit'),'true');
    assert.match(await page.locator('.print-result').innerText(),/Cleanup changed [\d,]+ source pixels/);
    await page.screenshot({path:path.join(artifacts,'large-ready.png')});
    // No reduction/fallback when the existing 2× memory guard rejects a job.
    const forceStart=Date.now();await page.locator('[data-enhancement]').selectOption('force');await page.locator('[data-retry]').waitFor({state:'visible'});
    timings.largeForceRejectedMs=Date.now()-forceStart;assert(await page.locator('[data-apply]').isDisabled());assert.match(await page.locator('.print-result').innerText(),/Force smooth enhance cannot process 6511 × 115(?:81|68) px/);
    await page.locator('[data-enhancement]').selectOption('auto');await ready();
    // Rapid settings changes have one authoritative selected candidate.
    await page.evaluate(()=>{for(const value of ['strong','safe','balanced','strong']){const select=document.querySelector('[data-edge-strength]');select.value=value;select.dispatchEvent(new Event('change'));}});await ready();
    assert.match(await page.locator('.print-result').innerText(),/Strong edge cleanup/);
    await page.locator('[data-apply]').click();assert(await page.evaluate(actual=>applied.c.width===largeDimensions[0]&&applied.c.height===largeDimensions[1]&&largeSamples().every((v,i)=>v===initialSamples[i])&&(actual||source.getContext('2d').getImageData(2,2,1,1).data[3]===255&&applied.c.getContext('2d').getImageData(2,2,1,1).data[3]===0),!!actual));
    await page.evaluate(()=>{applied.c.width=0;applied=null;openOptimizer();});await page.locator('[data-progress]:not([hidden])').waitFor();
    await page.waitForFunction(()=>/Checking|Finding|Measuring|Classifying/.test(document.querySelector('.print-result').textContent));
    const cancelStart=Date.now();await page.locator('[data-cancel]').click();await page.locator('.print-optimizer').waitFor({state:'detached'});timings.cancelMs=Date.now()-cancelStart;
    assert(await page.evaluate(()=>applied===null&&largeSamples().every((v,i)=>v===initialSamples[i])));
    const responsiveness=await page.evaluate(()=>{clearInterval(heartbeat);observer.disconnect();return {ticks,maxGapMs:Math.round(maxGap),measuredSteps:progressSeen.filter(s=>s&&/% of this step/.test(s)).length,indeterminateSteps:progressSeen.filter(s=>s&&!/% of this step/.test(s)).length,workerRuns,workerStops,peakWorkers,liveWorkers};});
    assert.equal(responsiveness.peakWorkers,1);assert.equal(responsiveness.liveWorkers,0);
    assert(responsiveness.ticks>100);assert(responsiveness.measuredSteps>0&&responsiveness.indeterminateSteps>0);assert.deepEqual(errors,[]);
    // Fallback remains cancellable and uses the same pixel operations.
    await page.evaluate(()=>{window.Worker=undefined;source.width=0;source=makeFixture(257,263);openOptimizer();});await ready();assert.equal(await page.locator('.print-optimizer').getAttribute('data-processing-backend'),'yielding fallback');await page.locator('[data-cancel]').click();
    console.log(JSON.stringify({fixture:await page.evaluate(()=>largeDimensions),actualFile:process.env.OPTIMIZER_PNG_PATH||null,parity,timings,responsiveness,artifacts},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
