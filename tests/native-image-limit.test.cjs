const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync('public/builder.html', 'utf8');
const hook = `window.nativeTest={get designs(){return designs},get sheets(){return sheets},assertImageBudget,createDesignFromFile,trimTransparentMargins};`;
const html = source.replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(180000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4197/**',r=>{
      const name=new URL(r.request().url()).pathname;
      if(/^\/(background-editor|sheet-workspace|print-optimizer)\.(js|css)$/.test(name))return r.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('.js')?'text/javascript':'text/css'});
      return r.fulfill({body:html,contentType:'text/html'});
    });
    await page.goto('http://localhost:4197/builder.html');
    const synthetic=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=c.height=2048;
      const ctx=c.getContext('2d');ctx.fillStyle='#236fb1';ctx.fillRect(1,1,2046,2046);ctx.clearRect(800,800,300,300);
      return c.toDataURL().split(',')[1];
    });
    // Record actual allocations, not requested estimates. Canvas setters are
    // captured after both dimensions are assigned; no production instrumentation.
    await page.evaluate(()=>{
      window.allocations=[];
      for(const key of ['width','height']){
        const d=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,key);
        Object.defineProperty(HTMLCanvasElement.prototype,key,{...d,set(v){d.set.call(this,v);allocations.push({kind:'canvas',w:this.width,h:this.height});}});
      }
      const proto=CanvasRenderingContext2D.prototype;
      for(const key of ['getImageData','createImageData']){const native=proto[key];proto[key]=function(...a){const result=native.apply(this,a);allocations.push({kind:key,w:result.width,h:result.height});return result;};}
      const NativeImageData=ImageData;
      window.ImageData=new Proxy(NativeImageData,{construct(target,a){const result=new target(...a);allocations.push({kind:'ImageData',w:result.width,h:result.height});return result;}});
      window.allocReport=()=>{
        const unique=[...new Set(allocations.map(a=>a.kind+': '+a.w+'x'+a.h))];
        return {unique,maxPixels:Math.max(0,...allocations.map(a=>a.w*a.h)),doubled:allocations.some(a=>a.w===4096&&a.h===4096)};
      };
    });
    const crop=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=c.height=2048;
      const ctx=c.getContext('2d');ctx.fillStyle='#236fb1';ctx.fillRect(128,128,1792,1792);
      ctx.fillStyle='rgba(255,0,0,0.02)';ctx.fillRect(127,128,1,1792);
      allocations.length=0;
      const result=nativeTest.trimTransparentMargins(c,1);
      // Read each image once when comparing the cropped pixel data.
      const expected=ctx.getImageData(result.cropRect.x,result.cropRect.y,result.w,result.h).data;
      const actual=result.canvas.getContext('2d').getImageData(0,0,result.w,result.h).data;
      const report={active:[result.w,result.h],samePixels:expected.every((v,i)=>v===actual[i]),allocations:allocReport()};
      c.width=0;result.canvas.width=0;return report;
    });
    assert.deepEqual(crop.active,[1795,1794]);assert(crop.samePixels);assert(crop.allocations.maxPixels<=2048*2048);
    console.log('Native trim:',JSON.stringify(crop));
    const reports=[];
    const inputs=[{name:'native-2048.png',buffer:Buffer.from(synthetic,'base64')}];
    if(process.env.NATIVE_PNG_PATH)inputs.push({name:'fsdf.png',buffer:fs.readFileSync(process.env.NATIVE_PNG_PATH)});
    for(const file of inputs){
      await page.evaluate(()=>{allocations.length=0;});
      await page.locator('#fileInput').setInputFiles({...file,mimeType:'image/png'});
      await page.waitForFunction(name=>nativeTest.designs.some(d=>d.file.name===name),file.name);
      const index=await page.evaluate(name=>nativeTest.designs.findIndex(d=>d.file.name===name),file.name);
      const card=page.locator('.design-item').nth(index);
      const upload=await page.evaluate(i=>{
        const d=nativeTest.designs[i];window.sessionDesign=d;window.unchanged=d.trimmed.canvas.toDataURL();
        return {original:[d.originalCanvas.width,d.originalCanvas.height],active:[d.trimmed.w,d.trimmed.h],allocations:allocReport()};
      },index);
      assert.deepEqual(upload.original,[2048,2048]);assert(upload.allocations.maxPixels<=2048*2048);
      // This used to fail once unrelated retained cards crossed the budget.
      await page.evaluate(()=>{
        const fake={width:8192,height:8192},d={originalCanvas:fake,trimmed:{canvas:fake}};
        nativeTest.designs.push(d);
        try{nativeTest.assertImageBudget(2048,2048,51,'Edit Background');}finally{nativeTest.designs.pop();}
      });
      await page.evaluate(()=>{allocations.length=0;});
      await card.getByRole('button',{name:'Edit Background',exact:true}).click();
      await page.locator('.bg-editor').waitFor();
      const editor=await page.evaluate(()=>allocReport());assert(editor.maxPixels<=2048*2048);
      await page.locator('.bg-editor [data-action="cancel"]').click();
      assert(await page.evaluate(()=>sessionDesign.trimmed.canvas.toDataURL()===unchanged));
      await page.evaluate(()=>{allocations.length=0;});
      await card.getByRole('button',{name:'Optimize for Print',exact:true}).click();
      const ready=()=>page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
      await ready();
      const auto=[];
      for(const strength of ['safe','balanced','strong']){
        await page.evaluate(()=>{allocations.length=0;});
        await page.locator('[data-edge-strength]').selectOption(strength);await ready();
        const r=await page.evaluate(()=>({allocations:allocReport(),summary:document.querySelector('.print-result').textContent,bytes:Number(document.querySelector('.print-optimizer').dataset.estimatedPeakBytes)}));
        assert(r.allocations.maxPixels<=2048*2048);assert(!r.allocations.doubled);assert(!/failed|memory limit/i.test(r.summary));auto.push({strength,...r});
      }
      // Force is the only UI operation which may allocate the doubled image.
      await page.evaluate(()=>{allocations.length=0;});
      await page.locator('[data-enhancement]').selectOption('force');await ready();
      const forced=await page.evaluate(()=>({allocations:allocReport(),bytes:Number(document.querySelector('.print-optimizer').dataset.estimatedPeakBytes),summary:document.querySelector('.print-result').textContent}));
      assert.match(forced.summary,/Forced smooth enhancement applied/);
      if(file.name==='native-2048.png')assert(forced.allocations.doubled);
      assert(await page.evaluate(()=>sessionDesign.trimmed.canvas.toDataURL()===unchanged));
      await page.locator('[data-enhancement]').selectOption('auto');await ready();
      await page.locator('[data-cancel]').click();
      assert(await page.evaluate(()=>sessionDesign.trimmed.canvas.toDataURL()===unchanged));
      // Low effective PPI must also remain native in Auto.
      await card.getByRole('spinbutton',{name:'Width',exact:true}).fill('14');
      await page.evaluate(()=>{allocations.length=0;});
      await card.getByRole('button',{name:'Optimize for Print',exact:true}).click();await ready();
      assert(await page.evaluate(()=>allocReport().maxPixels<=2048*2048));
      await page.locator('[data-cancel]').click();
      await card.getByRole('spinbutton',{name:'Width',exact:true}).fill('6.8');
      await card.getByRole('button',{name:'Add to layout',exact:true}).click();
      await page.waitForFunction(()=>nativeTest.sheets.some(s=>s.placements.some(p=>p.inst.designId===sessionDesign.id)));
      assert(await page.evaluate(()=>nativeTest.sheets.some(s=>s.placements.some(p=>p.inst.designId===sessionDesign.id&&p.inst.canvas===sessionDesign.trimmed.canvas))));
      reports.push({file:file.name,upload,editor,auto,forced});
    }
    assert.deepEqual(errors,[]);console.log(JSON.stringify(reports,null,2));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
