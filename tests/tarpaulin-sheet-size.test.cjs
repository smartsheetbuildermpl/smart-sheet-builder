const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const baseline = process.argv.includes('--baseline');
const source = baseline ? execFileSync('git', ['show', 'HEAD:public/builder.html'], { encoding: 'utf8' }) : fs.readFileSync('public/builder.html', 'utf8');
const hook = `window.tarp={get sheets(){return sheets},settings:getSheetPixelSettings,downloadPng,downloadTiff,getExportProfile,
 fixture:function(w=40,h=60,qty=1){var c=document.createElement('canvas');c.width=400;c.height=600;var ctx=c.getContext('2d');ctx.fillStyle='#173451';ctx.fillRect(0,0,400,600);ctx.fillStyle='#32b6c7';ctx.fillRect(20,20,360,560);ctx.fillStyle='#173451';ctx.font='bold 30px sans-serif';ctx.fillText('40 × 60 in',90,290);
 designs=[{id:1,file:{name:'Tarpaulin regression fixture.png'},trimmed:{canvas:c,w:400,h:600},aspect:w/h,widthIn:w,heightIn:h,qty:qty,vibrance:0,previewUrl:thumbnailUrl(c)}];instances=[];sheets=[];selectedInstanceIds.clear();manualMode=false;lastArrangeMode=null;lastSkipped=0;renderAllDesigns();renderStartupSheetPreview();},
 report:function(){var c=document.querySelector('.sheet-canvas');return {ui:[getSheetWidthIn(),getSheetLengthIn()],packing:[getSheetPixelSettings().sheetWidthPx/dpiGlobal,getSheetPixelSettings().sheetLengthPx/dpiGlobal],preview:c&&c._ssbExportRecipe.slice(0,3),rulers:Array.from(document.querySelectorAll('.ruler-guide')).map(r=>r.textContent),status:statsOut.textContent,placed:sheets.reduce((n,s)=>n+s.placements.length,0),skipped:lastSkipped,sheets:sheets.map(s=>[s.widthPx,s.heightPx]),geometry:sheets.map(s=>s.placements.map(p=>[p.inst.id,p.x,p.y,p.w,p.h,p.inst.rotation]))};},
 lock:function(){var p=sheets[0].placements[0];p.x=0;p.y=0;p.inst.manualX=0;p.inst.manualY=0;p.inst.manualSheet=0;p.inst.layoutLocked=true;manualMode=true;renderAllSheets();},
 valid:function(){sheets.forEach(s=>s.placements.forEach(p=>{if(p.x<0||p.y<0||p.x+p.w>s.widthPx||p.y+p.h>s.heightPx)throw Error('boundary');if(!p.inst.layoutLocked&&(p.x<s.autoEdgeAllowancePx||p.y<Math.max(s.headerHeightPx,s.autoEdgeAllowancePx)||p.x+p.w>s.widthPx-s.autoEdgeAllowancePx||p.y+p.h>s.heightPx-s.autoEdgeAllowancePx))throw Error('edge');s.placements.forEach(q=>{if(p!==q&&!(p.x+p.w+s.gapPx<=q.x||q.x+q.w+s.gapPx<=p.x||p.y+p.h+s.gapPx<=q.y||q.y+q.h+s.gapPx<=p.y))throw Error('spacing');});}));return true;}
};exportDelivery=SmartSheetExportDelivery.create({gate:async()=>({allowed:true,authorization:'tarpaulin-test-only'}),save:saveExportBlob});`;
const html = source.replace(/\}\)\(\);\s*<\/script>/, hook + '})();</script>');
function tiffSize(bytes) { const at=bytes.readUInt32LE(4),n=bytes.readUInt16LE(at),tags={};for(let i=0;i<n;i++){const p=at+2+i*12;tags[bytes.readUInt16LE(p)]=bytes.readUInt32LE(p+8);}return [tags[256],tags[257]]; }
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'tarpaulin-size-'));
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1650}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await require('./preflight-review-helper.cjs')(page);
    await page.route('http://localhost:4213/**',r=>{const p=new URL(r.request().url()).pathname;if(p==='/builder.html')return r.fulfill({body:html,contentType:'text/html'});if(/\.(js|css)$/.test(p))return r.fulfill({body:fs.readFileSync('public'+p),contentType:p.endsWith('.js')?'text/javascript':'text/css'});return r.fulfill({body:'<style>body{margin:0}iframe{border:0;width:100%;height:1620px}</style><iframe src="/builder.html"></iframe>',contentType:'text/html'});});
  await page.goto('http://localhost:4213');const frame=page.frameLocator('iframe'),doc=page.frames().find(f=>f.url().endsWith('/builder.html'));
  await frame.locator('#machinePreset').waitFor({state:'attached'});await doc.evaluate(()=>document.getElementById('dpi').value=10);
  await frame.getByRole('tab',{name:'Sheet',exact:true}).click();await frame.locator('#machinePreset').selectOption('tarpaulin');
  await frame.locator('#sheetWidth').fill('72');await frame.locator('#sheetLength').fill('84');
  const initial=await doc.evaluate(()=>tarp.report());
  if(baseline){assert.deepEqual(initial.ui,[72,84]);assert.deepEqual(initial.packing,[63,39]);console.log(JSON.stringify({baseline:initial},null,2));return;}
  assert.deepEqual(initial.ui,[72,84]);assert.deepEqual(initial.packing,[72,84]);assert.deepEqual(initial.preview,[720,840,10]);assert.match(initial.status,/72 x 84 in/);assert.match(initial.rulers[0],/72$/);assert.match(initial.rulers[1],/84$/);
  assert.equal(await frame.locator('#sheetWidth').getAttribute('max'),null);assert.equal(await frame.locator('#sheetLength').getAttribute('max'),null);
  await frame.getByRole('button',{name:'Undo layout',exact:true}).click();await frame.getByRole('button',{name:'Undo layout',exact:true}).click();assert.deepEqual((await doc.evaluate(()=>tarp.report())).ui,[63,39]);
  await frame.getByRole('button',{name:'Redo layout',exact:true}).click();await frame.getByRole('button',{name:'Redo layout',exact:true}).click();assert.deepEqual((await doc.evaluate(()=>tarp.report())).preview,[720,840,10]);
  await frame.locator('#gapNumber').fill('0.5');
  await doc.evaluate(()=>tarp.fixture());await frame.getByRole('tab',{name:'Designs',exact:true}).click();await frame.getByRole('button',{name:'Add to layout',exact:true}).click();await doc.waitForFunction(()=>tarp.report().placed===1);assert(await doc.evaluate(()=>tarp.valid()));
  await frame.getByRole('tab',{name:'Sheet',exact:true}).click();const reports={};
  for(const mode of ['standard','max-fill']){await frame.getByLabel('Arrange mode').selectOption(mode);await frame.locator('#packBtn').click();await doc.waitForFunction(()=>!document.getElementById('packBtn').disabled);reports[mode]=await doc.evaluate(()=>tarp.report());assert.equal(reports[mode].placed,1);assert.deepEqual(reports[mode].sheets,[[720,840]]);assert(await doc.evaluate(()=>tarp.valid()));if(mode==='standard')await page.screenshot({path:path.join(output,'72x84-40x60.png')});}

  const download=page.waitForEvent('download');await doc.evaluate(()=>tarp.downloadPng(tarp.sheets[0],0));const png=PNG.sync.read(fs.readFileSync(await(await download).path()));assert.deepEqual([png.width,png.height],[720,840]);
  const tiffDownload=page.waitForEvent('download');await doc.evaluate(()=>tarp.downloadTiff(tarp.sheets[0],0,tarp.getExportProfile('rgb')));const tiff=tiffSize(fs.readFileSync(await(await tiffDownload).path()));assert.deepEqual(tiff,[720,840]);
  await doc.evaluate(()=>tarp.lock());const locked=await doc.evaluate(()=>tarp.report().geometry);
  await frame.locator('#sheetWidth').fill('80');assert.deepEqual((await doc.evaluate(()=>tarp.report())).geometry,locked);assert.deepEqual((await doc.evaluate(()=>tarp.report())).sheets,[[800,840]]);
  await frame.getByRole('button',{name:'Undo layout',exact:true}).click();assert.deepEqual((await doc.evaluate(()=>tarp.report())).ui,[72,84]);assert.deepEqual((await doc.evaluate(()=>tarp.report())).sheets,[[720,840]]);
  await frame.getByRole('button',{name:'Redo layout',exact:true}).click();assert.deepEqual((await doc.evaluate(()=>tarp.report())).ui,[80,84]);assert.deepEqual((await doc.evaluate(()=>tarp.report())).geometry,locked);
  await frame.locator('#sheetWidth').fill('72');await doc.evaluate(()=>tarp.fixture(40,60,3));await frame.getByLabel('Arrange mode').selectOption('max-fill');await frame.locator('#packBtn').click();await doc.waitForFunction(()=>!document.getElementById('packBtn').disabled);const multi=await doc.evaluate(()=>tarp.report());assert.equal(multi.placed,3);assert(multi.sheets.length>=2);assert(multi.sheets.every(s=>s.join()==='720,840'));assert(await doc.evaluate(()=>tarp.valid()));
  await doc.evaluate(()=>tarp.fixture());await frame.locator('#sheetWidth').fill('63');await frame.locator('#sheetLength').fill('39');
  for(const mode of ['standard','max-fill']){await frame.getByLabel('Arrange mode').selectOption(mode);await frame.locator('#packBtn').click();await doc.waitForFunction(()=>!document.getElementById('packBtn').disabled);const rejected=await doc.evaluate(()=>tarp.report());assert.equal(rejected.placed,0);assert.equal(rejected.skipped,1);assert.match(rejected.status,/didn't fit|unplaced/i);}
  await frame.locator('#sheetWidth').fill('72');await frame.locator('#sheetLength').fill('84');
  for(const mode of ['standard','max-fill']){await doc.evaluate(()=>tarp.fixture(80,40));await frame.locator('#autoRotate').uncheck();await frame.getByLabel('Arrange mode').selectOption(mode);await frame.locator('#packBtn').click();await doc.waitForFunction(()=>!document.getElementById('packBtn').disabled);assert.equal((await doc.evaluate(()=>tarp.report())).placed,0);await frame.locator('#autoRotate').check();await frame.locator('#packBtn').click();await doc.waitForFunction(()=>!document.getElementById('packBtn').disabled);assert.equal((await doc.evaluate(()=>tarp.report())).placed,1);assert(await doc.evaluate(()=>tarp.valid()));}
  await doc.evaluate(()=>tarp.fixture(90,90));await frame.locator('#packBtn').click();await doc.waitForFunction(()=>!document.getElementById('packBtn').disabled);assert.equal((await doc.evaluate(()=>tarp.report())).placed,0);
  for(const machine of ['dtf','uvdtf24','uvdtf12']){await frame.locator('#machinePreset').selectOption(machine);const report=await doc.evaluate(()=>tarp.report());assert.deepEqual(report.ui,report.packing);}
  assert.deepEqual(errors,[]);console.log(JSON.stringify({after:initial,modes:reports,multiSheet:multi.sheets,exports:{dpi:10,png:[png.width,png.height],tiff,physicalInches:[72,84]},history:'fields, sheet dimensions, locked geometry restored exactly',screenshot:path.join(output,'72x84-40x60.png')},null,2));
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
