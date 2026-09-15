const assert=require('node:assert/strict');
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
// Frozen committed implementation: compare actual pixels, not a rewritten
// version of the algorithm that could accidentally repeat a new bug.
const reference=execFileSync('git',['show','3ffdc5b:public/print-optimizer.js'],{encoding:'utf8'}).replace('window.PrintOptimizer=','window.ReferenceOptimizer=');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.setDefaultTimeout(120000);page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4195/**',r=>{
      const name=new URL(r.request().url()).pathname;
      if(name==='/reference.js')return r.fulfill({body:reference,contentType:'text/javascript'});
      if(/^\/print-optimizer\.(js|css)$/.test(name))return r.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('js')?'text/javascript':'text/css'});
      return r.fulfill({body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/print-optimizer.css"><script src="/reference.js"></script><script src="/print-optimizer.js"></script>',contentType:'text/html'});
    });
    await page.goto('http://localhost:4195');
    const parity=await page.evaluate(async()=>{
      window.equalPixels=(a,b)=>{
        if(a.width!==b.width||a.height!==b.height)return false;
        for(let y=0;y<a.height;y+=64){const h=Math.min(64,a.height-y),l=a.getContext('2d').getImageData(0,y,a.width,h).data,r=b.getContext('2d').getImageData(0,y,b.width,h).data;if(!l.every((v,i)=>v===r[i]))return false;}return true;
      };
      window.fixture=(size=2048)=>{
        const c=document.createElement('canvas');c.width=c.height=size;
        const ctx=c.getContext('2d',{willReadFrequently:true}),tile=ctx.createImageData(100,100);
        for(let y=0;y<100;y++)for(let x=0;x<100;x++){
          const d=Math.max(30-x,x-69,30-y,y-69,0);if(d<=6)tile.data.set(d?[0,0,0,[0,196,172,140,100,60,20][d]]:[30,100,210,255],(y*100+x)*4);
        }
        // Cross both stripe and inspection-tile boundaries.
        ctx.putImageData(tile,size/2-50,size/2-50);
        ctx.fillStyle='black';for(const [x,y] of [[2,2],[size-3,2],[2,size-3],[size-3,size-3]])ctx.fillRect(x,y,1,1);
        return c;
      };
      const results=[];
      // Arbitrary colored/soft-edge data exercises exact Float32 summation,
      // matte classification and stripe halos against the original code.
      const c=document.createElement('canvas');c.width=257;c.height=263;const ctx=c.getContext('2d',{willReadFrequently:true}),im=ctx.createImageData(c.width,c.height);
      let seed=7121;for(let i=0;i<im.data.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;im.data[i]=seed>>>24;}ctx.putImageData(im,0,0);
      for(const factor of [1.37,2]){
        const before=await ReferenceOptimizer.upscale(c,factor),after=await PrintOptimizer.upscale(c,factor);
        if(!equalPixels(before,after))throw Error('Row-streamed Lanczos changed pixels at '+factor);
        before.width=after.width=0;results.push('Exact Lanczos parity '+factor+'×');
      }
      const before=await ReferenceOptimizer.forceEnhance(c),after=await PrintOptimizer.forceEnhance(c);
      if(!equalPixels(before,after))throw Error('Striped Force refinement changed pixels');before.width=after.width=0;
      results.push('Exact forced-refinement parity across 128-row boundaries');
      window.memorySource=fixture();window.memorySourceSnapshot=memorySource.toDataURL();window.memoryExpected={};
      for(const strength of ['safe','balanced','strong']){
        const old=await ReferenceOptimizer.prepare(memorySource,null,strength),next=await PrintOptimizer.prepare(memorySource,null,strength);
        if(!equalPixels(old.canvas,next.canvas)||old.fringe.cleaned!==next.fringe.cleaned||old.removed!==next.removed)throw Error('Cleanup parity failed '+strength);
        memoryExpected[strength]={png:next.canvas.toDataURL(),fringe:next.fringe.cleaned,dots:next.removed};
        results.push(strength+': '+next.fringe.cleaned+' fringe + '+next.removed+' dots; all 2048×2048 RGBA pixels match');
        if(old.canvas!==memorySource)old.canvas.width=0;if(next.canvas!==memorySource)next.canvas.width=0;
      }
      window.floatAllocations=[];
      const NativeFloat32Array=window.Float32Array;
      window.Float32Array=new Proxy(NativeFloat32Array,{construct(target,args){floatAllocations.push(args[0]);return new target(...args);}});
      window.applied=null;
      window.openMemory=()=>PrintOptimizer.open({canvas:memorySource,widthIn:2048/300,heightIn:2048/300,nativeScale:1,budget(){throw Error('Whole-builder budget must not be called');},apply(c,f,removed,summary){window.applied={c,f,removed,summary};}});
      return results;
    });
    console.log(JSON.stringify({parity}));
    await page.evaluate(()=>openMemory());
    for(const strength of ['safe','balanced','strong']){
      await page.locator('[data-edge-strength]').selectOption(strength);
      await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
      const expected=await page.evaluate(s=>memoryExpected[s],strength);
      assert.match(await page.locator('.print-result').innerText(),new RegExp(expected.fringe+' outer fringe pixels cleaned'));
      assert(await page.locator('.print-image').evaluateAll(cs=>cs.every(c=>c.width<=1024&&c.height<=1024)),'2048 comparison uses bounded display rasters');
      assert.equal(await page.evaluate(()=>floatAllocations.length),0,'Auto never allocates 2× Float32 resampling rows');
    }
    for(const zoom of [1,2,4]){
      await page.locator(`[data-inspect="${zoom}"]`).click();
      await page.locator('.print-before .print-viewport').evaluate((p,z)=>{p.scrollLeft=970*z;p.scrollTop=970*z;},zoom);
      await page.waitForTimeout(50);
      assert(await page.locator('.print-image').evaluateAll(cs=>cs.every(c=>c.width<=1024&&c.height<=1024)));
      assert(await page.evaluate(()=>{const a=document.querySelector('.print-before .print-viewport'),b=document.querySelector('.print-after .print-viewport');return a.scrollLeft===b.scrollLeft&&a.scrollTop===b.scrollTop;}));
    }
    await page.locator('[data-apply]').click();
    assert(await page.evaluate(()=>applied.c.width===2048&&applied.c.toDataURL()===memoryExpected.strong.png&&applied.removed===4&&memorySource.toDataURL()===memorySourceSnapshot),'Complete exact Strong candidate applied; original untouched');
    await page.evaluate(()=>{applied.c.width=0;applied=null;});
    // Force is an explicit 2× allocation, with no full horizontal Float32 plane.
    await page.evaluate(()=>openMemory());await page.locator('[data-enhancement]').selectOption('force');
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.match(await page.locator('.print-result').innerText(),/Forced smooth enhancement applied/);
    assert(await page.evaluate(()=>floatAllocations.length>0&&Math.max(...floatAllocations)<=4096*4),'resampler allocations are single rows');
    await page.locator('[data-apply]').click();
    assert(await page.evaluate(()=>applied.c.width===4096&&applied.c.height===4096&&applied.f===2&&memorySource.toDataURL()===memorySourceSnapshot));
    await page.evaluate(()=>{applied.c.width=0;applied=null;});
    // Oversized cleanup fails before any source pixel read or processing.
    await page.evaluate(()=>{
      const big=document.createElement('canvas');big.width=big.height=4096;window.bigSource=big;window.bigReads=0;
      big.getContext=()=>{bigReads++;throw Error('Unexpected read before preflight');};
      PrintOptimizer.open({canvas:big,widthIn:4096/300,heightIn:4096/300,apply(){throw Error('Invalid apply');}});
    });
    await page.locator('[data-retry]').waitFor({state:'visible'});
    assert(await page.locator('[data-apply]').isDisabled());assert.equal(await page.evaluate(()=>bigReads),0);
    assert.match(await page.locator('.print-result').innerText(),/Balanced edge cleanup cannot process 4096 × 4096 px: estimated peak 312 MiB/);
    assert.doesNotMatch(await page.locator('.print-result').innerText(),/pixels cleaned/);
    await page.locator('[data-cancel]').click();await page.evaluate(()=>{bigSource.width=0;});
    // Safe's real 232 MiB working peak fits: exercise actual 4096 pixels.
    await page.evaluate(()=>{
      window.safe4096=fixture(4096);window.safe4096Applied=null;
      PrintOptimizer.open({canvas:safe4096,widthIn:4096/300,heightIn:4096/300,apply(c,f,dots){safe4096Applied={c,f,dots};}});
    });
    await page.locator('[data-retry]').waitFor({state:'visible'});
    await page.locator('[data-edge-strength]').selectOption('safe');
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.equal(Number(await page.locator('.print-optimizer').getAttribute('data-estimated-peak-bytes')),232*1048576);
    await page.locator('[data-apply]').click();
    assert(await page.evaluate(()=>safe4096Applied.c.width===4096&&safe4096Applied.c.height===4096&&safe4096Applied.dots===4&&safe4096Applied.c.getContext('2d').getImageData(2,2,1,1).data[3]===0&&safe4096.getContext('2d').getImageData(2,2,1,1).data[3]===255));
    await page.evaluate(()=>{safe4096Applied.c.width=0;safe4096.width=0;});
    // Simulate a real failure after successful cleanup, during Force readback.
    await page.evaluate(()=>{
      window.savedRead=CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData=function(...args){if(this.canvas.width===4096)throw Error('Simulated optional enhancement readback failure');return savedRead.apply(this,args);};
    });
    await page.evaluate(()=>openMemory());await page.locator('[data-edge-strength]').selectOption('strong');
    await page.locator('[data-enhancement]').selectOption('force');
    await page.locator('[data-retry]').waitFor({state:'visible'});
    assert(await page.locator('[data-apply]').isDisabled());
    assert.equal(await page.locator('[data-edge-strength]').inputValue(),'strong');
    assert.equal(await page.locator('[data-enhancement]').inputValue(),'force','failed Force never silently falls back to Auto');
    assert.doesNotMatch(await page.locator('.print-result').innerText(),/pixels cleaned|Forced smooth enhancement applied/);
    assert(await page.locator('.print-image').evaluateAll(cs=>cs.every(c=>c.width===0)),'failed candidate cleared');
    await page.evaluate(()=>{CanvasRenderingContext2D.prototype.getImageData=savedRead;});
    await page.locator('[data-enhancement]').selectOption('auto');
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.match(await page.locator('.print-result').innerText(),/Strong edge cleanup: 1104/);
    await page.locator('[data-cancel]').click();assert(await page.evaluate(()=>applied===null&&memorySource.toDataURL()===memorySourceSnapshot));
    assert.deepEqual(errors,[]);
    console.log('2048 all modes + explicit 4096 Force output; 4096 Safe completes, Balanced rejects before processing; bounded comparison and resampler rows; exact selected Apply; failure/Cancel integrity passed.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
