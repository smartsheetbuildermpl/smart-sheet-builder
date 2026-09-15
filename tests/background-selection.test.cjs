const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const source=fs.readFileSync('public/background-editor.js','utf8');
const before=execFileSync('git',['show','729540d:public/background-editor.js'],{encoding:'utf8'});
const currentWand=source.slice(source.indexOf('    function coverage('),source.indexOf('    function applySelection('));
const previousWand=before.slice(before.indexOf('    function coverage('),before.indexOf('    function eraseSelection('));
assert.equal(currentWand,previousWand,'Magic Wand coverage, tolerance, connectivity and preview selection unchanged');
// Inspect only in this browser-local test page. No production test hooks.
const editor=source.replace('    function applySelection(target) {','    window.selectionTest={get mask(){return selection.slice()},get pixels(){return pixels.data.slice()}};\n    function applySelection(target) {');
const builder=fs.readFileSync('public/builder.html','utf8').replace(/\}\)\(\);\s*<\/script>/,'window.selectionBuilder={get designs(){return designs},get sheets(){return sheets},get instances(){return instances},downloadPng,downloadTiff};})();</script>');
const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'background-selection-'));
const internetLogo=process.env.BG_LOGO_PATH;
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://localhost:4196/**',r=>{
      const name=new URL(r.request().url()).pathname;
      if(name==='/background-editor.js')return r.fulfill({body:editor,contentType:'text/javascript'});
      if(name==='/internet-logo.png'&&internetLogo)return r.fulfill({body:fs.readFileSync(internetLogo),contentType:'image/png'});
      if(/^\/(background-editor|print-optimizer|sheet-workspace)\.(js|css)$/.test(name))return r.fulfill({body:fs.readFileSync('public'+name),contentType:name.endsWith('js')?'text/javascript':'text/css'});
      return r.fulfill({body:builder,contentType:'text/html'});
    });
    await page.goto('http://localhost:4196/builder.html');
    const fixture=await page.evaluate(async useInternet=>{
      const c=document.createElement('canvas');c.width=320;c.height=200;const ctx=c.getContext('2d',{willReadFrequently:true});
      ctx.fillStyle='white';ctx.fillRect(0,0,320,200);
      // Known dirt is fully inside the visibly selected area, far from artwork.
      for(let i=0;i<24;i++){const value=[214,218,222,230,245,255][i%6];ctx.fillStyle=`rgb(${value},${value},${value})`;ctx.fillRect(10+i*12,10+(i%3)*8,5,5);ctx.fillRect(10+i*12,172+(i%3)*5,4,4);}
      if(useInternet){const img=new Image();img.src='/internet-logo.png';await img.decode();ctx.drawImage(img,50,65);}
      else{
        ctx.fillStyle='#174d98';ctx.fillRect(65,60,190,90);
        // Enclosed white glyphs and a line must survive contiguous selection.
        ctx.fillStyle='white';ctx.fillRect(95,80,6,40);ctx.fillRect(101,80,18,6);ctx.fillRect(101,98,18,6);ctx.fillRect(113,80,6,24);ctx.fillRect(130,80,6,40);ctx.fillRect(136,114,18,6);ctx.fillRect(170,95,60,3);
      }
      window.selectionFixture=c.toDataURL();return selectionFixture;
    },!!internetLogo);
    await page.locator('#fileInput').setInputFiles({name:internetLogo?'Internet-logo-noisy-white-background.png':'Logo-with-enclosed-white-glyphs.png',mimeType:'image/png',buffer:Buffer.from(fixture.split(',')[1],'base64')});
    await page.waitForFunction(()=>selectionBuilder.designs.length===1);
    const card=page.locator('.design-item').first();
    const act=name=>page.locator('.bg-editor').getByRole('button',{name,exact:true});
    const open=async()=>{await card.getByRole('button',{name:'Edit Background',exact:true}).click();await page.locator('.bg-editor[open]').waitFor();};
    const idle=()=>page.waitForFunction(()=>document.querySelector('.bg-editor').getAttribute('aria-busy')==='false');
    async function click(x,y){const box=await page.locator('.bg-stage').boundingBox();const dims=await page.locator('.bg-image').evaluate(c=>[c.width,c.height]);await page.mouse.click(box.x+(x+.5)*box.width/dims[0],box.y+(y+.5)*box.height/dims[1]);await idle();}
    const select=async()=>{await open();await page.locator('#bg-tolerance').evaluate(e=>{e.value='32';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));});await click(2,2);};
    await select();
    const maskStats=await page.evaluate(()=>{
      window.selectedMask=selectionTest.mask;window.selectedBefore=selectionTest.pixels;
      let fractional=0,selected=0;for(const value of selectedMask){if(value)selected++;if(value&&value<255)fractional++;}
      if(!selectedMask[12*320+12]||selectedMask[12*320+12]===255)throw Error('Dirt must have fractional preview coverage to reproduce the old bug');
      window.verifyRemoval=(data)=>{
        let interior=0,boundary=0,unselected=0;
        for(let p=0;p<selectedMask.length;p++){
          if(!selectedMask[p]){for(let c=0;c<4;c++)if(data[p*4+c]!==selectedBefore[p*4+c])throw Error('Unselected foreground changed');unselected++;continue;}
          let edge=false;const x=p%320,y=Math.floor(p/320);
          for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx>=0&&nx<320&&ny>=0&&ny<200){const q=ny*320+nx;if(!selectedMask[q]&&selectedBefore[q*4+3])edge=true;}}
          if(!edge||selectedMask[p]===255){if(data[p*4+3]!==0)throw Error('Selected interior retained alpha at '+x+','+y);interior++;}
          else{const expected=Math.round(selectedBefore[p*4+3]*(1-selectedMask[p]/255));if(data[p*4+3]!==expected)throw Error('Boundary feather changed');boundary++;}
        }
        return {interior,boundary,unselected};
      };
      return {selected,fractional};
    });
    assert(maskStats.fractional>0);assert.equal(await page.evaluate(()=>selectionBuilder.designs[0].trimmed.canvas.toDataURL()),fixture);
    if(!internetLogo)assert(await page.evaluate(()=>[85*320+97,115*320+145,96*320+180].every(p=>selectedMask[p]===0&&selectedBefore[p*4+3]===255)),'white glyphs and line are outside the selected mask');
    await act('Erase selection').click();
    const erased=await page.evaluate(()=>{const data=selectionTest.pixels;window.erasedPixels=data;return verifyRemoval(data);});
    assert.equal(await page.locator('.bg-overlay').getAttribute('data-selected-pixels'),'0');
    await act('Undo').click();assert(await page.evaluate(()=>selectionTest.pixels.every((v,i)=>v===selectedBefore[i])&&selectionTest.mask.every((v,i)=>v===selectedMask[i])));
    await act('Redo').click();assert(await page.evaluate(()=>selectionTest.pixels.every((v,i)=>v===erasedPixels[i])));
    await act('Restore Brush').click();await page.locator('#bg-size').evaluate(e=>{e.value='8';e.dispatchEvent(new Event('input',{bubbles:true}));});await click(12,12);
    assert.equal(await page.evaluate(()=>selectionTest.pixels[(12*320+12)*4+3]),255,'Restore Brush recovers removed dirt from untouched upload');
    await act('Reset editor changes').click();assert(await page.evaluate(()=>selectionTest.pixels.every((v,i)=>v===selectedBefore[i])&&selectionTest.mask.every(v=>v===0)));
    await act('Cancel').click();assert.equal(await page.evaluate(()=>selectionBuilder.designs[0].trimmed.canvas.toDataURL()),fixture);
    // Capture the full-resolution callback before existing crop recalculation.
    await page.evaluate(()=>{const real=openBackgroundEditor;window.openBackgroundEditor=opts=>{const apply=opts.apply;opts.apply=c=>{window.appliedFullCanvas=c;apply(c);};return real(opts);};});
    await select();await act('Apply background removal').click();await page.waitForFunction(()=>!document.querySelector('.bg-editor'));
    const applied=await page.evaluate(()=>{
      const data=appliedFullCanvas.getContext('2d').getImageData(0,0,320,200).data;
      const stats=verifyRemoval(data);const d=selectionBuilder.designs[0],r=d.sourceRect,active=d.trimmed.canvas.getContext('2d').getImageData(0,0,d.trimmed.w,d.trimmed.h).data;
      for(let y=0;y<d.trimmed.h;y++)for(let x=0;x<d.trimmed.w;x++)for(let k=0;k<4;k++)if(active[(y*d.trimmed.w+x)*4+k]!==data[((y+r.y)*320+x+r.x)*4+k])throw Error('Active export crop differs from applied RGBA');
      return {stats,samples:[12*320+12,20*320+24,180*320+24].map(p=>data[p*4+3]),w:d.trimmed.w,h:d.trimmed.h};
    });
    assert.deepEqual(applied.samples,[0,0,0]);assert.deepEqual(applied.stats,erased,'Erase selection and direct Apply share the same mask rule');
    // Composite the actual encoded PNG, not the preview overlay.
    const composites=await page.evaluate(async()=>{
      const blob=await new Promise(r=>appliedFullCanvas.toBlob(r,'image/png')),img=await createImageBitmap(blob),outputs=[];
      for(const background of ['black','red','checkerboard']){
        const c=document.createElement('canvas');c.width=320;c.height=200;const ctx=c.getContext('2d');
        if(background==='checkerboard'){for(let y=0;y<200;y+=10)for(let x=0;x<320;x+=10){ctx.fillStyle=(x/10+y/10)%2?'#cccccc':'white';ctx.fillRect(x,y,10,10);}}
        else{ctx.fillStyle=background;ctx.fillRect(0,0,320,200);}
        const backdrop=ctx.getImageData(0,0,320,200).data;ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,320,200).data;
        for(let y=0;y<200;y++)for(let x=0;x<320;x++)if(y<45||y>160){const at=(y*320+x)*4;for(let k=0;k<4;k++)if(data[at+k]!==backdrop[at+k])throw Error('Residual dirt on '+background+' at '+x+','+y);}
        outputs.push({background,png:c.toDataURL()});
      }return outputs;
    });
    for(const c of composites)fs.writeFileSync(path.join(artifacts,c.background+'.png'),Buffer.from(c.png.split(',')[1],'base64'));
    // Use the normal Add path at one source pixel per export pixel.
    await card.getByRole('spinbutton',{name:'Width',exact:true}).fill(String(applied.w/300));
    await card.getByRole('spinbutton',{name:'Height',exact:true}).fill(String(applied.h/300));
    await page.locator('#sheetWidth').fill('2');await page.locator('#sheetLength').fill('2');
    await card.getByRole('button',{name:'Add to layout',exact:true}).click();
    await page.waitForFunction(()=>selectionBuilder.sheets.length>0);
    const rendered=await page.evaluate(()=>{const d=selectionBuilder.designs[0],s=selectionBuilder.sheets[0],p=s.placements[0];if(p.inst.canvas!==d.trimmed.canvas)throw Error('Export uses a different source');return {w:s.renderCanvas.width,h:s.renderCanvas.height,rgba:Array.from(s.renderCanvas.getContext('2d').getImageData(0,0,s.renderCanvas.width,s.renderCanvas.height).data)};});
    const pngEvent=page.waitForEvent('download');await page.evaluate(()=>selectionBuilder.downloadPng(selectionBuilder.sheets[0],0));
    const pngBytes=fs.readFileSync(await(await pngEvent).path());
    const pngPixels=await page.evaluate(async b64=>{const im=await createImageBitmap(await(await fetch('data:image/png;base64,'+b64)).blob()),c=document.createElement('canvas');c.width=im.width;c.height=im.height;c.getContext('2d').drawImage(im,0,0);return Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data);},pngBytes.toString('base64'));
    assert.deepEqual(pngPixels,rendered.rgba,'PNG preserves edited full-resolution sheet RGBA');
    const event=page.waitForEvent('download');await page.evaluate(()=>selectionBuilder.downloadTiff(selectionBuilder.sheets[0],0,{mode:'tarp_normal',machine:'Tarpaulin',baseMode:'rgb',spotNames:[],normalAlpha:true,label:'Normal TIFF'}));
    const bytes=fs.readFileSync(await(await event).path()),ifd=bytes.readUInt32LE(4),tags={};
    for(let n=0;n<bytes.readUInt16LE(ifd);n++){const at=ifd+2+n*12,tag=bytes.readUInt16LE(at),type=bytes.readUInt16LE(at+2),count=bytes.readUInt32LE(at+4);if(![3,4].includes(type))continue;const size=type===3?2:4,pos=count*size<=4?at+8:bytes.readUInt32LE(at+8);tags[tag]=Array.from({length:count},(_,i)=>type===3?bytes.readUInt16LE(pos+i*size):bytes.readUInt32LE(pos+i*size));}
    assert.deepEqual(Buffer.concat(tags[273].map((offset,i)=>bytes.subarray(offset,offset+tags[279][i]))),Buffer.from(rendered.rgba),'TIFF preserves same fully transparent RGBA source');
    page.once('dialog',d=>d.accept());await card.getByRole('button',{name:'Reset image',exact:true}).click();assert.equal(await page.evaluate(()=>selectionBuilder.designs[0].trimmed.canvas.toDataURL()),fixture);
    assert.deepEqual(errors,[]);console.log(JSON.stringify({fixture:internetLogo?'public Python logo on noisy white background':'synthetic enclosed white glyph logo',maskStats,applied,artifacts,checks:'unchanged Wand; exact selected-interior alpha zero; unselected pixels preserved; Undo/Redo/Restore/Reset/Cancel; PNG on black/red/checkerboard; actual PNG/TIFF exports'},null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
