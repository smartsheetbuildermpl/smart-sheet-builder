const fs = require('fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const source = fs.readFileSync('public/builder.html','utf8');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const outputDir = process.env.BUILDER_TEST_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'builder-tests-'));
fs.mkdirSync(outputDir, {recursive:true});
const protectedHashes = require('./protected-builder-blocks.json');
// Check protected blocks against the user's uncommitted starting implementation.
for (const [a,b] of [
  ['  var directOnlineAccess', '  var translations'],
  ['  function getExportProfile(', '  function updateUnitLabels('],
  ['  function renderTiffCheck(', '  function computeStats(']
]) {
  assert(source.includes(a) && source.includes(b));
  assert.equal(crypto.createHash('sha256').update(source.slice(source.indexOf(a),source.indexOf(b))).digest('hex'), protectedHashes[a], a);
}
(async()=>{
  const browser = await chromium.launch({...(process.env.CHROME_EXECUTABLE ? {executablePath:process.env.CHROME_EXECUTABLE} : {channel:'chrome'}),headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    // Expose closure internals only in this ephemeral test page, never in production.
    const testSource = source;
    const hook=`window.testBuilder={get designs(){return designs},get instances(){return instances},get sheets(){return sheets},packSheet,decodeImageCanvas,trimTransparentMargins,removeConnectedEdgeBackground,removeTinySpecks,drawSheetCanvas,createInstancesForDesign,appendDesignToCurrentLayout,rotatePlacementOnSheet,qualityForPlacement,renderAllDesigns};`;
    const html=testSource.replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
    assert.notEqual(html,testSource,'test hook inserted');
    await page.route('http://localhost:4178/**',route=> {
      const name = new URL(route.request().url()).pathname;
      if (/^\/(sheet-workspace|background-editor|print-optimizer)\.(js|css)$/.test(name)) return route.fulfill({ body: fs.readFileSync('public' + name), contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css' });
      return route.fulfill({body:html,contentType:'text/html'});
    });
    await page.goto('http://localhost:4178/builder.html');
    await page.evaluate(()=>{
      document.getElementById('dpi').value=100;
      document.getElementById('sheetWidth').value=4;
      document.getElementById('sheetLength').value=4;
      document.getElementById('gapNumber').value=0.1;
      document.getElementById('langToggleEN').click();
    });
    // Upload an actual PNG with fully transparent, faint, partial and opaque pixels.
    const png=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=120;c.height=80;
      const ctx=c.getContext('2d'), data=ctx.createImageData(120,80);
      for(let y=0;y<80;y++)for(let x=0;x<120;x++) {
        const i=(y*120+x)*4;data.data[i]=220;data.data[i+1]=50;data.data[i+2]=90;
        data.data[i+3]=x<10?0:x<20?4:x<30?80:x<40?160:255;
      }
      ctx.putImageData(data,0,0);return c.toDataURL().split(',')[1];
    });
    await page.locator('input[type=file]').setInputFiles({name:'A-very-long-design-filename-with-transparent-soft-edges-and-original-resolution-preserved.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.waitForFunction(()=>window.testBuilder.designs.length===1);
    const imageTests=await page.evaluate(async()=>{
      const t=window.testBuilder,d=t.designs[0], results=[];
      function check(ok,label){if(!ok)throw Error(label);results.push(label)}
      check(d.originalCanvas.width===120 && d.originalCanvas.height===80,'upload keeps complete 120 × 80 source');
      const alpha=x=>d.originalCanvas.getContext('2d').getImageData(x,0,1,1).data[3];
      check([alpha(0),alpha(15),alpha(25),alpha(35),alpha(60)].join() === '0,4,80,160,255','upload preserves transparent, faint, soft and opaque alpha');
      const snapshot=d.originalCanvas.toDataURL();
      check(d.autoTrimApplied && d.trimRect.x===9 && d.trimRect.y===0 && d.trimRect.w===111 && d.trimRect.h===80,'upload trims only outside transparent margins with one-pixel safety padding');
      check(d.trimmed.w===111 && d.trimmed.h===80 && d.widthIn===1.11 && d.heightIn===0.8,'active crop sets the default 100-PPI print size');
      check(d.trimmed.canvas.getContext('2d').getImageData(6,0,1,1).data[3]===4,'trim preserves faint non-zero alpha at the active edge');
      const tight=document.createElement('canvas');tight.width=tight.height=8;
      const tightImage=tight.getContext('2d').createImageData(8,8);
      const padded=document.createElement('canvas');padded.width=padded.height=20;
      const paddedImage=padded.getContext('2d').createImageData(20,20);
      for(let y=1;y<7;y++)for(let x=1;x<7;x++){
        const a=(y*8+x)*4,b=((y+6)*20+x+6)*4;
        [tightImage.data[a],paddedImage.data[b]]=[31,31];[tightImage.data[a+1],paddedImage.data[b+1]]=[92,92];[tightImage.data[a+2],paddedImage.data[b+2]]=[201,201];[tightImage.data[a+3],paddedImage.data[b+3]]=[x===1||y===1?4:255,x===1||y===1?4:255];
      }
      tight.getContext('2d').putImageData(tightImage,0,0);padded.getContext('2d').putImageData(paddedImage,0,0);
      const tightTrim=t.trimTransparentMargins(tight,1), paddedTrim=t.trimTransparentMargins(padded,1);
      check(tightTrim.noChange && paddedTrim.w===8 && paddedTrim.h===8 && paddedTrim.canvas.toDataURL()===tight.toDataURL(),'tight and padded artwork resolve to the same active canvas without resampling');
      let emptyRejected=false;try{const empty=document.createElement('canvas');empty.width=empty.height=4;t.trimTransparentMargins(empty,1)}catch(e){emptyRejected=/completely transparent/.test(e.message)}
      check(emptyRejected,'completely transparent PNGs are rejected before they enter the builder');
      const inst=t.createInstancesForDesign(d,100)[0];
      check(inst.canvas===d.trimmed.canvas,'instances reference the active trimmed source');
      inst.baseW=30;inst.baseH=20;inst.baseW=111;inst.baseH=80;
      const canvas=document.createElement('canvas');
      t.drawSheetCanvas(canvas,{widthPx:111,heightPx:80,placements:[{inst,x:0,y:0,w:111,h:80}]});
      check(canvas.toDataURL()===d.trimmed.canvas.toDataURL(),'active cropped source renders without cumulative resampling');
      const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
      const decoded=await createImageBitmap(blob);
      const output=document.createElement('canvas');output.width=decoded.width;output.height=decoded.height;
      output.getContext('2d').drawImage(decoded,0,0);
      check(output.toDataURL()===d.trimmed.canvas.toDataURL(),'PNG encode/decode retains the active cropped resolution and all alpha values');
      const cleaned=t.removeTinySpecks(d.trimmed.canvas);
      check(cleaned.noChange && d.originalCanvas.toDataURL()===snapshot,'optional speck cleanup preserves connected soft edges without changing the retained original');
      const enlarged=await PrintOptimizer.upscale(d.trimmed.canvas,2);
      const enhanced={canvas:enlarged,w:enlarged.width,h:enlarged.height};
      check(enhanced.w===222 && enhanced.h===160,'enhancement doubles both active pixel dimensions');
      check(enhanced.canvas.getContext('2d').getImageData(0,0,1,1).data[3]===0,'enhancement retains transparency');
      check(d.originalCanvas.toDataURL()===snapshot,'enhancement leaves original untouched');
      let rejected=false;try{await PrintOptimizer.upscale({width:4097,height:4097},2)}catch(e){rejected=true}
      check(rejected,'oversized enhancement rejected before allocation');
      const bg=document.createElement('canvas');bg.width=30;bg.height=30;
      const ctx=bg.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,30,30);
      ctx.fillStyle='rgb(225,225,225)';ctx.fillRect(5,5,20,20);
      ctx.fillStyle='red';ctx.fillRect(10,10,10,10);
      ctx.fillStyle='white';ctx.fillRect(13,13,3,3);
      const bgResult=t.removeConnectedEdgeBackground(bg,42), rgba=bgResult.canvas.getContext('2d');
      check(rgba.getImageData(0,0,1,1).data[3]===0,'connected uniform background removed');
      const soft=rgba.getImageData(6,6,1,1).data[3];
      check(soft>0 && soft<255,'background transition feathered');
      check(rgba.getImageData(14,14,1,1).data[3]===255,'enclosed same-color detail preserved');
      check(bgResult.w===30 && bgResult.h===30,'background removal preserves canvas dimensions');
      return results;
    });
    const card=page.locator('.design-item');
    assert.match(await card.locator('[role=status]').innerText(),/Transparent margins trimmed: 120 × 80 px → 111 × 80 px/);
    const dims=await page.evaluate(()=>window.testBuilder.designs.map(d=>[d.widthIn,d.heightIn]));
    assert.equal(await card.getByRole('button',{name:'Edit Background',exact:true}).count(),1);
    assert.equal(await card.getByRole('button',{name:'Optimize for Print',exact:true}).count(),1);
    assert.equal(await card.getByRole('button',{name:'Remove BG',exact:true}).count(),0);
    assert.equal(await card.getByRole('button',{name:'Remove tiny specks',exact:true}).count(),0);
    assert.equal(await card.getByRole('button',{name:'Undo',exact:true}).count(),0);
    assert.equal(await card.getByRole('button',{name:'Restore original canvas',exact:true}).count(),0);
    await card.getByRole('button',{name:'Optimize for Print',exact:true}).click();
    await page.locator('[data-enhancement]').selectOption('force');
    await page.getByRole('button',{name:'Apply optimization',exact:true}).click();
    await page.waitForFunction(()=>window.testBuilder.designs[0].enhanced);
    assert.deepEqual(await page.evaluate(()=>window.testBuilder.designs.map(d=>[d.widthIn,d.heightIn])),dims);
    assert.equal(await card.getByRole('button',{name:'Reset image',exact:true}).count(),1);
    page.once('dialog', dialog=>dialog.accept());
    await card.getByRole('button',{name:'Reset image',exact:true}).click();
    await page.waitForFunction(()=>window.testBuilder.designs[0].trimmed.w===120 && !window.testBuilder.designs[0].wasEdited);
    assert.equal(await card.getByRole('button',{name:'Reset image',exact:true}).count(),0);
    await card.getByRole('spinbutton',{name:'Width',exact:true}).fill('2');
    assert.match(await card.locator('.source-quality').innerText(),/60 PPI/);
    assert.equal(await page.evaluate(()=>window.testBuilder.designs[0].trimmed.canvas===window.testBuilder.designs[0].originalCanvas && window.testBuilder.designs[0].trimRect.w===111),true);
    assert.match(await card.locator('.source-quality').innerText(),/Active source: 120 × 80 px/);
    // Show full card at both widths, with overflow checks against rendered bounds.
    for(const width of [1440,375,320]) {
      await page.setViewportSize({width,height:1100});
      await card.scrollIntoViewIfNeeded();
      const geometry=await card.evaluate(el=>{
        const r=el.getBoundingClientRect();
        return {overflow:el.scrollWidth>el.clientWidth+1,bad:[...el.querySelectorAll('button,input,p')].filter(c=>{if(!c.getClientRects().length)return false;const b=c.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1}).map(c=>c.textContent),pageOverflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.equal(geometry.overflow,false,JSON.stringify(geometry));assert.deepEqual(geometry.bad,[]);assert.equal(geometry.pageOverflow,false);
      await card.screenshot({path:path.join(outputDir, 'card-'+width+'.png')});
    }
    await card.getByRole('button',{name:'Optimize for Print',exact:true}).click();
    await page.locator('[data-enhancement]').selectOption('force');
    await page.getByRole('button',{name:'Apply optimization',exact:true}).click();
    await page.waitForFunction(()=>window.testBuilder.designs[0].enhanced);
    for(const width of [1440,375,320]) {
      await page.setViewportSize({width,height:1100}); await card.scrollIntoViewIfNeeded();
      const geometry=await card.evaluate(el=>{
        const r=el.getBoundingClientRect(), reset=el.querySelector('.reset-image-btn'), close=el.querySelector('.design-remove-x');
        return {overflow:el.scrollWidth>el.clientWidth+1,resetVisible:!!reset&&reset.getClientRects().length>0,closeLabel:close&&close.getAttribute('aria-label'),bad:[...el.querySelectorAll('button,input,p')].filter(c=>{if(!c.getClientRects().length)return false;const b=c.getBoundingClientRect();return b.left<r.left-1||b.right>r.right+1}).map(c=>c.textContent)};
      });
      assert.equal(geometry.overflow,false,JSON.stringify(geometry));assert.equal(geometry.resetVisible,true);assert.match(geometry.closeLabel,/^Remove /);assert.deepEqual(geometry.bad,[]);
      await card.screenshot({path:path.join(outputDir, 'card-edited-'+width+'.png')});
    }
    const layoutTests=await page.evaluate(()=>{
      const t=window.testBuilder, results=[];
      function check(ok,label){if(!ok)throw Error(label);results.push(label)}
      function validate(placements,w,h,gap){
        for(const p of placements){
          if(p.x<0||p.y<0||p.x+p.w>w+1e-8||p.y+p.h>h+1e-8)throw Error('out of bounds');
          if(p.w!==(p.inst.rotation===0?p.inst.baseW:p.inst.baseH)||p.h!==(p.inst.rotation===0?p.inst.baseH:p.inst.baseW))throw Error('changed dimensions');
          for(const q of placements){if(p===q)continue;if(!(p.x+p.w+gap<=q.x+1e-8||q.x+q.w+gap<=p.x+1e-8||p.y+p.h+gap<=q.y+1e-8||q.y+q.h+gap<=p.y+1e-8))throw Error('overlap or spacing');}
        }
      }
      check(t.packSheet([{baseW:100,baseH:100}],100,100,10,false).placements.length===1,'exact sheet-sized piece fits with inter-piece spacing');
      check(t.packSheet([{baseW:70,baseH:40}],50,80,0,false).placements.length===0,'automatic rotation can be disabled');
      check(t.packSheet([{baseW:70,baseH:40}],50,80,0,true).placements.length===1,'optional 90-degree rotation permits fit');
      const gapCase=t.packSheet([{baseW:60,baseH:100},{baseW:40,baseH:40},{baseW:40,baseH:40}],100,100,0,false);
      check(gapCase.placements.length===3,'smaller pieces fill a tall piece’s side gap');
      let seed=53;function rand(){seed=(seed*1664525+1013904223)>>>0;return seed/4294967296}
      for(let run=0;run<100;run++){
        const gap=run%8, items=Array.from({length:40},(_,id)=>({id,baseW:5+Math.floor(rand()*85),baseH:5+Math.floor(rand()*85)}));
        let remaining=items,pieces=[];
        while(remaining.length){const packed=t.packSheet(remaining,100,100,gap,run%2===0);if(!packed.placements.length)throw Error('fit failure');validate(packed.placements,100,100,gap);pieces.push(...packed.placements);remaining=packed.unplaced;}
        if(new Set(pieces.map(p=>p.inst.id)).size!==items.length||pieces.length!==items.length)throw Error('quantity mismatch');
      }
      results.push('100 seeded packing trials: 4,000 pieces; quantities, sizes, gaps, bounds and non-overlap verified');
      const d=t.designs[0];d.qty=4;d.widthIn=2;d.heightIn=2;
      t.appendDesignToCurrentLayout(d);
      check(t.instances.length===4 && t.sheets.length>1,'Add packs exact quantity onto additional sheets');
      d.qty=3;d.widthIn=1;d.heightIn=1;
      t.designs.push({...d,id:999,qty:2});
      t.appendDesignToCurrentLayout(t.designs[1]);
      check(t.instances.length===5 && t.instances.filter(i=>i.designId===d.id).length===3,'adding a batch rebuilds all current requested quantities');
      check(t.instances.every(i=>i.baseW===100&&i.baseH===100),'adding a batch refreshes previous dimensions');
      check(t.sheets.length===1,'batches packed together on one sheet');
      t.appendDesignToCurrentLayout(d);
      check(t.instances.length===5,'repeated Add does not duplicate quantities');
      for(const sheet of t.sheets)validate(sheet.placements,sheet.widthPx,sheet.heightPx,sheet.gapPx);
      t.renderAllDesigns();
      return results;
    });
    await page.getByRole('button',{name:'Arrange on sheet',exact:true}).click();
    await page.waitForFunction(()=>window.testBuilder.instances.length===5 && !document.getElementById('packBtn').disabled);
    assert.equal(await page.evaluate(()=>window.testBuilder.sheets.reduce((n,s)=>n+s.placements.length,0)),5);
    const imported = await page.evaluate(async(pngBase64) => {
      const bytes = Uint8Array.from(atob(pngBase64), char => char.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/png' });
      window.postMessage({ type: 'SMART_SHEET_LIBRARY_IMPORT', fileName: 'library-import.png', blob }, location.origin);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const design = window.testBuilder.designs.find((item) => item.file.name === 'library-import.png');
      if (!design) throw Error('library design was not routed through the upload path');
      design.widthIn = 1; design.heightIn = 1; design.qty = 1;
      window.testBuilder.appendDesignToCurrentLayout(design);
      const hasInstance = window.testBuilder.instances.some((item) => item.designId === design.id && item.canvas === design.trimmed.canvas);
      const rendered = window.testBuilder.sheets.some((sheet) => sheet.placements.some((placement) => placement.inst.designId === design.id));
      return { hasInstance, rendered, width: design.trimmed.w, height: design.trimmed.h, originalWidth: design.originalCanvas.width, originalHeight: design.originalCanvas.height, trimmed: design.autoTrimApplied };
    }, png);
    assert.deepEqual(imported, { hasInstance: true, rendered: true, width: 111, height: 80, originalWidth: 120, originalHeight: 80, trimmed: true });
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({protectedBlocks:'unchanged',imageTests,ui:'Enhance/Undo, physical size, live PPI, no overflow at 1440/375/320px',libraryImport:'Library PNG passed through the normal source-preserving upload, layout, and render path',layoutTests,pageErrors:errors},null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});

