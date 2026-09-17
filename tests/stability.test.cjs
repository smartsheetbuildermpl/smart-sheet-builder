const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const hook = `
  window.stability={history:layoutHistory,get sheets(){return sheets},get instances(){return instances},get designs(){return designs},
    add:appendDesignToCurrentLayout,autoBG:removeConnectedEdgeBackground,render:renderAllSheets,select:function(id){selectedInstanceIds=new Set([id]);renderAllSheets();},
    signature:function(){return JSON.stringify(sheets.map(s=>[s.widthPx,s.heightPx,s.placements.map(p=>[p.inst.id,p.inst.designId,p.x,p.y,p.w,p.h,p.inst.rotation,p.inst.manualSheet])]))},
    seed:function(){
      for(const [id,value] of Object.entries({dpi:30,sheetWidth:23,sheetLength:39,gapNumber:0.1,edgeAllowanceNumber:0.3}))document.getElementById(id).value=value;
      getSheetPixelSettings();const c=document.createElement('canvas');c.width=48;c.height=24;c.getContext('2d').fillRect(0,0,48,24);
      designs=[{id:1,file:{name:'200 pieces.png'},qty:200,widthIn:.8,heightIn:.4,trimmed:{canvas:c,w:48,h:24},vibrance:0,lockAspect:true}];
      instances=Array.from({length:200},(_,i)=>({id:i+1,designId:1,canvas:c,baseW:24,baseH:12,rotation:0,vibrance:0,manualSheet:0}));
      sheets=[{widthPx:690,heightPx:1170,headerHeightPx:11,gapPx:3,autoEdgeAllowancePx:9,placements:instances.map((inst,i)=>({inst,x:9+(i%10)*30,y:18+Math.floor(i/10)*18,w:24,h:12}))}];
      instanceIdCounter=201;manualMode=false;selectedInstanceIds.clear();renderAllDesigns();renderAllSheets();
    }};
  const drawOriginal=drawSheetCanvas,overlayOriginal=renderOverlayFor;window.draws=0;window.overlays=0;
  drawSheetCanvas=function(){window.draws++;return drawOriginal.apply(this,arguments)};
  renderOverlayFor=function(){window.overlays++;return overlayOriginal.apply(this,arguments)};
`;
const html=fs.readFileSync('public/builder.html','utf8').replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4198/**',r=>{
      const p=new URL(r.request().url()).pathname;
      if(/^\/(sheet-workspace|print-optimizer|background-editor)\.(js|css)$/.test(p))return r.fulfill({body:fs.readFileSync('public'+p),contentType:p.endsWith('.js')?'text/javascript':'text/css'});
      return r.fulfill({body:html,contentType:'text/html'});
    });
    await page.goto('http://localhost:4198');await page.evaluate(()=>stability.seed());
    assert.equal(await page.evaluate(()=>stability.history.capture().sheets.some(s=>'renderCanvas' in s)),false,'history must not retain full sheet render buffers');
    assert.equal(await page.evaluate(()=>stability.history.capture().sheets.some(s=>'exportUi' in s)),false,'history must not retain detached sheet DOM trees');
    assert.equal(await page.evaluate(()=>stability.history.capture().instances.some(i=>'canvas' in i)),false,'history must not retain per-instance image buffers');
    const before=await page.evaluate(()=>stability.signature());
    const handle=page.locator('.drag-handle[data-instance-id="1"]');await handle.scrollIntoViewIfNeeded();
    const box=await handle.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
    await page.mouse.move(x,y);await page.mouse.down();
    await page.evaluate(()=>{draws=overlays=0;window.frames=[];window.frameStart=performance.now();window.frameLoop=()=>{const now=performance.now();frames.push(now-frameStart);frameStart=now;window.frameId=requestAnimationFrame(frameLoop);};frameId=requestAnimationFrame(frameLoop);});
    await page.mouse.move(x+450,y+180,{steps:100});
    const during=await page.evaluate(()=>{cancelAnimationFrame(frameId);return {draws,overlays,frames,signature:stability.signature()};});
    assert.equal(during.signature,before,'drag must not mutate model before release');
    assert.equal(during.draws,0,'no sheet raster draw during movement');assert.equal(during.overlays,0,'no DOM overlay rebuild during movement');
    await page.mouse.up();
    const moved=await page.evaluate(()=>stability.signature());assert.notEqual(moved,before);
    assert.equal(await page.evaluate(()=>draws),1,'one sheet draw on release');
    await page.getByRole('button',{name:'Undo layout',exact:true}).click();assert.equal(await page.evaluate(()=>stability.signature()),before);
    await page.getByRole('button',{name:'Redo layout',exact:true}).click();assert.equal(await page.evaluate(()=>stability.signature()),moved);
    await page.getByRole('button',{name:'Rotate selected',exact:true}).click();
    const rotated=await page.evaluate(()=>stability.signature());assert.notEqual(rotated,moved);
    await page.evaluate(()=>{const d={...stability.designs[0],id:2,file:{name:'incoming.png'},qty:3};stability.designs.push(d);stability.add(d);});
    const added=await page.evaluate(()=>stability.signature());assert.equal(await page.evaluate(()=>stability.instances.length),203);
    await page.getByRole('button',{name:'Arrange on sheet',exact:true}).click();await page.waitForFunction(()=>!document.getElementById('packBtn').disabled);
    const arranged=await page.evaluate(()=>stability.signature());
    await page.evaluate(()=>stability.select(stability.instances[0].id));
    await page.getByRole('button',{name:'Remove selected pieces',exact:true}).click();
    const removed=await page.evaluate(()=>stability.signature());assert.equal(await page.evaluate(()=>stability.instances.length),202);
    for(const state of [arranged,added,rotated,moved,before]){
      await page.getByRole('button',{name:'Undo layout',exact:true}).click();assert.equal(await page.evaluate(()=>stability.signature()),state);
    }
    for(const state of [moved,rotated,added,arranged,removed]){
      await page.getByRole('button',{name:'Redo layout',exact:true}).click();assert.equal(await page.evaluate(()=>stability.signature()),state);
    }
    await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>stability.signature()),arranged);
    await page.keyboard.press('Control+Shift+z');assert.equal(await page.evaluate(()=>stability.signature()),removed);
    // Inputs retain native text Undo and cannot accidentally revert the sheet.
    await page.locator('#customerName').fill('Sample');await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>stability.signature()),removed);
    // Whole-sheet creation/removal is part of the same Add transaction.
    await page.evaluate(()=>{const d={...stability.designs[0],id:3,file:{name:'large.png'},widthIn:22,heightIn:38,qty:1};stability.designs.push(d);stability.add(d);});
    assert.equal(await page.evaluate(()=>stability.sheets.length),2);
    await page.getByRole('button',{name:'Undo layout',exact:true}).click();assert.equal(await page.evaluate(()=>stability.sheets.length),1);
    await page.getByRole('button',{name:'Redo layout',exact:true}).click();assert.equal(await page.evaluate(()=>stability.sheets.length),2);
    // Physical boundary and collision rejection on the regular builder too.
    await page.evaluate(()=>stability.seed());
    await handle.scrollIntoViewIfNeeded();const b=await handle.boundingBox();
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();
    await page.mouse.move(b.x+b.width/2+b.width*1.25,b.y+b.height/2,{steps:15});await page.mouse.up();
    assert.equal(await page.evaluate(()=>stability.sheets[0].placements[0].x),9,'invalid collision drop reverted');
    await handle.scrollIntoViewIfNeeded();const edgeBox=await handle.boundingBox();
    await page.mouse.move(edgeBox.x+edgeBox.width/2,edgeBox.y+edgeBox.height/2);await page.mouse.down();
    await page.mouse.move(edgeBox.x-100,edgeBox.y-100,{steps:10});await page.mouse.up();
    assert.deepEqual(await page.evaluate(()=>{const p=stability.sheets[0].placements[0];return [p.x,p.y]}),[0,0],'manual drag can reach physical edges');
    // Repeat movement on an actual 23 × 39 inch / 300 DPI sheet canvas.
    await page.evaluate(()=>{
      stability.seed();const sheet=stability.sheets[0];
      for(const key of ['widthPx','heightPx','headerHeightPx','gapPx','autoEdgeAllowancePx'])sheet[key]*=10;
      for(const p of sheet.placements){for(const key of ['x','y','w','h'])p[key]*=10;p.inst.baseW*=10;p.inst.baseH*=10;}
      stability.render();
    });
    await handle.scrollIntoViewIfNeeded();const fullBox=await handle.boundingBox();
    const fullBefore=await page.evaluate(()=>stability.signature());
    await page.mouse.move(fullBox.x+fullBox.width/2,fullBox.y+fullBox.height/2);await page.mouse.down();
    await page.evaluate(()=>{draws=overlays=0;frames=[];frameStart=performance.now();frameId=requestAnimationFrame(frameLoop);});
    await page.mouse.move(fullBox.x+450,fullBox.y+180,{steps:100});
    const fullDuring=await page.evaluate(()=>{cancelAnimationFrame(frameId);return {draws,overlays,frames,signature:stability.signature(),width:stability.sheets[0].renderCanvas.width,height:stability.sheets[0].renderCanvas.height};});
    assert.deepEqual([fullDuring.width,fullDuring.height],[6900,11700]);
    assert.equal(fullDuring.signature,fullBefore);assert.equal(fullDuring.draws,0);assert.equal(fullDuring.overlays,0);
    await page.keyboard.press('Escape');await page.mouse.up();
    assert.equal(await page.evaluate(()=>stability.signature()),fullBefore,'Escape cancels a full-resolution drag');
    await page.evaluate(()=>stability.seed());
    // Edge-connected removal: a thin near-background outline previously within
    // 2× feather tolerance let the fill leak into same-color enclosed details.
    const background=await page.evaluate(()=>{
      const results=[];
      for(const light of [true,false]){
        const c=document.createElement('canvas');c.width=c.height=80;const ctx=c.getContext('2d');
        ctx.fillStyle=light?'white':'black';ctx.fillRect(0,0,80,80);
        ctx.fillStyle=light?'rgb(235,235,235)':'rgb(20,20,20)';ctx.fillRect(15,15,50,50);
        ctx.fillStyle=light?'white':'black';ctx.fillRect(17,17,46,46);
        ctx.fillStyle='red';ctx.fillRect(32,25,12,30);
        const original=ctx.getImageData(0,0,80,80).data,result=stability.autoBG(c,20),after=result.canvas.getContext('2d').getImageData(0,0,80,80).data;
        let removed=0,protectedPixels=0;
        for(let y=0;y<80;y++)for(let x=0;x<80;x++){
          const p=y*80+x,i=p*4,inside=x>=15&&x<65&&y>=15&&y<65;
          if(inside){for(let k=0;k<4;k++)if(after[i+k]!==original[i+k])throw Error('enclosed artwork changed');if(result.mask[p])throw Error('interior selected');protectedPixels++;}
          else{if(after[i+3]!==0||result.mask[p]!==255)throw Error('outside mask not exact');removed++;}
        }
        window.autoFixture=c;results.push({background:light?'white':'black',removed,protectedPixels});
      }return results;
    });
    await page.evaluate(()=>{window.autoApplied=null;openBackgroundEditor({canvas:autoFixture,original:autoFixture,sourceRect:{x:0,y:0,w:80,h:80},name:'Safety fixture',autoTolerance:20,autoRemove:stability.autoBG,apply:c=>window.autoApplied=c});});
    await page.locator('.bg-advanced summary').click();
    await page.getByRole('button',{name:'Auto-remove edge background',exact:true}).click();
    assert.match(await page.locator('.bg-status').innerText(),/selection ready/);
    assert.equal(await page.locator('.bg-image').evaluate(c=>c.getContext('2d').getImageData(0,0,1,1).data[3]),255,'automatic preview must not erase before Apply');
    assert.equal(Number(await page.locator('.bg-overlay').getAttribute('data-selected-pixels')),3900);
    await page.getByRole('button',{name:'Apply background removal',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>{const ctx=autoApplied.getContext('2d');return [ctx.getImageData(0,0,1,1).data[3],ctx.getImageData(20,20,1,1).data[3]]}),[0,255]);
    assert.deepEqual(errors,[]);
    const frames=during.frames.filter(n=>n>0).sort((a,b)=>a-b);
    const fullFrames=fullDuring.frames.filter(n=>n>0).sort((a,b)=>a-b);
    console.log(JSON.stringify({drag:{pieces:200,pointerSteps:100,fullSheetDrawsDuringMove:during.draws,overlayRebuildsDuringMove:during.overlays,frames:frames.length,medianFrameMs:frames[Math.floor(frames.length/2)],p95FrameMs:frames[Math.floor(frames.length*.95)]},fullResolutionDrag:{sheet:[fullDuring.width,fullDuring.height],pieces:200,fullSheetDrawsDuringMove:fullDuring.draws,overlayRebuildsDuringMove:fullDuring.overlays,medianFrameMs:fullFrames[Math.floor(fullFrames.length/2)],p95FrameMs:fullFrames[Math.floor(fullFrames.length*.95)],escape:'unchanged'},background,history:'drag / rotate / add / arrange / remove, all undo+redo states exact; shortcuts; new sheet; collisions; manual flush edges'},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
