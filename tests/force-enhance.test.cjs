const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'force-enhance-'));
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4194/**',r=>{
      const name=new URL(r.request().url()).pathname;
      if(/^\/print-optimizer\.(js|css)$/.test(name))return r.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('js')?'text/javascript':'text/css'});
      return r.fulfill({body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/print-optimizer.css"><script src="/print-optimizer.js"></script>',contentType:'text/html'});
    });
    await page.goto('http://localhost:4194');
    const pixelChecks=await page.evaluate(async()=>{
      const make=()=>{const c=document.createElement('canvas');c.width=100;c.height=100;c.getContext('2d',{willReadFrequently:true});return c;};
      const source=make(),ctx=source.getContext('2d'),data=ctx.createImageData(100,100);
      // Stepped colored diagonal with soft alpha, poisoned hidden black/white RGB.
      for(let y=0;y<100;y++)for(let x=0;x<100;x++){
        const a=x>=20&&y>=20&&x+y<145?(x+y>140?80:255):0;
        data.data.set(a?[220,50,90,a]:[x%2?255:0,x%2?255:0,x%2?255:0,0],(y*100+x)*4);
      }
      ctx.putImageData(data,0,0);const original=source.toDataURL();
      const enhanced=await PrintOptimizer.forceEnhance(source),p=enhanced.getContext('2d').getImageData(0,0,200,200).data;
      let edges=0;for(let i=0;i<p.length;i+=4)if(p[i+3]>=32&&p[i+3]<255){edges++;if([220,50,90].some((c,k)=>Math.abs(c-p[i+k])>5))throw Error('Colored fringe contaminated');}
      if(!edges||source.toDataURL()!==original)throw Error('Missing soft alpha or original mutated');
      // Opaque two-color steps must stay inside source color ranges (no ringing).
      const blocks=make(),b=blocks.getContext('2d');b.fillStyle='rgb(60,80,100)';b.fillRect(0,0,100,100);b.fillStyle='rgb(180,160,140)';b.fillRect(50,0,50,100);
      const smooth=await PrintOptimizer.forceEnhance(blocks),q=smooth.getContext('2d').getImageData(0,0,200,200).data;
      for(let i=0;i<q.length;i+=4)for(let c=0;c<3;c++)if(q[i+c]<[60,80,100][c]||q[i+c]>[180,160,140][c])throw Error('Overshoot outside source color envelope');
      window.forceCase={source,snapshot:original,expected:enhanced.toDataURL(),calls:0};
      window.openForce=()=>PrintOptimizer.open({canvas:source,widthIn:1/3,heightIn:1/3,nativeScale:1,budget(){},apply(c,f){forceCase.calls++;forceCase.applied=c.toDataURL();forceCase.factor=f;}});
      return {softEdgePixels:edges,dimensions:[enhanced.width,enhanced.height]};
    });
    await page.evaluate(()=>openForce());
    assert.equal(await page.locator('[data-enhancement]').inputValue(),'auto');
    assert.match(await page.locator('.print-result').innerText(),/No visual change required/);
    const original=await page.locator('.print-before .print-image').evaluate(c=>c.toDataURL());
    await page.locator('[data-enhancement]').selectOption('force');
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.match(await page.locator('.print-result').innerText(),/Forced smooth enhancement applied · 2× working resolution · mild edge refinement/);
    assert(await page.evaluate(()=>{const actual=document.querySelector('.print-after .print-image');return actual.width===200&&actual.height===200&&actual.toDataURL()!==forceCase.snapshot;}),'Real 2× candidate displayed');
    for(const zoom of [2,4]){
      await page.locator(`[data-inspect="${zoom}"]`).click();
      assert.equal(await page.locator('.print-before .print-image').evaluate(c=>c.toDataURL()),original);
      // Compare equal-sized rendered pane crops, not only different bitmap dimensions.
      const left=await page.locator('.print-before .print-viewport').screenshot();
      const right=await page.locator('.print-after .print-viewport').screenshot();
      assert(!left.equals(right),`${zoom*100}% shows actual changed pixels`);
    }
    await page.screenshot({path:path.join(artifacts,'force-400.png')});
    await page.locator('[data-enhancement]').selectOption('auto');
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.match(await page.locator('.print-result').innerText(),/No visual change required/);
    assert.equal(await page.locator('.print-after .print-image').evaluate(c=>c.toDataURL()),original);
    await page.locator('[data-enhancement]').selectOption('force');
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    await page.locator('[data-cancel]').click();assert.equal(await page.evaluate(()=>forceCase.calls),0);
    await page.evaluate(()=>openForce());await page.locator('[data-enhancement]').selectOption('force');
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    await page.locator('[data-apply]').click();
    assert(await page.evaluate(()=>forceCase.calls===1&&forceCase.factor===2&&forceCase.applied===forceCase.expected&&forceCase.source.toDataURL()===forceCase.snapshot));
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({pixelChecks,checks:'300 PPI Auto no-op; Force actual 2× candidate, visible 200/400 difference; no colored-edge matte/overshoot; Auto restoration, Cancel and exact Apply',artifacts},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
