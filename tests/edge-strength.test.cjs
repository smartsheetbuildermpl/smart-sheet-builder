const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'edge-strength-'));
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4192/**',r=>{
      const name=new URL(r.request().url()).pathname;
      if(/^\/print-optimizer\.(js|css)$/.test(name))return r.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('js')?'text/javascript':'text/css'});
      return r.fulfill({body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/print-optimizer.css"><style>body{font-family:Arial}</style><script src="/print-optimizer.js"></script>',contentType:'text/html'});
    });
    await page.goto('http://localhost:4192');
    const counts=await page.evaluate(async()=>{
      const result=[];
      function fixture(matte,radius=6){
        const c=document.createElement('canvas');c.width=c.height=100;const ctx=c.getContext('2d',{willReadFrequently:true}),im=ctx.createImageData(100,100);
        for(let y=0;y<100;y++)for(let x=0;x<100;x++){
          const d=Math.max(30-x,x-69,30-y,y-69,0);if(d>radius)continue;
          const alpha=d?(radius===3?[0,80,40,12][d]:[0,196,172,140,100,60,20][d]):255;
          im.data.set([...(d&&matte?matte:[30,100,210]),alpha],(y*100+x)*4);
        }
        for(const [x,y] of [[2,2],[97,2],[2,97],[97,97]])im.data.set([0,0,0,255],(y*100+x)*4);
        ctx.putImageData(im,0,0);return c;
      }
      for(const [name,color] of [['black connected corners',[0,0,0]],['white connected corners',[255,255,255]],['tinted matte corners',[240,220,200]],['clean colored antialiasing',null]]){
        const source=fixture(color,color?6:3),snapshot=source.toDataURL();
        for(const mode of ['safe','balanced','strong']){
          const prepared=await PrintOptimizer.prepare(source,null,mode),edge=prepared.fringe;
          if(source.toDataURL()!==snapshot)throw Error('Source mutated');
          if(prepared.removed!==4)throw Error('Expected exactly four isolated dots');
          if(color){
            const expected=mode==='safe'?0:mode==='balanced'?768:1104;
            if(edge.cleaned!==expected)throw Error(name+' '+mode+' count '+edge.cleaned+' expected '+expected);
            if(mode!=='safe'&&prepared.canvas.toDataURL()===snapshot)throw Error('Fringe preview unchanged');
          }else if(edge.cleaned!==0)throw Error(mode+' damaged clean colored AA');
          const rgba=prepared.canvas.getContext('2d').getImageData(0,0,100,100).data;
          for(let y=30;y<70;y++)for(let x=30;x<70;x++)if([...rgba.subarray((y*100+x)*4,(y*100+x)*4+4)].join()!=='30,100,210,255')throw Error('Solid core changed');
          if((await PrintOptimizer.cleanFringe(prepared.canvas,null,mode)).cleaned)throw Error('Repeated '+mode+' erodes its result');
          result.push({name,mode,isolated:prepared.removed,fringe:edge.cleaned,removed:edge.removed,reduced:edge.reduced,before:edge.before,after:edge.after});
          if(name==='black connected corners'&&mode==='balanced')window.expectedBalanced=prepared.canvas.toDataURL();
          if(name==='black connected corners'&&mode==='strong')window.expectedStrong=prepared.canvas.toDataURL();
        }
        if(name==='black connected corners')window.strengthSource=source;
      }
      // Semitransparent colored thin strokes remain protected, even when attached
      // to a solid body and within Strong's extended search radius.
      for(const lineWidth of [1,2,3]){
        const c=document.createElement('canvas');c.width=c.height=50;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.fillStyle='rgb(30,100,210)';ctx.fillRect(20,20,20,20);ctx.fillStyle='rgba(30,100,210,.2)';ctx.fillRect(25,8,lineWidth,12);
        const before=c.toDataURL();for(const mode of ['balanced','strong'])if((await PrintOptimizer.cleanFringe(c,null,mode)).canvas.toDataURL()!==before)throw Error(mode+' damaged '+lineWidth+'px colored line');
      }
      // Interior semitransparency has no exterior seed and cannot be selected.
      const hole=document.createElement('canvas');hole.width=hole.height=40;const hc=hole.getContext('2d');hc.fillStyle='#2479ac';hc.fillRect(0,0,40,40);hc.clearRect(10,10,20,20);hc.fillStyle='rgba(255,255,255,.5)';hc.fillRect(10,10,20,3);
      if((await PrintOptimizer.cleanFringe(hole,null,'strong')).cleaned)throw Error('Strong changed enclosed pixels');
      const shadow=document.createElement('canvas');shadow.width=shadow.height=100;const sc=shadow.getContext('2d',{willReadFrequently:true}),si=sc.createImageData(100,100);
      for(let y=0;y<100;y++)for(let x=0;x<100;x++){const d=Math.max(30-x,x-69,30-y,y-69,0);if(d<=10)si.data.set(d?[0,0,0,99-d*9]:[30,100,210,255],(y*100+x)*4);}
      sc.putImageData(si,0,0);
      for(const mode of ['safe','balanced','strong']){
        const s=await PrintOptimizer.cleanFringe(shadow,null,mode);
        if(mode==='strong'?s.cleaned===0:s.cleaned!==0)throw Error('Unexpected shadow behavior for '+mode);
        const pixels=s.canvas.getContext('2d').getImageData(30,30,40,40).data;
        if(!pixels.every((v,i)=>v===[30,100,210,255][i%4]))throw Error('Shadow cleanup damaged core');
        result.push({name:'broad intentional shadow',mode,isolated:0,fringe:s.cleaned,removed:s.removed,reduced:s.reduced,before:s.before,after:s.after});
      }
      return result;
    });
    const open=()=>page.evaluate(()=>{window.strengthApplied=null;window.sessionOriginal=strengthSource.toDataURL();PrintOptimizer.open({canvas:strengthSource,widthIn:1/3,heightIn:1/3,nativeScale:1,budget(){},apply(c){strengthApplied=c.toDataURL();}});});
    const ready=()=>page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    await open();await ready();
    const select=page.getByRole('combobox',{name:'Edge cleanup strength'});
    assert.equal(await select.inputValue(),'balanced');
    assert.match(await page.locator('.print-result').innerText(),/Balanced edge cleanup: 768 outer fringe pixels cleaned/);
    const originalPreview=await page.locator('.print-before .print-image').evaluate(c=>c.toDataURL());
    for(const mode of ['strong','safe','balanced','strong']){
      await select.selectOption(mode);await ready();
      assert.equal(await page.locator('.print-before .print-image').evaluate(c=>c.toDataURL()),originalPreview,'mode switching never changes Original');
      const candidate=await page.locator('.print-after .print-image').evaluate(c=>c.toDataURL());
      if(mode!=='safe')assert.equal(candidate,await page.evaluate(mode=>mode==='strong'?expectedStrong:expectedBalanced,mode),'mode preview recomputed from original, not prior strength');
      for(const zoom of [1,2,4]){
        await page.locator(`[data-inspect="${zoom}"]`).click();assert.equal(await page.locator('.print-after .print-image').evaluate(c=>c.getBoundingClientRect().width/c.width),zoom);
      }
    }
    await page.screenshot({path:path.join(artifacts,'strong-comparison.png')});
    await page.locator('[data-apply]').click();assert.equal(await page.evaluate(()=>strengthApplied),await page.evaluate(()=>expectedStrong),'Apply publishes selected Strong candidate exactly');
    assert(await page.evaluate(()=>strengthSource.toDataURL()===sessionOriginal));
    await open();await ready();await select.selectOption('strong');await ready();await select.selectOption('balanced');await ready();await page.locator('[data-apply]').click();assert.equal(await page.evaluate(()=>strengthApplied),await page.evaluate(()=>expectedBalanced),'switching back applies Balanced, not an older Strong result');
    await open();await ready();await select.selectOption('strong');await ready();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>strengthApplied),null);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({counts,checks:'Default Balanced; progressive full-resolution fringe cleanup; immutable opaque core, colored AA, 1–3px lines and enclosed pixels; idempotence; mode changes regenerate from original; selected candidate applied exactly; Cancel',artifacts},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
