const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
// Exact output parity against the pre-memory-fix implementation is checked in
// optimizer-memory.test.cjs; scheduling changes intentionally alter code hashes.
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'print-preview-ui-'));
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000},hasTouch:true}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4191/**',r=>{
      const name=new URL(r.request().url()).pathname;
      if(name==='/print-optimizer.js'||name==='/print-optimizer.css')return r.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('js')?'text/javascript':'text/css'});
      return r.fulfill({body:'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/print-optimizer.css"></head><body><button id="open">Open optimizer</button><script src="/print-optimizer.js"></script></body></html>',contentType:'text/html'});
    });
    await page.goto('http://localhost:4191');
    const start=async type=>{
      await page.evaluate(type=>{
        const c=document.createElement('canvas');c.width=type==='low'?80:type==='ghost'?1024:600;c.height=type==='low'?60:type==='ghost'?768:400;
        const ctx=c.getContext('2d',{willReadFrequently:true});
        if(type==='ghost'){
          ctx.fillStyle='#2479ac';ctx.fillRect(200,150,560,400);ctx.fillStyle='#000';ctx.fillRect(20,20,1,1);ctx.fillRect(1021,765,1,1);
        }else{
          for(let x=0;x<c.width;x++){ctx.fillStyle=x%2?'#ea4963':'#2984c6';ctx.fillRect(x,0,1,c.height);}
        }
        window.previewCase={source:c,snapshot:c.toDataURL(),applied:null,calls:0};
        document.querySelector('#open').focus();
        PrintOptimizer.open({canvas:c,widthIn:type==='low'?2:c.width/300,heightIn:type==='low'?1.5:c.height/300,nativeScale:1,budget(){},canUndo:false,apply(candidate,factor){previewCase.calls++;previewCase.applied={canvas:candidate,png:candidate.toDataURL(),factor};}});
      },type);
      await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    };
    await start('high');
    assert.equal(await page.getByRole('button',{name:'Compare original active source',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Show optimized preview',exact:true}).count(),0);
    assert.match(await page.locator('.print-before h3').innerText(),/Original/);
    assert.match(await page.locator('.print-after h3').innerText(),/Optimized preview/);
    assert.match(await page.locator('.print-result').innerText(),/No visual change required/);
    assert.equal(await page.locator('[data-apply]').innerText(),'Close — no changes');
    assert(await page.evaluate(()=>{const cs=document.querySelectorAll('.print-image');return cs[0].toDataURL()===cs[1].toDataURL();}));
    await page.locator('[data-apply]').click();assert.equal(await page.evaluate(()=>previewCase.calls),0,'no fake apply callback for identical result');

    await start('ghost');
    assert.equal(await page.locator('[data-apply]').innerText(),'Apply optimization');
    assert.match(await page.locator('.print-result').innerText(),/2 isolated outer ghost pixels removed/);
    assert(await page.evaluate(()=>{const cs=document.querySelectorAll('.print-image');return cs[0].toDataURL()!==cs[1].toDataURL()&&cs[0].getContext('2d').getImageData(20,20,1,1).data[3]===255&&cs[1].getContext('2d').getImageData(20,20,1,1).data[3]===0;}),'real source/candidate difference visible in separate preview rasters');
    for(const factor of [1,2,4]){
      await page.locator(`[data-inspect="${factor}"]`).click();
      assert.deepEqual(await page.locator('.print-image').evaluateAll(cs=>cs.map(c=>c.getBoundingClientRect().width/c.width)),[factor,factor]);
      assert(await page.locator('.print-image').first().evaluate(c=>getComputedStyle(c).imageRendering==='pixelated'));
    }
    await page.locator('[data-inspect="1"]').click();
    const at=await page.locator('.print-before .print-image').boundingBox();
    await page.mouse.move(at.x+20.5,at.y+20.5);
    await page.waitForFunction(()=>[...document.querySelectorAll('.print-lens')].every(l=>!l.hidden));
    assert(await page.locator('.print-lens').evaluateAll(ls=>ls[0].dataset.u===ls[1].dataset.u&&ls[0].dataset.v===ls[1].dataset.v));
    assert(await page.locator('.print-lens canvas').evaluateAll(cs=>cs[0].toDataURL()!==cs[1].toDataURL()),'linked lenses sample different true pixels at the same point');
    await page.screenshot({path:path.join(artifacts,'linked-lenses.png')});
    const vp=page.locator('.print-before .print-viewport');
    await page.locator('[data-inspect="2"]').click();
    const rect=await vp.boundingBox();await page.mouse.move(rect.x+250,rect.y+180);await page.mouse.down();await page.mouse.move(rect.x+180,rect.y+130);await page.mouse.up();
    await page.waitForFunction(()=>{const ps=document.querySelectorAll('.print-viewport');return ps[0].scrollLeft>0&&ps[0].scrollTop>0&&ps[0].scrollLeft===ps[1].scrollLeft&&ps[0].scrollTop===ps[1].scrollTop;});
    await page.getByRole('button',{name:'Swipe compare',exact:true}).click();
    await page.locator('[data-inspect="1"]').click();await vp.evaluate(p=>{p.scrollLeft=0;p.scrollTop=0;});
    await page.mouse.move(50,40);
    const pixelRect=await page.locator('.print-before .print-image').first().boundingBox();
    const renderedPixel=async()=>{
      const bytes=await page.screenshot({clip:{x:Math.round(pixelRect.x+20),y:Math.round(pixelRect.y+20),width:1,height:1}});
      return page.evaluate(async b64=>{const bitmap=await createImageBitmap(await(await fetch('data:image/png;base64,'+b64)).blob());const c=document.createElement('canvas');c.width=c.height=1;c.getContext('2d').drawImage(bitmap,0,0);return [...c.getContext('2d').getImageData(0,0,1,1).data];},bytes.toString('base64'));
    };
    const slider=page.getByRole('slider',{name:'Swipe comparison divider'});await slider.focus();await page.keyboard.press('ArrowRight');assert.equal(await slider.getAttribute('aria-valuenow'),'51');
    await page.keyboard.press('Home');assert.equal(await slider.getAttribute('aria-valuenow'),'0');
    assert((await renderedPixel())[0]>100,'optimized transparency reveals checkerboard, not original ghost underneath');
    await page.keyboard.press('End');assert.equal(await slider.getAttribute('aria-valuenow'),'100');
    assert((await renderedPixel())[0]<20,'original ghost is visible on the original side of swipe');
    assert.equal(await page.locator('.print-before .print-image').count(),2,'swipe reuses both distinct image buffers');
    const swipeRect=await vp.boundingBox();
    // Use real pointer drag for pointer capture and final divider positioning.
    await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');
    const handle=await slider.boundingBox();await page.mouse.move(handle.x+10,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(swipeRect.x+swipeRect.width*.35,handle.y+handle.height/2);await page.mouse.up();
    assert(Math.abs(Number(await slider.getAttribute('aria-valuenow'))-35)<=1);
    await page.screenshot({path:path.join(artifacts,'swipe.png')});
    await page.getByRole('button',{name:'Side by side',exact:true}).click();
    await page.setViewportSize({width:375,height:850});
    const mobile=await page.locator('.print-comparison section').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
    assert.equal(mobile[0].x,mobile[1].x);assert(mobile[1].y>=mobile[0].y+mobile[0].h,'mobile panes stack vertically');
    assert(await page.locator('.print-optimizer').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await page.getByRole('button',{name:'Fit',exact:true}).click();
    const touchImage=await page.locator('.print-before .print-image').boundingBox();
    await page.touchscreen.tap(touchImage.x+touchImage.width/2,touchImage.y+touchImage.height/2);
    assert(await page.locator('.print-lens').evaluateAll(ls=>ls.every(l=>!l.hidden)),'touch inspection stays visible after lifting finger');
    await page.screenshot({path:path.join(artifacts,'mobile-stacked.png')});
    assert(await page.evaluate(()=>previewCase.source.toDataURL()===previewCase.snapshot),'source remains unchanged through all inspection modes');
    const preview=await page.locator('.print-after .print-image').evaluate(c=>c.toDataURL());
    await page.locator('[data-apply]').click();assert.equal(await page.evaluate(()=>previewCase.applied.png),preview,'applies exactly the candidate shown');

    await start('low');
    assert.match(await page.locator('.print-result').innerText(),/No visual change required/);
    await page.locator('.print-upscale input').check();
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.deepEqual(await page.locator('.print-image').evaluateAll(cs=>cs.map(c=>[c.width,c.height])),[[80,60],[160,120]],'upscaled candidate exists before Apply');
    assert.match(await page.locator('.print-result').innerText(),/smooth upscale 2×/);
    assert.equal(await page.evaluate(()=>previewCase.applied),null);
    assert(await page.evaluate(()=>previewCase.source.toDataURL()===previewCase.snapshot));
    const upscaled=await page.locator('.print-after .print-image').evaluate(c=>c.toDataURL());
    await page.locator('[data-apply]').click();assert.equal(await page.evaluate(()=>previewCase.applied.png),upscaled,'Apply does not recompute or substitute the upscaled preview');
    await start('low');await page.locator('.print-upscale input').check();await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);await page.locator('.print-upscale input').uncheck();await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.equal(await page.locator('[data-apply]').innerText(),'Close — no changes');await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>previewCase.calls),0);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({checks:'Honest no-op; original/candidate pixels differ; linked lenses; zoom and drag pan; keyboard/draggable swipe; mobile stacking; pre-Apply upscale preview; source immutability; applied candidate equality; Cancel',artifacts},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
