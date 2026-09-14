const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const source = fs.readFileSync('public/builder.html','utf8');
const hook = 'window.bgTest={get designs(){return designs},get instances(){return instances},get sheets(){return sheets},drawSheetCanvas,downloadTiff,downloadPng,appendDesignToCurrentLayout,imageSourceRect};';
const html = source.replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(),'background-editor-'));

(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const errors=[];
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4184/**',route=>{
      const name=new URL(route.request().url()).pathname;
      if(/^\/(background-editor|sheet-workspace)\.(js|css)$/.test(name)) return route.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('.js')?'text/javascript':'text/css'});
      return route.fulfill({body:html,contentType:'text/html'});
    });
    await page.goto('http://localhost:4184/builder.html');
    const png=await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=160;c.height=120;
      const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(20,20,120,80);
      ctx.fillStyle='rgb(245,245,245)';ctx.fillRect(95,20,20,40);
      ctx.fillStyle='rgb(200,30,70)';ctx.fillRect(65,20,30,80);
      ctx.clearRect(70,50,5,5);ctx.fillStyle='rgba(200,30,70,0.31)';ctx.fillRect(70,50,5,5);
      return c.toDataURL().split(',')[1];
    });
    await page.locator('#fileInput').setInputFiles({name:'Gradient-background-with-soft-artwork.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    await page.waitForFunction(()=>bgTest.designs.length===1);
    const original=await page.evaluate(()=>({active:bgTest.designs[0].trimmed.canvas.toDataURL(),original:bgTest.designs[0].originalCanvas.toDataURL(),size:[bgTest.designs[0].widthIn,bgTest.designs[0].heightIn]}));
    await page.evaluate(()=>{document.getElementById('sheetWidth').value=2;document.getElementById('sheetLength').value=2;bgTest.appendDesignToCurrentLayout(bgTest.designs[0]);});
    const initialLayout=await page.evaluate(()=>smartSheetWorkspace.snapshot());
    const open=async()=>{await page.getByRole('button',{name:'Edit Background',exact:true}).click();await page.locator('.bg-editor[open]').waitFor();};
    const editor=page.locator('.bg-editor');
    const act=name=>editor.getByRole('button',{name,exact:true});
    const idle=()=>page.waitForFunction(()=>document.querySelector('.bg-editor').getAttribute('aria-busy')==='false');
    const selected=()=>page.locator('.bg-overlay').evaluate(e=>Number(e.dataset.selectedPixels));
    async function clickPixel(x,y){const box=await page.locator('.bg-stage').boundingBox();const size=await page.locator('.bg-image').evaluate(e=>[e.width,e.height]);await page.mouse.click(box.x+x*box.width/size[0],box.y+y*box.height/size[1]);await idle();}
    const rgba=(x,y,layer='.bg-image')=>page.locator(layer).evaluate((c,[x,y])=>Array.from(c.getContext('2d').getImageData(x,y,1,1).data),[x,y]);
    const slider=async(id,value)=>{await page.locator(id).evaluate((e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));},String(value));await idle();};
    await open();
    assert(await page.locator('#bg-antialias').isChecked());
    await slider('#bg-tolerance',0);
    await clickPixel(10,10);
    const leftCount=await selected();assert(leftCount>3000);
    assert.deepEqual(await rgba(10,10),[255,255,255,255],'wand preview leaves pixels untouched');
    assert((await rgba(10,10,'.bg-overlay'))[3]>0);
    assert.equal((await rgba(110,10,'.bg-overlay'))[3],0,'contiguous wand cannot cross the red artwork');
    assert.equal(await page.evaluate(()=>bgTest.designs[0].trimmed.canvas.toDataURL()),original.active,'active source unchanged before Apply');
    await clickPixel(110,10);assert(await selected()>leftCount,'multiple clicks add selection');
    assert((await rgba(80,10,'.bg-overlay'))[3]>0 && (await rgba(80,10,'.bg-overlay'))[3]<140,'anti-alias selection has fractional coverage on near colors');
    await page.locator('#bg-antialias').uncheck();await idle();assert.equal((await rgba(80,10,'.bg-overlay'))[3],0);
    const exactCount=await selected();await slider('#bg-tolerance',12);assert(await selected()>exactCount,'tolerance reselects the last seed');
    await act('Undo').click();assert.equal(await selected(),exactCount);await act('Redo').click();assert(await selected()>exactCount);
    await page.locator('#bg-mode').selectOption('subtract');await idle();await clickPixel(10,10);assert.equal((await rgba(10,10,'.bg-overlay'))[3],0,'subtract removes a selected region');
    await act('Reset editor changes').click();assert.equal(await selected(),0);
    await page.locator('#bg-mode').selectOption('add');await page.locator('#bg-contiguous').uncheck();await slider('#bg-tolerance',0);
    await clickPixel(10,10);assert((await rgba(110,10,'.bg-overlay'))[3]>0,'noncontiguous mode selects matching disconnected backgrounds');
    await act('Clear selection').click();await act('Erase Brush').click();await slider('#bg-size',12);
    const artBefore=await rgba(60,40);await clickPixel(60,40);assert.equal((await rgba(60,40))[3],0);
    await act('Undo').click();assert.deepEqual(await rgba(60,40),artBefore);await act('Redo').click();assert.equal((await rgba(60,40))[3],0);
    await act('Restore Brush').click();await clickPixel(60,40);assert.deepEqual(await rgba(60,40),artBefore,'restore uses full uploaded source with crop offset');
    // A continuous brush gesture at zoom must not leave holes between pointer events.
    await act('Zoom in').click();await act('Erase Brush').click();
    async function strokeAt(x1,y1,x2,y2){const r=await page.locator('.bg-stage').boundingBox();const scale=r.width/122;await page.mouse.move(r.x+x1*scale,r.y+y1*scale);await page.mouse.down();await page.mouse.move(r.x+x2*scale,r.y+y2*scale,{steps:5});await page.mouse.up();}
    await strokeAt(55,40,65,60);assert.equal((await rgba(60,50))[3],0);
    await act('Restore Brush').click();await strokeAt(55,40,65,60);assert.deepEqual(await rgba(60,50),artBefore,'restore stroke does not erase its own previous dabs');
    await act('Fit').click();
    await act('Erase Brush').click();await clickPixel(60,40);
    await act('Cancel').click();assert.equal(await editor.count(),0);
    assert.equal(await page.evaluate(()=>bgTest.designs[0].trimmed.canvas.toDataURL()),original.active);
    assert.deepEqual(await page.evaluate(()=>smartSheetWorkspace.snapshot()),initialLayout);
    await open();
    assert.equal(await act('Auto-remove edge background').count(),1);
    assert.equal(await act('Remove tiny specks').count(),1);
    await act('Auto-remove edge background').click();
    assert.match(await page.locator('.bg-status').innerText(),/Automatic edge background cleanup/);
    await act('Cancel').click();
    await open();await act('Magic Wand').click();await slider('#bg-tolerance',0);await clickPixel(10,10);
    await act('Erase selection').click();assert.equal((await rgba(10,10))[3],0);assert.equal(await selected(),0);
    await act('Restore Brush').click();await slider('#bg-size',6);await clickPixel(10,10);assert.equal((await rgba(10,10))[3],255,'restoration after wand deletion');
    await act('Undo').click();assert.equal((await rgba(10,10))[3],0);
    // Cancel selection edits, then Apply a pending selection directly (without Erase selection).
    await act('Reset editor changes').click();await act('Magic Wand').click();await clickPixel(10,10);
    await page.screenshot({path:path.join(artifacts,'desktop-selection.png')});
    await act('Apply background removal').click();assert.equal(await editor.count(),0);
    const applied=await page.evaluate(()=>{
      const d=bgTest.designs[0],p=bgTest.sheets[0].placements[0],c=document.createElement('canvas');
      bgTest.drawSheetCanvas(c,{widthPx:p.w,heightPx:p.h,placements:[{...p,x:0,y:0}]});
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      return {rect:bgTest.imageSourceRect(d),w:d.trimmed.w,h:d.trimmed.h,size:[d.widthIn,d.heightIn],original:d.originalCanvas.toDataURL(),changed:d.trimmed.canvas.toDataURL()!==d.originalCanvas.toDataURL(),shared:bgTest.instances.every(i=>i.canvas===d.trimmed.canvas),transparent:pixels.some((v,i)=>i%4===3&&v===0),soft:pixels.some((v,i)=>i%4===3&&v>0&&v<255)};
    });
    assert(applied.w<122 && applied.h===82,'applying recomputes transparent crop bounds');assert.deepEqual(applied.size,original.size);
    assert.equal(applied.original,original.original);assert(applied.changed&&applied.shared&&applied.transparent&&applied.soft);
    const placed=await page.evaluate(()=>smartSheetWorkspace.snapshot().sheets[0].placements[0]);
    const initial=initialLayout.sheets[0].placements[0];assert.deepEqual([placed.x,placed.y,placed.w,placed.h],[initial.x,initial.y,initial.w,initial.h]);
    // Download actual files from the edited sheet; decode their bytes, not just the thumbnail.
    const rendered=await page.evaluate(()=>{const c=bgTest.sheets[0].renderCanvas;return {w:c.width,h:c.height,rgba:Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data)};});
    const pngDownload=page.waitForEvent('download');await page.evaluate(()=>bgTest.downloadPng(bgTest.sheets[0],0));
    const pngBytes=fs.readFileSync(await(await pngDownload).path());
    const decoded=await page.evaluate(async base64=>{const b=new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'image/png'}),image=await createImageBitmap(b),c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);return Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data);},pngBytes.toString('base64'));
    assert.deepEqual(decoded,rendered.rgba,'downloaded PNG retains edited sheet alpha');
    const tiffDownload=page.waitForEvent('download');await page.evaluate(()=>bgTest.downloadTiff(bgTest.sheets[0],0,{mode:'tarp_normal',machine:'Tarpaulin',baseMode:'rgb',spotNames:[],normalAlpha:true,label:'Normal TIFF'}));
    const bytes=fs.readFileSync(await(await tiffDownload).path()),ifd=bytes.readUInt32LE(4),tags={};
    for(let n=0;n<bytes.readUInt16LE(ifd);n++){
      const at=ifd+2+n*12,tag=bytes.readUInt16LE(at),type=bytes.readUInt16LE(at+2),count=bytes.readUInt32LE(at+4);
      if(![3,4].includes(type))continue;const size=type===3?2:4,pos=count*size<=4?at+8:bytes.readUInt32LE(at+8);
      tags[tag]=Array.from({length:count},(_,i)=>type===3?bytes.readUInt16LE(pos+i*size):bytes.readUInt32LE(pos+i*size));
    }
    assert.equal(tags[256][0],rendered.w);assert.equal(tags[257][0],rendered.h);assert.equal(tags[277][0],4);
    assert.deepEqual(Buffer.concat(tags[273].map((offset,i)=>bytes.subarray(offset,offset+tags[279][i]))),Buffer.from(rendered.rgba),'downloaded TIFF retains edited RGBA sheet');
    await open();await act('Erase Brush').click();await slider('#bg-size',6);const restoredBefore=await rgba(10,20);await clickPixel(10,20);
    await act('Restore Brush').click();await clickPixel(10,20);assert.deepEqual(await rgba(10,20),restoredBefore,'reopened editor restores the correct recropped coordinates');
    // Keyboard focus and Escape; no edits are applied by closing.
    await act('Apply background removal').focus();await page.keyboard.press('Tab');assert(await editor.getByRole('button',{name:'Close Background Editor'}).evaluate(e=>e===document.activeElement));
    await page.keyboard.press('Escape');assert.equal(await editor.count(),0);
    assert(await page.getByRole('button',{name:'Edit Background',exact:true}).evaluate(e=>e===document.activeElement));
    // Actual PNG encoding of the active source preserves alpha.
    assert(await page.evaluate(async()=>{
      const d=bgTest.designs[0],blob=await new Promise(r=>d.trimmed.canvas.toBlob(r,'image/png')),image=await createImageBitmap(blob),c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').drawImage(image,0,0);return c.toDataURL()===d.trimmed.canvas.toDataURL();
    }));
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reset image',exact:true}).click();assert.equal(await page.evaluate(()=>bgTest.designs[0].trimmed.canvas.toDataURL()),original.original,'Reset image restores the untouched upload');
    await page.getByRole('button',{name:'Enhance 2×',exact:true}).click();await page.waitForFunction(()=>bgTest.designs[0].enhanced);
    await open();await act('Erase Brush').click();await slider('#bg-size',12);const enhancedBefore=await rgba(160,140);await clickPixel(160,140);await act('Restore Brush').click();await clickPixel(160,140);assert.deepEqual(await rgba(160,140),enhancedBefore,'restore mapping also works after 2× enhancement');await act('Cancel').click();
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Reset image',exact:true}).click();
    // An all-transparent result is rejected in the modal; Cancel still recovers the page.
    await open();await act('Magic Wand').click();await page.locator('#bg-contiguous').uncheck();await slider('#bg-tolerance',255);await clickPixel(30,30);
    await act('Apply background removal').click();assert.equal(await editor.count(),1);assert.match(await page.locator('.bg-status').innerText(),/completely transparent/);await act('Cancel').click();
    assert.equal(await page.evaluate(()=>bgTest.designs[0].trimmed.canvas.toDataURL()),original.original);
    // Large-image failures leave the page and original intact.
    await page.evaluate(()=>{bgTest.designs[0].trimmed.w=8192;bgTest.designs[0].trimmed.h=8192;});
    await page.getByRole('button',{name:'Edit Background',exact:true}).click();assert.equal(await editor.count(),0);assert.match(await page.locator('.design-item [role=status]').innerText(),/memory limit/);
    await page.evaluate(()=>{const d=bgTest.designs[0];d.trimmed.w=d.trimmed.canvas.width;d.trimmed.h=d.trimmed.canvas.height;});
    for(const width of [375,320]){
      await page.setViewportSize({width,height:812});await open();
      assert(await editor.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
      await act('Zoom in').click();await act('Pan').click();
      const canvas=page.locator('.bg-stage');await canvas.focus();await page.keyboard.press('ArrowDown');
      await page.screenshot({path:path.join(artifacts,'mobile-'+width+'.png')});
      await act('Cancel').click();
    }
    const remove=page.getByRole('button',{name:/Remove Gradient-background-with-soft-artwork\.png/});
    page.once('dialog',dialog=>dialog.dismiss());await remove.click();assert.equal(await page.evaluate(()=>bgTest.designs.length),1,'dismissed removal keeps a placed design');
    page.once('dialog',dialog=>dialog.accept());await remove.click();await page.waitForFunction(()=>bgTest.designs.length===0);
    assert.equal(await page.evaluate(()=>bgTest.instances.length),0,'accepted removal clears the design and its layout pieces');
    assert.deepEqual(errors,[]);
    console.log('Background editor passed: wand overlay, tolerance, contiguous/global, anti-alias, add/subtract, brush erase/restore, Undo/Redo/reset, Cancel/Apply, crop mapping, original restoration, same export render source with soft transparency, memory rejection, keyboard focus/Escape, and mobile 375/320px. Screenshots: '+artifacts);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
