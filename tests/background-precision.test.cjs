const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'background-precision-'));
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.setContent('<html><head><style>body{font-family:Arial,sans-serif}</style></head><body><button id="open">Edit Background</button></body></html>');
    await page.addStyleTag({content:fs.readFileSync('public/background-editor.css','utf8')});
    await page.addScriptTag({content:fs.readFileSync('public/background-editor.js','utf8')});
    const unit=await page.evaluate(async()=>{
      function fixture(dark){
        const c=document.createElement('canvas');c.width=360;c.height=260;const ctx=c.getContext('2d');
        ctx.fillStyle=dark?'black':'white';ctx.fillRect(0,0,360,260);
        ctx.fillStyle=dark?'rgb(41,41,41)':'rgb(214,214,214)';
        for(let n=0;n<18;n++)ctx.fillRect(12+n*18,12+n%3*8,4,4);
        ctx.fillStyle=dark?'#efd45e':'#173f80';ctx.fillRect(110,70,160,120);
        ctx.fillStyle=dark?'black':'white';ctx.fillRect(140,90,3,70);ctx.fillRect(140,90,70,3);ctx.fillRect(170,130,45,2);
        ctx.fillStyle=dark?'white':'black';ctx.fillRect(65,75,2,50);ctx.fillRect(75,65,3,3);ctx.fillRect(60,160,24,1);
        const soft=ctx.createImageData(2,2);for(let n=0;n<4;n++)soft.data.set([180,25,70,100],n*4);ctx.putImageData(soft,95,120);
        return c;
      }
      window.fixture=fixture;const results=[];
      for(const dark of [false,true]){
        const c=fixture(dark),im=c.getContext('2d').getImageData(0,0,360,260),before=im.data.slice();
        const mask=(await SmartSheetBackgroundMask.select(im,360,260,{tolerance:42,protection:'balanced',cleanup:'standard'},null,()=>false)).mask;
        for(const [x,y] of [[13,13],[31,21],[49,29]])if(mask[y*360+x]!==255)throw Error('Outside dirt not fully selected');
        for(const [x,y] of [[141,110],[180,131],[65,90],[76,66],[70,160],[95,120]])if(mask[y*360+x])throw Error('Artwork/edge selected at '+x+','+y);
        if(!im.data.every((v,i)=>v===before[i]))throw Error('Selection changed source');
        const protectedMask=new Uint8Array(360*260);protectedMask[13*360+13]=255;
        const protectedResult=await SmartSheetBackgroundMask.select(im,360,260,{tolerance:42,protection:'strong',cleanup:'strong'},protectedMask,()=>false);
        if(protectedResult.mask[13*360+13])throw Error('Protected pixel selected');
        const off=await SmartSheetBackgroundMask.select(im,360,260,{tolerance:42,protection:'balanced',cleanup:'off'},null,()=>false);
        if(off.mask[13*360+13]>=mask[13*360+13])throw Error('Standard must clear more dirt than Off');
        const lowTolerance=await SmartSheetBackgroundMask.select(im,360,260,{tolerance:12,protection:'balanced',cleanup:'standard'},null,()=>false);
        if(lowTolerance.mask[13*360+13])throw Error('Cleanup exceeded colour tolerance');
        results.push({background:dark?'black':'white',selected:mask.reduce((n,v)=>n+!!v,0),dirtMask:mask[13*360+13],offMask:off.mask[13*360+13]});
      }
      return results;
    });
    const editor=page.locator('.bg-editor'),act=name=>editor.locator('[data-action="'+name+'"]');
    const idle=()=>page.waitForFunction(()=>document.querySelector('.bg-editor')?.getAttribute('aria-busy')==='false');
    async function open(dark=false){await page.evaluate(dark=>{
      window.source=fixture(dark);window.before=source.toDataURL();window.applied=null;
      openBackgroundEditor({canvas:source,original:source,sourceRect:{x:0,y:0,w:360,h:260},name:dark?'Light artwork · black noisy background.png':'Fine print artwork · white noisy background.png',apply:c=>{window.applied=c;}});
    },dark);await idle();}
    async function auto(){await editor.locator('.bg-advanced').evaluate(e=>e.open=true);await editor.locator('#bg-auto-tolerance').fill('42');await act('auto-edge').click();await idle();}
    const alpha=(x,y)=>page.locator('.bg-image').evaluate((c,[x,y])=>c.getContext('2d').getImageData(x,y,1,1).data[3],[x,y]);
    await open();
    for(const bg of ['black','white']){await editor.locator('#bg-preview-background').selectOption(bg);await page.screenshot({path:path.join(artifacts,'before-'+bg+'.png')});}
    await auto();assert.match(await editor.locator('.bg-status').innerText(),/Outside-connected/);
    assert.equal(await page.evaluate(()=>source.toDataURL()),await page.evaluate(()=>before),'selection does not alter source');
    await act('erase-selection').click();assert.equal(await alpha(13,13),0);assert.equal(await alpha(141,110),255);assert.equal(await alpha(95,120),100);
    for(const bg of ['black','white']){await editor.locator('#bg-preview-background').selectOption(bg);await page.screenshot({path:path.join(artifacts,'after-'+bg+'.png')});}
    await act('undo').click();assert.equal(await alpha(13,13),255);await act('redo').click();assert.equal(await alpha(13,13),0);
    await editor.locator('.bg-stage').focus();await page.keyboard.press('Control+z');assert.equal(await alpha(13,13),255);await page.keyboard.press('Control+y');assert.equal(await alpha(13,13),0);
    await editor.locator('#bg-compare').selectOption('original');assert.equal(await alpha(13,13),255);
    await editor.locator('#bg-compare').selectOption('edited');assert.equal(await alpha(13,13),0);
    await editor.locator('[data-tool="restore"]').click();await editor.locator('.bg-size-mirror-input').fill('8');
    const box=await editor.locator('.bg-stage').boundingBox();await page.mouse.click(box.x+13.5*box.width/360,box.y+13.5*box.height/260);
    assert.equal(await alpha(13,13),255);await auto();
    assert.equal(await editor.locator('.bg-overlay').evaluate(c=>c.getContext('2d').getImageData(13,13,1,1).data[3]),0,'Restore stroke protected from subsequent auto selection');
    await act('apply').click();await editor.waitFor({state:'detached'});
    const output=await page.evaluate(()=>({size:[applied.width,applied.height],unchanged:source.toDataURL()===before,alpha:applied.getContext('2d').getImageData(95,120,1,1).data[3]}));
    assert.deepEqual(output,{size:[360,260],unchanged:true,alpha:100});
    await open(true);await editor.locator('.bg-advanced').evaluate(e=>e.open=true);await editor.locator('#bg-cleanup').selectOption('off');await auto();await act('erase-selection').click();assert(await alpha(13,13)>0);
    await editor.locator('#bg-cleanup').selectOption('standard');await act('tiny-specks').click();await idle();await act('erase-selection').click();assert.equal(await alpha(13,13),0);assert.equal(await alpha(141,110),255);
    await page.screenshot({path:path.join(artifacts,'black-background-removed.png')});
    await act('reset').click();assert.equal(await alpha(13,13),255);await act('undo').click();assert.equal(await alpha(13,13),0);await act('redo').click();assert.equal(await alpha(13,13),255);
    await act('cancel').click();assert(await page.evaluate(()=>applied===null&&source.toDataURL()===before));
    // Native large mask + bounded inspection canvas, with a live event-loop heartbeat.
    await page.evaluate(()=>{
      window.large=document.createElement('canvas');large.width=large.height=4500;const ctx=large.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,4500,4500);ctx.fillStyle='#174180';ctx.fillRect(1000,1000,2500,2500);
      window.ticks=0;window.timer=setInterval(()=>ticks++,10);window.largeResult=null;
      openBackgroundEditor({canvas:large,original:large,sourceRect:{x:0,y:0,w:4500,h:4500},name:'4500 × 4500 full-resolution fixture.png',apply:c=>{largeResult=c;}});
    });await idle();
    assert.deepEqual(await editor.locator('.bg-image').evaluate(c=>[c.width,c.height]),[1600,1600]);
    await auto();await editor.locator('[data-tool="erase"]').click();await editor.locator('#bg-size').fill('40');
    const nativeBox=await editor.locator('.bg-stage').boundingBox();await page.mouse.click(nativeBox.x+1500.5*nativeBox.width/4500,nativeBox.y+1500.5*nativeBox.height/4500);
    await editor.locator('[data-tool="wand"]').click();await act('erase-selection').click();await act('apply').click();await editor.waitFor({state:'detached'});
    const large=await page.evaluate(()=>{clearInterval(timer);return {size:[largeResult.width,largeResult.height],ticks,removed:largeResult.getContext('2d').getImageData(10,10,1,1).data[3],manualHole:largeResult.getContext('2d').getImageData(1500,1500,1,1).data[3],art:Array.from(largeResult.getContext('2d').getImageData(1200,1200,1,1).data),source:large.getContext('2d').getImageData(10,10,1,1).data[3]};});
    assert.deepEqual(large.size,[4500,4500]);assert(large.ticks>10);assert.equal(large.removed,0);assert.equal(large.manualHole,0);assert.equal(large.source,255);assert.deepEqual(large.art,[23,65,128,255]);
    await open();await auto();await act('cancel').click();assert(await page.evaluate(()=>source.toDataURL()===before));
    await open();await editor.locator('.bg-advanced').evaluate(e=>e.open=true);
    await act('auto-edge').click();await act('cancel').click();await page.waitForTimeout(50);assert.equal(await editor.count(),0);assert(await page.evaluate(()=>source.toDataURL()===before));
    assert.deepEqual(errors,[]);console.log(JSON.stringify({checks:unit,output,large,artifacts},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
