const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('playwright');
const source=fs.readFileSync('public/builder.html','utf8');
const hook='window.edgeTest={get designs(){return designs},get sheets(){return sheets},downloadPng,downloadTiff,getExportProfile};';
const html=source.replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'edge-fringe-'));
function parseTiff(bytes){
  const tags={},ifd=bytes.readUInt32LE(4),sizes={1:1,2:1,3:2,4:4,5:8,7:1};
  for(let i=0;i<bytes.readUInt16LE(ifd);i++){
    const at=ifd+2+i*12,id=bytes.readUInt16LE(at),type=bytes.readUInt16LE(at+2),n=bytes.readUInt32LE(at+4),size=sizes[type],offset=n*size<=4?at+8:bytes.readUInt32LE(at+8);
    tags[id]=Array.from({length:n},(_,k)=>type===3?bytes.readUInt16LE(offset+k*size):type===4?bytes.readUInt32LE(offset+k*size):type===5?bytes.readUInt32LE(offset+k*8)/bytes.readUInt32LE(offset+k*8+4):bytes[offset+k]);
  }
  return {tags,pixels:Buffer.concat(tags[273].map((offset,i)=>bytes.subarray(offset,offset+tags[279][i])))};
}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4188/**',route=>{
      const name=new URL(route.request().url()).pathname;
      if(/^\/(background-editor|sheet-workspace|print-optimizer)\.(js|css)$/.test(name))return route.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('.js')?'text/javascript':'text/css'});
      return route.fulfill({body:html,contentType:'text/html'});
    });
    await page.goto('http://localhost:4188/builder.html');
    const counts=await page.evaluate(async()=>{
      const results=[];
      function fixture(matte,wide=false){
        const c=document.createElement('canvas');c.width=c.height=100;
        // Fixed software backing avoids Chromium GPU-to-CPU readback rounding
        // obscuring whether the cleanup itself changed a low-alpha sample.
        const ctx=c.getContext('2d',{willReadFrequently:true}),image=ctx.createImageData(100,100);
        for(let y=0;y<100;y++)for(let x=0;x<100;x++){
          const distance=Math.max(30-x,x-69,30-y,y-69,0),at=(y*100+x)*4;
          if(distance>(wide?10:3))continue;
          const color=distance&&matte!==null?[matte,matte,matte]:[30,100,210];
          const alpha=distance?(wide?99-distance*9:[0,80,40,12][distance]):255;
          image.data.set([...color,alpha],at);
        }
        ctx.putImageData(image,0,0);return c;
      }
      for(const [name,matte,wide] of [['black connected corner halo',0,false],['white connected corner halo',255,false],['gray connected corner halo',128,false],['colored antialiased edges',null,false],['intentional broad soft shadow',0,true]]){
        const c=fixture(matte,wide),input=c.getContext('2d').getImageData(0,0,100,100).data,old=await PrintOptimizer.clean(c);
        if(old.removed!==0)throw Error('Old isolated-dot pass should not touch connected halo');
        const result=await PrintOptimizer.cleanFringe(c),data=result.canvas.getContext('2d').getImageData(0,0,100,100).data;
        const retained=c.getContext('2d').getImageData(0,0,100,100).data;
        if(!input.every((v,i)=>v===retained[i]))throw Error(name+': Input mutated before Apply; differences '+input.reduce((sum,v,i)=>sum+(v!==retained[i]),0));
        if(matte!==null&&!wide){
          if(result.cleaned!==516||result.removed!==180||result.reduced!==336||result.before!==2116||result.after!==1936)throw Error(name+': unexpected counts '+JSON.stringify(result));
          if(data[(27*100+27)*4+3]!==0)throw Error('Attached blurry outer corner not removed');
          if(data[(28*100+28)*4+3]!==10)throw Error('Connected gray corner not attenuated');
          for(let y=30;y<70;y++)for(let x=30;x<70;x++)if([...data.subarray((y*100+x)*4,(y*100+x)*4+4)].join()!=='30,100,210,255')throw Error('Opaque artwork changed');
          const again=await PrintOptimizer.cleanFringe(result.canvas);if(again.cleaned!==0)throw Error('Repeated cleanup erodes edges');
        }else if(result.canvas!==c||result.cleaned!==0)throw Error(name+' should remain byte-identical');
        results.push({name,before:result.before,after:result.after,cleaned:result.cleaned,removed:result.removed,reduced:result.reduced});
        if(matte===0&&!wide)window.haloPng=c.toDataURL();
      }
      // Enclosed hole edges never inherit exterior transparency membership.
      const hole=document.createElement('canvas');hole.width=hole.height=40;const ctx=hole.getContext('2d');ctx.fillStyle='rgb(30,100,210)';ctx.fillRect(0,0,40,40);ctx.clearRect(10,10,20,20);ctx.fillStyle='rgba(0,0,0,.2)';ctx.fillRect(10,10,20,2);
      if((await PrintOptimizer.cleanFringe(hole)).cleaned!==0)throw Error('Enclosed detail changed');
      // Opaque one-pixel hair and a sparse two-pixel highlight are protected.
      const hair=document.createElement('canvas');hair.width=hair.height=50;const hc=hair.getContext('2d');hc.fillStyle='rgb(30,100,210)';hc.fillRect(20,20,20,20);hc.fillRect(25,2,1,18);hc.fillStyle='rgba(255,255,255,.2)';hc.fillRect(21,19,2,1);
      if((await PrintOptimizer.cleanFringe(hair)).cleaned!==0)throw Error('Thin hair/highlight changed');
      return results;
    });
    const png=await page.evaluate(()=>haloPng);
    await page.locator('#fileInput').setInputFiles({name:'connected-corner-fringe.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});
    await page.waitForFunction(()=>edgeTest.designs.length===1);
    const card=page.locator('.design-item'),open=()=>card.getByRole('button',{name:'Optimize for Print',exact:true}).click();
    const before=await page.evaluate(()=>edgeTest.designs[0].trimmed.canvas.toDataURL());
    await open();await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.match(await page.locator('.print-result').innerText(),/Balanced edge cleanup: 516 outer fringe pixels cleaned/);
    assert.equal(await page.evaluate(()=>edgeTest.designs[0].trimmed.canvas.toDataURL()),before,'preview is non-destructive');
    for(const factor of [1,2,4]){
      await page.locator(`[data-inspect="${factor}"]`).click();
      assert.deepEqual(await page.locator('.print-viewport canvas').evaluateAll(cs=>cs.map(c=>c.getBoundingClientRect().width/c.width)),[factor,factor]);
    }
    // Use mobile width so even a small fixture overflows at 400%; both panes
    // must follow the same source-pixel coordinates, including after zoom.
    await page.setViewportSize({width:375,height:600});
    await page.locator('.print-before .print-viewport').evaluate(p=>{p.scrollTop=10;});
    await page.waitForFunction(()=>document.querySelector('.print-after .print-viewport').scrollTop===10);
    for(const width of [375,1440]){
      await page.setViewportSize({width,height:850});
      assert(await page.locator('.print-optimizer').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await page.screenshot({path:path.join(artifacts,`comparison-${width}.png`)});
    }
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(await page.evaluate(()=>edgeTest.designs[0].trimmed.canvas.toDataURL()),before);
    await open();await page.getByRole('button',{name:'Apply optimization',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.print-optimizer'));
    const after=await page.evaluate(()=>edgeTest.designs[0].trimmed.canvas.toDataURL());assert.notEqual(after,before);
    await open();await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.match(await page.locator('.print-result').innerText(),/No removable edge fringe detected/);
    await page.getByRole('button',{name:'Undo last optimization',exact:true}).click();
    assert.equal(await page.evaluate(()=>edgeTest.designs[0].trimmed.canvas.toDataURL()),before);
    await open();await page.getByRole('button',{name:'Apply optimization',exact:true}).click();
    await page.locator('#sheetWidth').fill('1');await page.locator('#sheetLength').fill('1');
    await card.getByRole('button',{name:'Add to layout',exact:true}).click();
    await page.waitForFunction(()=>edgeTest.sheets.length>0);
    const expected=await page.evaluate(()=>{const d=edgeTest.designs[0],p=edgeTest.sheets[0].placements[0];if(p.inst.canvas!==d.trimmed.canvas)throw Error('Export source differs');return {x:p.x,y:p.y,w:d.trimmed.w,h:d.trimmed.h,rgba:Array.from(d.trimmed.canvas.getContext('2d').getImageData(0,0,d.trimmed.w,d.trimmed.h).data)};});
    const pngEvent=page.waitForEvent('download');await page.evaluate(()=>edgeTest.downloadPng(edgeTest.sheets[0],0));
    const bytes=fs.readFileSync(await(await pngEvent).path());
    const actual=await page.evaluate(async({b64,expected})=>{const bitmap=await createImageBitmap(await(await fetch('data:image/png;base64,'+b64)).blob()),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);return {w:c.width,h:c.height,rgba:Array.from(c.getContext('2d').getImageData(expected.x,expected.y,expected.w,expected.h).data)};},{b64:bytes.toString('base64'),expected});
    assert.deepEqual([actual.w,actual.h],[300,300]);assert.deepEqual(actual.rgba,expected.rgba,'PNG uses cleaned full-resolution source including semi-transparent pixels');
    const tiffEvent=page.waitForEvent('download');await page.evaluate(()=>{document.querySelector('#machinePreset').value='tarpaulin';return edgeTest.downloadTiff(edgeTest.sheets[0],0,edgeTest.getExportProfile('rgb'));});
    const tiff=parseTiff(fs.readFileSync(await(await tiffEvent).path()));
    assert.deepEqual([tiff.tags[256][0],tiff.tags[257][0],tiff.tags[282][0],tiff.tags[283][0]],[300,300,300,300]);
    for(let y=0;y<expected.h;y++)for(let x=0;x<expected.w;x++)for(let c=0;c<4;c++)assert.equal(tiff.pixels[((expected.y+y)*300+expected.x+x)*4+c],expected.rgba[(y*expected.w+x)*4+c]);
    page.once('dialog',d=>d.accept());await card.getByRole('button',{name:'Reset image',exact:true}).click();
    assert.equal(await page.evaluate(()=>edgeTest.designs[0].trimmed.canvas.toDataURL()),png,'Reset restores original complete upload');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({counts,checks:'Corner fringe, black/white/gray matte, colored AA, broad shadows, hair/highlights, enclosed holes, idempotence, linked 100/200/400% comparison, Cancel/Apply/Undo/Reset, real cleaned-source PNG/TIFF pixel equality',artifacts},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
