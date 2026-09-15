const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const source = fs.readFileSync('public/builder.html','utf8');
const hook = 'window.printTest={get designs(){return designs},get sheets(){return sheets},getSheetPixelSettings,drawSheetCanvas,downloadPng,downloadTiff,getExportProfile,renderAllDesigns};';
const html = source.replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(),'print-optimizer-'));

function tiff(bytes) {
  const tags={},ifd=bytes.readUInt32LE(4),sizes={1:1,2:1,3:2,4:4,5:8,7:1};
  for(let i=0;i<bytes.readUInt16LE(ifd);i++){
    const at=ifd+2+i*12,id=bytes.readUInt16LE(at),type=bytes.readUInt16LE(at+2),n=bytes.readUInt32LE(at+4),size=sizes[type];
    const offset=n*size<=4?at+8:bytes.readUInt32LE(at+8);
    tags[id]=Array.from({length:n},(_,k)=>type===3?bytes.readUInt16LE(offset+k*size):type===4?bytes.readUInt32LE(offset+k*size):type===5?bytes.readUInt32LE(offset+k*8)/bytes.readUInt32LE(offset+k*8+4):bytes[offset+k]);
  }
  return {tags,pixels:Buffer.concat(tags[273].map((offset,i)=>bytes.subarray(offset,offset+tags[279][i])))};
}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://localhost:4187/**',route=>{
      const name=new URL(route.request().url()).pathname;
      if(/^\/(background-editor|sheet-workspace|print-optimizer)\.(js|css)$/.test(name))return route.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('.js')?'text/javascript':'text/css'});
      return route.fulfill({body:html,contentType:'text/html'});
    });
    await page.goto('http://localhost:4187/builder.html');
    const checks=await page.evaluate(async()=>{
      const results=[],check=(ok,label)=>{if(!ok)throw Error(label);results.push(label);};
      const make=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
      const high=make(600,600),ctx=high.getContext('2d');
      ctx.fillStyle='#d7285d';ctx.fillRect(0,0,600,600);
      for(let x=0;x<600;x+=2){ctx.fillStyle='#175ad4';ctx.fillRect(x,0,1,600);}
      const before=high.toDataURL(),clean=await PrintOptimizer.clean(high);
      check(clean.canvas===high&&clean.canvas.toDataURL()===before,'clean 600×600 source stays byte-identical; no resample');
      check(PrintOptimizer.analyze(high,2,2).ppi===300,'high-resolution artwork reports 300 source PPI');
      const ghost=make(100,100),g=ghost.getContext('2d');g.fillStyle='#ff4000';g.fillRect(30,30,40,40);
      g.fillStyle='rgba(255,64,0,0.05)';g.fillRect(29,30,1,40); // connected faint soft edge
      g.fillStyle='#ff4000';g.fillRect(45,10,1,21); // connected thin line
      g.fillRect(1,1,1,1);g.fillStyle='rgba(255,255,255,0.01)';g.fillRect(98,98,1,1);
      const saved=ghost.toDataURL(),original=g.getImageData(0,0,100,100).data;
      const cleaned=await PrintOptimizer.clean(ghost),after=cleaned.canvas.getContext('2d').getImageData(0,0,100,100).data;
      check(cleaned.removed===2&&after[(1*100+1)*4+3]===0&&after[(98*100+98)*4+3]===0,'opaque and nearly invisible isolated outer ghost pixels removed');
      check(ghost.toDataURL()===saved,'cleanup does not mutate input');
      check(original.every((v,i)=>[101,9898].includes(Math.floor(i/4))||v===after[i]),'connected soft edges and thin line remain pixel-identical');
      const edge=make(40,40),e=edge.getContext('2d'),im=e.createImageData(40,40);
      for(let y=0;y<40;y++)for(let x=0;x<40;x++){
        const i=(y*40+x)*4,dist=Math.min(x,y,39-x,39-y),a=dist<5?0:dist<10?(dist-4)*40:255;
        im.data.set(a?[255,64,0,a]:[x%2?255:0,x%2?255:0,x%2?255:0,0],i);
      }
      e.putImageData(im,0,0);const up=await PrintOptimizer.upscale(edge,2),pixels=up.getContext('2d').getImageData(0,0,80,80).data;
      check(up.width===80&&up.height===80,'opt-in Lanczos upscales both dimensions');
      check(pixels.some((v,i)=>i%4===3&&v>0&&v<255),'Lanczos preserves semi-transparent edges');
      check(pixels.every((v,i)=>{const a=pixels[i-i%4+3];return a<32||i%4===3||Math.abs(v-[255,64,0][i%4])<=5;}),'premultiplied-alpha filtering introduces no black/white fringe on colored soft edges');
      check(PrintOptimizer.analyze(up,1,1,2).ppi===40,'smooth upscale retains honest original-detail PPI');
      let limited=false;try{await PrintOptimizer.upscale({width:8192,height:8192},2);}catch(e){limited=true;}
      check(limited,'oversized upscale refused before allocating buffers');
      window.highPng=high.toDataURL();window.ghostPng=ghost.toDataURL();window.edgePng=edge.toDataURL();return results;
    });
    const upload=async(name,data)=>page.locator('#fileInput').setInputFiles({name,mimeType:'image/png',buffer:Buffer.from(data.split(',')[1],'base64')});
    // High-frequency source cannot survive a thumbnail round-trip unchanged.
    await upload('high-resolution.png',await page.evaluate(()=>highPng));
    await page.waitForFunction(()=>printTest.designs.length===1);
    const card=page.locator('.design-item').first(),open=()=>card.getByRole('button',{name:'Optimize for Print',exact:true}).click();
    await open();await page.locator('[data-apply]').waitFor();
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.match(await page.locator('.print-result').innerText(),/300 PPI. No upscale needed/);
    assert(await page.locator('.print-upscale input').isDisabled());
    await page.locator('[data-close]').focus();await page.keyboard.press('Shift+Tab');
    assert(await page.locator('[data-apply]').evaluate(el=>el===document.activeElement),'focus wraps backward inside optimizer');
    await page.keyboard.press('Tab');
    assert(await page.locator('[data-close]').evaluate(el=>el===document.activeElement),'focus wraps forward inside optimizer');
    await page.getByRole('button',{name:'100%',exact:true}).click();
    assert.equal(await page.locator('.print-after .print-image').evaluate(c=>c.getBoundingClientRect().width),600);
    for(const width of [1440,375]){
      await page.setViewportSize({width,height:850});
      assert(await page.locator('.print-optimizer').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      await page.screenshot({path:path.join(artifacts,`optimizer-${width}.png`)});
    }
    await page.locator('[data-apply]').click();
    assert(await page.evaluate(()=>!printTest.designs[0].wasEdited&&printTest.designs[0].trimmed.canvas===printTest.designs[0].originalCanvas));
    await card.getByRole('spinbutton',{name:'Width',exact:true}).fill('4');
    await open();await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.match(await page.locator('.print-result').innerText(),/Low source quality: 150 PPI/);
    assert(!(await page.locator('.print-upscale input').isChecked()));
    await page.locator('[data-apply]').click();
    assert.equal(await page.evaluate(()=>printTest.designs[0].trimmed.w),600,'low PPI does not trigger automatic upscale');
    await open();await page.locator('.print-upscale input').check();await page.locator('[data-apply]').click();
    await page.waitForFunction(()=>!document.querySelector('.print-optimizer'));
    assert.deepEqual(await page.evaluate(()=>{const d=printTest.designs[0];return [d.trimmed.w,d.trimmed.h,d.widthIn,d.heightIn,d.nativeScale];}),[1200,1200,4,4,2]);
    assert.match(await card.locator('.source-quality').innerText(),/150 PPI/);
    await open();await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert(await page.locator('.print-upscale input').isDisabled(),'repeat upscale disabled');
    await page.getByRole('button',{name:'Undo last optimization',exact:true}).click();
    assert.equal(await page.evaluate(()=>printTest.designs[0].trimmed.w),600);
    await upload('outer-ghosts.png',await page.evaluate(()=>ghostPng));
    await page.waitForFunction(()=>printTest.designs.length===2);
    const ghostCard=page.locator('.design-item').nth(1);
    await ghostCard.getByRole('button',{name:'Optimize for Print',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    assert.match(await page.locator('.print-result').innerText(),/2 isolated outer ghost pixels removed/);
    await page.keyboard.press('Escape');
    assert(await ghostCard.getByRole('button',{name:'Optimize for Print',exact:true}).evaluate(el=>el===document.activeElement));
    assert(await page.evaluate(()=>!printTest.designs[1].wasEdited),'Escape leaves source unchanged');
    await ghostCard.getByRole('button',{name:'Optimize for Print',exact:true}).click();
    await page.locator('[data-apply]').click();
    assert(await page.evaluate(()=>printTest.designs[1].wasEdited));
    page.once('dialog',d=>d.accept());await ghostCard.getByRole('button',{name:'Reset image',exact:true}).click();
    assert(await page.evaluate(()=>printTest.designs[1].trimmed.canvas.toDataURL()===ghostPng),'Reset recovers full original PNG including removed dots');
    // Final sheet size comes from physical inches × DPI. Poison every reduced
    // preview input; the real Add path and downloads must still retain 1px detail.
    await card.getByRole('spinbutton',{name:'Width',exact:true}).fill('2');
    await page.locator('#sheetWidth').fill('3');await page.locator('#sheetLength').fill('3');
    await page.evaluate(()=>{printTest.designs[0].previewUrl='data:,';document.querySelector('.design-item img').src='data:,';});
    await card.getByRole('button',{name:'Add to layout',exact:true}).click();
    await page.waitForFunction(()=>printTest.sheets.length>0);
    await page.evaluate(()=>{const s=printTest.sheets[0];s.renderCanvas.style.width='40px';s.renderCanvas.style.height='40px';window.exportSheet=s;});
    assert.deepEqual(await page.evaluate(()=>[exportSheet.renderCanvas.width,exportSheet.renderCanvas.height]),[900,900]);
    assert(await page.evaluate(()=>exportSheet.placements[0].inst.canvas===printTest.designs[0].trimmed.canvas));
    const expected=await page.evaluate(()=>{const p=exportSheet.placements[0];return {x:p.x,y:p.y,rgba:Array.from(printTest.designs[0].trimmed.canvas.getContext('2d').getImageData(0,0,600,600).data)};});
    const pngEvent=page.waitForEvent('download');await page.evaluate(()=>printTest.downloadPng(exportSheet,0));
    const png=fs.readFileSync(await(await pngEvent).path());
    const decoded=await page.evaluate(async b64=>{const img=await createImageBitmap(await(await fetch('data:image/png;base64,'+b64)).blob());const c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);const p=exportSheet.placements[0];return {w:img.width,h:img.height,pixels:Array.from(c.getContext('2d').getImageData(p.x,p.y,600,600).data)};},png.toString('base64'));
    assert.deepEqual([decoded.w,decoded.h],[900,900]);assert.deepEqual(decoded.pixels,expected.rgba,'downloaded PNG retains every full-resolution source pixel, not 160px thumbnail or 40px CSS preview');
    for(const [machine,color,samples,photo,names] of [['dtf','rgb',4,2,['W1']],['dtf','cmyk',5,5,['W1']],['uvdtf24','rgb',5,2,['1','2']],['uvdtf24','cmyk',6,5,['1','2']],['tarpaulin','rgb',4,2,[]]]){
      // Each fixture is a fresh trial in this browser-only test; production gates are unchanged.
      await page.evaluate(()=>localStorage.removeItem('smart-sheet-builder-standalone-guest-exports'));
      const event=page.waitForEvent('download');await page.evaluate(async({machine,color})=>{document.querySelector('#machinePreset').value=machine;await printTest.downloadTiff(exportSheet,0,printTest.getExportProfile(color));},{machine,color});
      const file=tiff(fs.readFileSync(await(await event).path()));
      assert.deepEqual([file.tags[256][0],file.tags[257][0],file.tags[277][0],file.tags[262][0],file.tags[282][0],file.tags[283][0]],[900,900,samples,photo,300,300]);
      for(const name of names)assert(Buffer.from(file.tags[34377]).includes(Buffer.from(name+'\0')),`Photoshop spot ${name}`);
      if(machine==='dtf'&&color==='rgb'){
        assert.deepEqual([...file.pixels.subarray(0,4)],[255,255,255,255],'blank RGB/W1 black-background fix retained');
        for(let y=0;y<600;y++)for(let x=0;x<600;x++){
          const at=((expected.y+y)*900+expected.x+x)*4,src=(y*600+x)*4;
          for(let c=0;c<3;c++)assert.equal(file.pixels[at+c],expected.rgba[src+c],'TIFF RGB retains active full-resolution artwork');
          if(x>0&&y>0&&x<599&&y<599)assert.equal(file.pixels[at+3],0,'existing contracted W1 mask populated inside artwork');
        }
      }
    }
    // Exercise the newly optimized active source through Add, PNG and an
    // alpha-bearing TIFF, including semi-transparent colored edge pixels.
    await upload('soft-edges.png',await page.evaluate(()=>edgePng));
    await page.waitForFunction(()=>printTest.designs.length===3);
    const edgeCard=page.locator('.design-item').nth(2);
    await edgeCard.getByRole('spinbutton',{name:'Width',exact:true}).fill(await page.evaluate(()=>String(printTest.designs[2].trimmed.w/150)));
    await edgeCard.getByRole('button',{name:'Optimize for Print',exact:true}).click();
    await page.locator('[data-enhancement]').selectOption('force');
    await page.waitForFunction(()=>!document.querySelector('[data-apply]').disabled);
    const forcedCandidate=await page.locator('.print-after .print-image').evaluate(c=>c.toDataURL());
    await page.locator('[data-apply]').click();
    await page.waitForFunction(()=>printTest.designs[2].enhanced);
    assert.equal(await page.evaluate(()=>printTest.designs[2].trimmed.canvas.toDataURL()),forcedCandidate,'Force Apply uses exact full-resolution comparison candidate');
    await edgeCard.getByRole('button',{name:'Add to layout',exact:true}).click();
    await page.waitForFunction(()=>printTest.sheets.some(s=>s.placements.some(p=>p.inst.designId===printTest.designs[2].id)));
    const optimized=await page.evaluate(()=>{const d=printTest.designs[2];window.edgeSheet=printTest.sheets.find(s=>s.placements.some(p=>p.inst.designId===d.id));const p=edgeSheet.placements.find(p=>p.inst.designId===d.id);if(p.inst.canvas!==d.trimmed.canvas)throw Error('Optimized source not used');window.edgePlacement=p;return {x:p.x,y:p.y,w:d.trimmed.w,h:d.trimmed.h,rgba:Array.from(d.trimmed.canvas.getContext('2d').getImageData(0,0,d.trimmed.w,d.trimmed.h).data)};});
    await page.evaluate(()=>localStorage.removeItem('smart-sheet-builder-standalone-guest-exports'));
    const edgePngEvent=page.waitForEvent('download');await page.evaluate(()=>printTest.downloadPng(edgeSheet,0));
    const edgePng=fs.readFileSync(await(await edgePngEvent).path());
    const edgeDecoded=await page.evaluate(async({b64,w,h})=>{const img=await createImageBitmap(await(await fetch('data:image/png;base64,'+b64)).blob());const c=document.createElement('canvas');c.width=img.width;c.height=img.height;c.getContext('2d').drawImage(img,0,0);return Array.from(c.getContext('2d').getImageData(edgePlacement.x,edgePlacement.y,w,h).data);},{b64:edgePng.toString('base64'),w:optimized.w,h:optimized.h});
    assert.deepEqual(edgeDecoded,optimized.rgba,'PNG preserves optimized source RGBA including soft edges');
    const edgeTiffEvent=page.waitForEvent('download');await page.evaluate(()=>{document.querySelector('#machinePreset').value='tarpaulin';return printTest.downloadTiff(edgeSheet,0,printTest.getExportProfile('rgb'));});
    const edgeTiff=tiff(fs.readFileSync(await(await edgeTiffEvent).path()));
    for(let y=0;y<optimized.h;y++)for(let x=0;x<optimized.w;x++)for(let c=0;c<4;c++)assert.equal(edgeTiff.pixels[((optimized.y+y)*edgeTiff.tags[256][0]+optimized.x+x)*4+c],optimized.rgba[(y*optimized.w+x)*4+c],'alpha TIFF preserves optimized source RGBA');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({checks,ui:'High/low PPI, explicit opt-in, 100% inspection, responsive 1440/375, Escape/focus return, Undo, Reset, unchanged print size',exports:'900×900 at 3in/300DPI; downloaded PNG + RGB TIFF exact source pixels; DTF RGB/CMYK, UV RGB/CMYK spot resources, Tarpaulin alpha TIFF',artifacts},null,2));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
