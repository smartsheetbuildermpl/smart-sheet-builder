const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

// Real builder controls and encoders, isolated from live auth/credits/storage.
const hook = `window.historyTest={history:layoutHistory,get designs(){return designs},get sheets(){return sheets},
  source:previewSource,isProxy:source=>previewBitmaps.has(source),add:appendDesignToCurrentLayout,downloadPng,downloadTiff,getExportProfile,removeDesignAndLayout,
  seed:function(exportFixture){
    dpiInput.value=exportFixture?300:100;setSheetSize(exportFixture?6:8,exportFixture?8:10);
    gapNumber.value='.1';edgeAllowanceNumber.value='.1';getSheetPixelSettings();
    var c=document.createElement('canvas');c.width=3200;c.height=1600;var ctx=c.getContext('2d');
    ctx.fillStyle='#123451';ctx.fillRect(0,0,3200,1600);ctx.clearRect(0,0,120,120);
    ctx.fillStyle='#20a8bc';ctx.fillRect(120,120,2960,1360);ctx.fillStyle='#fff';ctx.font='bold 160px Arial';ctx.fillText('FULL RESOLUTION',680,860);
    designs=[{id:1,file:{name:'History test artwork.png'},originalCanvas:c,trimmed:{canvas:c,w:3200,h:1600},
      widthIn:exportFixture?5:3,heightIn:exportFixture?2.5:1.5,aspect:2,qty:exportFixture?1:2,vibrance:0,lockAspect:true,previewUrl:thumbnailUrl(c)}];
    instances=[];sheets=[];manualMode=false;instanceIdCounter=1;selectedInstanceIds.clear();renderAllDesigns();renderStartupSheetPreview();
  },
  state:function(){return {settings:captureLayoutSettings(),dpi:dpiGlobal,manual:manualMode,
    sheets:sheets.map(s=>({width:s.widthPx,height:s.heightPx,gap:s.gapPx,edge:s.autoEdgeAllowancePx,
      pieces:s.placements.map(p=>[p.inst.id,p.inst.designId,p.x,p.y,p.w,p.h,p.inst.baseW,p.inst.baseH,p.inst.rotation,p.inst.layoutLocked||false,p.inst.placedSizeIn])})),
    selected:Array.from(selectedInstanceIds),summary:statsOut.textContent,details:sheetStatsOut.textContent};},
  select:function(id){selectedInstanceIds=new Set([id]);renderAllSheets();},
  moveUnlocked:function(){sheets.forEach(s=>s.placements.forEach(p=>{if(!p.inst.layoutLocked){p.y+=200;p.inst.manualY=p.y;}}));renderAllSheets();},
  raster:async function(){var c=document.createElement('canvas');drawSheetCanvas(c,sheets[0]);var data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(n=>n.toString(16).padStart(2,'0')).join('');}
};exportDelivery=SmartSheetExportDelivery.create({gate:async()=>({allowed:true,authorization:'history-fixture-only'}),save:saveExportBlob});`;
const html = fs.readFileSync('public/builder.html','utf8').replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
function tiffTags(bytes) {
  const tags={},at=bytes.readUInt32LE(4);
  for(let n=0;n<bytes.readUInt16LE(at);n++) {
    const p=at+2+n*12,type=bytes.readUInt16LE(p+2),count=bytes.readUInt32LE(p+4),value=bytes.readUInt32LE(p+8);
    if(count===1)tags[bytes.readUInt16LE(p)]=type===5?bytes.readUInt32LE(value)/bytes.readUInt32LE(value+4):type===3?bytes.readUInt16LE(p+8):value;
  }
  return tags;
}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const output=process.env.HISTORY_TEST_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'layout-history-'));
  fs.mkdirSync(output,{recursive:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await require('./preflight-review-helper.cjs')(page);
    await page.route('http://localhost:4231/**',r=>{
      const p=new URL(r.request().url()).pathname;
      return r.fulfill({body:p==='/'?html:fs.readFileSync('public'+p),contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});
    });
    const state=()=>page.evaluate(()=>historyTest.state());
    const undo=()=>page.getByRole('button',{name:'Undo layout',exact:true}).click();
    const redo=()=>page.getByRole('button',{name:'Redo layout',exact:true}).click();
    const geometry=s=>s.sheets;
    async function cycle(before,after){await undo();assert.deepEqual(geometry(await state()),geometry(before));await redo();assert.deepEqual(geometry(await state()),geometry(after));}
    async function fresh(exportFixture=false){await page.goto('http://localhost:4231/');await page.evaluate(e=>historyTest.seed(e),exportFixture);}
    // Wait on the real rendered Add button (the design card is replaced on Add).
    async function addBatch(){await page.getByRole('button',{name:'Add to layout',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.design-item button')).some(b=>b.textContent==='Add to layout'&&!b.disabled));}
    await fresh();assert(await page.locator('#layoutUndo').isDisabled());assert(await page.locator('#layoutRedo').isDisabled());
    await addBatch();const first=await state();assert.equal(first.sheets[0].pieces.length,2);
    await page.locator('.design-item').getByRole('spinbutton',{name:'Width',exact:true}).fill('2');await addBatch();
    const batch=await state();assert.equal(batch.sheets[0].pieces.length,4);await cycle(first,batch);

    // Drag: unchanged until release, exactly one reversible action.
    await page.evaluate(()=>historyTest.select(1));
    const beforeDrag=await state(),handle=page.locator('.drag-handle[data-instance-id="1"]');
    await handle.scrollIntoViewIfNeeded();let box=await handle.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2+570,{steps:50});
    assert.deepEqual(geometry(await state()),geometry(beforeDrag));await page.mouse.up();
    const moved=await state();assert.notDeepEqual(geometry(moved),geometry(beforeDrag));
    await page.screenshot({path:path.join(output,'01-moved.png'),fullPage:true});
    await undo();assert.deepEqual(geometry(await state()),geometry(beforeDrag));await page.screenshot({path:path.join(output,'02-undone.png'),fullPage:true});
    await redo();assert.deepEqual(geometry(await state()),geometry(moved));await page.screenshot({path:path.join(output,'03-redone.png'),fullPage:true});

    // Resize is also a pointer transaction; no geometry mutation mid-gesture.
    const grip=page.locator('.drag-handle[data-instance-id="1"] .resize-handle.se');
    await grip.scrollIntoViewIfNeeded();box=await grip.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
    await page.mouse.move(box.x+65,box.y+35,{steps:20});assert.deepEqual(geometry(await state()),geometry(moved));await page.mouse.up();
    const resized=await state();assert.notDeepEqual(geometry(resized),geometry(moved));await cycle(moved,resized);
    await page.locator('#rotateSelectedBtn').click();const rotated=await state();assert.notDeepEqual(geometry(rotated),geometry(resized));await cycle(resized,rotated);

    await page.locator('#duplicateSelectedPieces').click();const duplicated=await state();
    const oldPiece=rotated.sheets[0].pieces.find(p=>p[0]===1),copy=duplicated.sheets.flatMap(s=>s.pieces).find(p=>p[0]===duplicated.selected[0]);
    assert.deepEqual(copy.slice(4,9),oldPiece.slice(4,9),'duplicate retains dimensions and rotation');
    assert.equal(duplicated.sheets.flatMap(s=>s.pieces).length,5);await cycle(rotated,duplicated);
    await page.locator('#removeSelectedPieces').click();const deleted=await state();await cycle(duplicated,deleted);
    assert.equal(deleted.selected.length,0);assert.equal(await page.locator('.resize-handle').count(),0);

    // Both Arrange modes restore exact prior geometry and summaries, without
    // calling a packer during Undo/Redo. Move unlocked pieces to make reflow real.
    for(const mode of ['standard','max-fill']){
      await page.selectOption('#arrangeMode',mode);await page.evaluate(()=>historyTest.moveUnlocked());const before=await state();
      await page.locator('#packBtn').click();await page.waitForFunction(()=>!document.getElementById('packBtn').disabled);
      const after=await state();assert.notDeepEqual(geometry(after),geometry(before));await cycle(before,after);
      assert.equal((await state()).summary,after.summary);assert.equal((await state()).details,after.details);
    }

    await page.getByRole('tab',{name:'Sheet',exact:true}).click();
    for(const [id,value] of [['gapNumber','0.25'],['edgeAllowanceNumber','0.4'],['sheetWidth','9'],['sheetLength','12']]){
      const before=await state();await page.locator('#'+id).fill(value);await page.locator('#'+id).blur();const after=await state();
      await undo();assert.deepEqual(await state(),before);await redo();assert.deepEqual(await state(),after);
    }
    for(const id of ['autoRotate','autoExtend']){
      const before=await state();await page.locator('#'+id).uncheck();const after=await state();
      await undo();assert.deepEqual(await state(),before);await redo();assert.deepEqual(await state(),after);
    }
    // Slider movements within one interaction coalesce; returning to the
    // initial spacing is a no-op. Redo is cleared by a new actual action.
    const beforeSlider=await state();await page.locator('#gap').focus();
    await page.locator('#gap').evaluate(el=>{for(const n of [.3,.4,.5]){el.value=n;el.dispatchEvent(new Event('input',{bubbles:true}));}el.dispatchEvent(new Event('change',{bubbles:true}));});
    const afterSlider=await state();await undo();assert.deepEqual(await state(),beforeSlider);await redo();assert.deepEqual(await state(),afterSlider);
    await undo();await page.locator('#gapNumber').fill('.35');await page.locator('#gapNumber').blur();assert(await page.locator('#layoutRedo').isDisabled());
    const beforeNoop=await state(),title=await page.locator('#layoutUndo').getAttribute('title');
    await page.locator('#gap').focus();await page.locator('#gap').evaluate(el=>{for(const n of [.5,.35]){el.value=n;el.dispatchEvent(new Event('input',{bubbles:true}));}el.blur();});
    assert.deepEqual(await state(),beforeNoop);assert.equal(await page.locator('#layoutUndo').getAttribute('title'),title);

    // Native text editing and other tools keep their own keyboard history.
    for(const markup of ['<input>','<textarea></textarea>','<div contenteditable><span>Editable</span></div>','<div contenteditable="plaintext-only">Editable</div>']){
      const before=await state();await page.evaluate(markup=>{const host=document.createElement('div');host.id='editable-fixture';host.innerHTML=markup;document.body.prepend(host);host.firstElementChild.focus();},markup);
      for(const shortcut of ['Control+z','Control+Shift+z','Control+y','Meta+z'])await page.keyboard.press(shortcut);
      assert.deepEqual(await state(),before);await page.locator('#editable-fixture').evaluate(e=>e.remove());
    }
    const beforeModal=await state();await page.evaluate(()=>{const d=document.createElement('dialog');d.id='history-tool-dialog';d.tabIndex=-1;document.body.appendChild(d);d.showModal();d.focus();});
    await page.keyboard.press('Control+z');assert.deepEqual(await state(),beforeModal);await page.locator('#history-tool-dialog').evaluate(d=>d.remove());
    await page.locator('#layoutUndo').focus();await page.keyboard.press('Control+z');const undone=await state();assert.notDeepEqual(undone,beforeModal);
    await page.keyboard.press('Control+y');assert.deepEqual(await state(),beforeModal);
    await page.keyboard.press('Meta+z');assert.deepEqual(await state(),undone);await page.keyboard.press('Meta+Shift+z');assert.deepEqual(await state(),beforeModal);

    // Uploads survive traveling past their placement. Removing an upload cannot
    // resurrect it. Latest active image/vibrance survives layout Undo as well.
    await page.evaluate(()=>{const d={...historyTest.designs[0],id:2,qty:1,widthIn:.5,heightIn:.25,file:{name:'Later upload.png'}};historyTest.designs.push(d);historyTest.add(d);});
    await undo();assert.equal(await page.evaluate(()=>historyTest.designs.length),2);await undo();assert.equal(await page.evaluate(()=>historyTest.designs.length),2);await redo();await redo();
    await page.evaluate(()=>{const d=historyTest.designs[0],c=document.createElement('canvas');c.width=c.height=64;d.trimmed={canvas:c,w:64,h:64};d.vibrance=14;});
    await undo();await redo();assert(await page.evaluate(()=>historyTest.sheets.every(s=>s.placements.every(p=>p.inst.designId!==1||p.inst.canvas===historyTest.designs[0].trimmed.canvas&&p.inst.vibrance===14))));
    await page.evaluate(()=>historyTest.removeDesignAndLayout(historyTest.designs.find(d=>d.id===2)));
    await undo();await redo();assert.equal(await page.evaluate(()=>historyTest.designs.some(d=>d.id===2)),false);

    // Multi-sheet Add is still one entry, and history is capped at 32 actions.
    await fresh();await addBatch();const beforeHandleRotate=await state();await page.locator('.rotate-btn[data-instance-id="1"]').click();const handleRotated=await state();
    assert.notDeepEqual(geometry(handleRotated),geometry(beforeHandleRotate));await undo();assert.deepEqual(await state(),beforeHandleRotate);await redo();assert.deepEqual(await state(),handleRotated);
    // Incomplete typed settings never become invalid Redo targets.
    await page.getByRole('tab',{name:'Sheet',exact:true}).click();await page.locator('#sheetWidth').fill('');await undo();await redo();assert.equal(await page.locator('#sheetWidth').inputValue(),'8');
    await fresh();await page.getByRole('spinbutton',{name:'Qty',exact:true}).fill('30');await addBatch();
    const multi=await state();assert(multi.sheets.length>1);await undo();assert.equal((await state()).sheets.length,0);await redo();assert.deepEqual(geometry(await state()),geometry(multi));
    await page.evaluate(()=>{for(let n=0;n<40;n++)historyTest.history.run('Move fixture',()=>{const p=historyTest.sheets[0].placements[0];p.x++;p.inst.manualX=p.x;});});
    let count=0;while(await page.locator('#layoutUndo').isEnabled()){await undo();count++;assert(count<=32);}assert.equal(count,32);

    // Actual exports after Undo/Redo use restored transforms + native sources.
    await fresh(true);await addBatch();const original=await state(),expected=await page.evaluate(()=>historyTest.raster());
    await page.evaluate(()=>historyTest.select(1));await page.locator('#duplicateSelectedPieces').click();await undo();
    assert.deepEqual(geometry(await state()),geometry(original));await redo();await undo();assert.equal(await page.evaluate(()=>historyTest.raster()),expected);
    await page.evaluate(()=>{window.fullDraws=0;window.proxyDraws=0;const draw=CanvasRenderingContext2D.prototype.drawImage;CanvasRenderingContext2D.prototype.drawImage=function(source,...args){if(historyTest.isProxy(source))proxyDraws++;if(source===historyTest.designs[0].trimmed.canvas)fullDraws++;return draw.call(this,source,...args);};});
    const exports={};
    for(const kind of ['png','rgb','cmyk']){
      const event=page.waitForEvent('download');await page.evaluate(kind=>kind==='png'?historyTest.downloadPng(historyTest.sheets[0],0):historyTest.downloadTiff(historyTest.sheets[0],0,historyTest.getExportProfile(kind)),kind);
      const bytes=fs.readFileSync(await(await event).path());
      if(kind==='png'){
        const png=PNG.sync.read(bytes);assert.deepEqual([png.width,png.height],[1800,2400]);assert.equal(crypto.createHash('sha256').update(png.data).digest('hex'),expected,'PNG pixels match restored full-resolution canvas');
        let at=8,physical=[];while(at<bytes.length){const n=bytes.readUInt32BE(at);if(bytes.toString('ascii',at+4,at+8)==='pHYs')physical.push([bytes.readUInt32BE(at+8),bytes.readUInt32BE(at+12),bytes[at+16]]);at+=n+12;}
        assert.deepEqual(physical,[[11811,11811,1]]);exports.png={pixels:[png.width,png.height],pHYs:physical[0]};
      }else{const tags=tiffTags(bytes);assert.deepEqual([tags[256],tags[257],tags[282],tags[283]],[1800,2400,300,300]);exports[kind]={pixels:[tags[256],tags[257]],ppi:tags[282]};}
    }
    assert.deepEqual(await page.evaluate(()=>[fullDraws,proxyDraws]),[3,0]);assert.deepEqual(errors,[]);
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'04-mobile.png')});
    console.log(JSON.stringify({passed:['drag','resize','rotate','batch Add','Standard/Max Fill exact restoration','duplicate/delete','settings and grouped slider','selection/handles','keyboard and editable/modal guards','upload/image-edit boundaries','32-action cap','multi-sheet Add','full-resolution export parity'],exports,physicalInches:[6,8],evidence:output},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
