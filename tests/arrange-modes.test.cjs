const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const source = fs.readFileSync('public/builder.html', 'utf8');
const hook = `window.arrangeModeTest={
  get designs(){return designs},get instances(){return instances},get sheets(){return sheets},
  get skipped(){return lastSkipped},get skipReason(){return lastSkipReason},get mode(){return lastArrangeMode},
  setFixture:function(qty){
    var canvas=document.createElement('canvas');canvas.width=891;canvas.height=111;
    var ctx=canvas.getContext('2d');ctx.fillStyle='#122c49';ctx.fillRect(0,0,891,111);
    ctx.fillStyle='#18a7bd';ctx.fillRect(12,12,867,87);
    var design={id:9001,file:{name:'A4-logo-fixture.png'},trimmed:{canvas:canvas,w:891,h:111},
      aspect:891/111,widthIn:3.15,heightIn:.39,qty:qty,vibrance:0,previewUrl:canvas.toDataURL()};
    designs=[design];instances=[];sheets=[];manualMode=false;lastArrangeMode=null;lastArrangeRequested=0;
    instanceIdCounter=1;renderAllDesigns();renderStartupSheetPreview();return design;
  },
  signature:function(){return JSON.stringify(sheets.map(function(s){return s.placements.map(function(p){return [p.inst.id,p.x,p.y,p.w,p.h,p.inst.rotation,!!p.inst.layoutLocked];});}));},
  report:function(){
    var total=0,area=0,sheetArea=0,rotated=0,usedBottom=0;
    sheets.forEach(function(s){total+=s.placements.length;sheetArea+=s.widthPx*s.heightPx;s.placements.forEach(function(p){area+=p.w*p.h;if(Math.abs(p.inst.rotation)%180===90)rotated++;usedBottom=Math.max(usedBottom,p.y+p.h);});});
    return {total:total,sheets:sheets.length,rotated:rotated,efficiency:sheetArea?Math.round(area/sheetArea*100):0,
      usedBottom:usedBottom,perSheet:sheets.map(function(s){return s.placements.length;}),summary:statsOut.textContent,
      details:Array.from(sheetStatsOut.children).map(function(n){return n.textContent;})};
  },
  lockFirst:function(){var p=sheets[0].placements[0];p.x=0;p.y=0;p.inst.manualX=0;p.inst.manualY=0;p.inst.manualSheet=0;p.inst.layoutLocked=true;manualMode=true;return [p.inst.id,p.x,p.y,p.w,p.h,p.inst.rotation];},
  assertGeometry:function(){
    sheets.forEach(function(s){s.placements.forEach(function(p){
      if(p.x<0||p.y<0||p.x+p.w>s.widthPx||p.y+p.h>s.heightPx)throw Error('physical boundary');
      if(!p.inst.layoutLocked&&(p.x<s.autoEdgeAllowancePx||p.y<Math.max(s.headerHeightPx,s.autoEdgeAllowancePx)||p.x+p.w>s.widthPx-s.autoEdgeAllowancePx||p.y+p.h>s.heightPx-s.autoEdgeAllowancePx))throw Error('automatic edge allowance');
      if(!((p.w===315&&p.h===39)||(p.w===39&&p.h===315)))throw Error('piece dimensions changed');
      if(p.inst.canvas!==designs[0].trimmed.canvas)throw Error('source canvas changed');
      s.placements.forEach(function(q){if(p!==q&&!(p.x+p.w<=q.x||q.x+q.w<=p.x||p.y+p.h<=q.y||q.y+q.h<=p.y))throw Error('overlap');});
    });});return true;
  },
  renderRecipe:function(){var c=document.createElement('canvas');drawSheetCanvas(c,sheets[0]);return {size:[c.width,c.height],recipe:c._ssbExportRecipe[5]};}
};`;
const html = source.replace(/\}\)\(\);\s*<\/script>/, hook + '})();</script>');
assert.notEqual(html, source, 'test hook inserted');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrange-modes-'));
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:4197/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/builder.html') return route.fulfill({ body: html, contentType: 'text/html' });
      if (/^\/(sheet-workspace|background-editor|print-optimizer|export-delivery|sheet-packing|builder-shell|workspace-theme)\.(js|css)$/.test(pathname)) {
        return route.fulfill({ body: fs.readFileSync('public' + pathname), contentType: pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
      }
      return route.fulfill({ body: '<iframe src="/builder.html"></iframe>', contentType: 'text/html' });
    });
    await page.goto('http://localhost:4197');
    await page.locator('iframe').evaluate(el => { el.style.width='100%';el.style.height='960px';el.style.border='0';document.body.style.margin='0'; });
    const frame = page.frameLocator('iframe');
    const doc = page.frames().find(item => item.url().endsWith('/builder.html'));
    await frame.locator('#arrangeMode').waitFor({state:'attached'});
    await doc.evaluate(() => {
      Object.entries({dpi:100,sheetWidth:8.3,sheetLength:11.7,gapNumber:0,edgeAllowanceNumber:.3}).forEach(([id,value])=>document.getElementById(id).value=value);
      document.getElementById('autoExtend').checked=true;document.getElementById('autoRotate').checked=true;
      arrangeModeTest.setFixture(52);
    });
    await frame.getByRole('tab',{name:'Sheet',exact:true}).click();

    await frame.getByLabel('Arrange mode').selectOption('standard');
    await frame.getByRole('button', { name:'Arrange on sheet', exact:true }).click();
    await doc.waitForFunction(() => arrangeModeTest.report().summary.startsWith('Standard:'));
    const standard = await doc.evaluate(() => arrangeModeTest.report());
    const standardSignature = await doc.evaluate(() => arrangeModeTest.signature());
    assert.deepEqual({pieces:standard.total,sheets:standard.sheets,efficiency:standard.efficiency,rotated:standard.rotated},
      {pieces:52,sheets:1,efficiency:66,rotated:0});
    assert.match(standard.summary,/Standard: 52 \/ 52 pieces placed across 1 sheet · 66% average efficiency · 0 pieces rotated/);
    assert.deepEqual(standard.details,['Sheet 1: 52 pieces · 66% efficiency']);
    assert(await doc.evaluate(() => arrangeModeTest.assertGeometry()));
    await page.screenshot({ path:path.join(artifactDir,'standard-a4.png'), fullPage:true });

    await frame.getByLabel('Arrange mode').selectOption('max-fill');
    await frame.getByRole('button', { name:'Arrange on sheet', exact:true }).click();
    await doc.waitForFunction(() => arrangeModeTest.report().summary.startsWith('Max Fill:'));
    const maxFill = await doc.evaluate(() => arrangeModeTest.report());
    const maxSignature = await doc.evaluate(() => arrangeModeTest.signature());
    assert.equal(maxFill.total,52);assert.equal(maxFill.sheets,1);assert.equal(maxFill.efficiency,66);
    assert(maxFill.rotated>0,'Max Fill did not mix orientations');
    assert(maxFill.usedBottom<standard.usedBottom,'Max Fill did not reduce used sheet length');
    assert(await doc.evaluate(() => arrangeModeTest.assertGeometry()));
    await page.screenshot({ path:path.join(artifactDir,'max-fill-a4.png'), fullPage:true });

    await frame.getByRole('button',{name:'Undo layout'}).click();
    assert.equal(await doc.evaluate(() => arrangeModeTest.signature()),standardSignature,'Undo did not restore exact Standard geometry');
    await frame.getByRole('button',{name:'Redo layout'}).click();
    assert.equal(await doc.evaluate(() => arrangeModeTest.signature()),maxSignature,'Redo did not restore exact Max Fill geometry');

    const locked = await doc.evaluate(() => arrangeModeTest.lockFirst());
    await frame.getByLabel('Arrange mode').selectOption('standard');
    await frame.getByRole('button',{name:'Arrange on sheet',exact:true}).click();
    await doc.waitForFunction(() => arrangeModeTest.report().summary.startsWith('Standard:'));
    assert.deepEqual(await doc.evaluate(id => { const p=arrangeModeTest.sheets[0].placements.find(p=>p.inst.id===id);return [p.inst.id,p.x,p.y,p.w,p.h,p.inst.rotation]; },locked[0]),locked,'manually locked placement moved');
    assert(await doc.evaluate(() => arrangeModeTest.assertGeometry()));

    const multi = await doc.evaluate(async () => {
      arrangeModeTest.setFixture(140);var select=document.getElementById('arrangeMode'),button=document.getElementById('packBtn');
      select.value='max-fill';select.dispatchEvent(new Event('change'));button.click();
      await new Promise((resolve,reject)=>{var start=performance.now();(function poll(){if(!button.disabled&&arrangeModeTest.mode==='max-fill')return resolve();if(performance.now()-start>10000)return reject(Error('arrange timeout'));setTimeout(poll,20);})();});
      arrangeModeTest.assertGeometry();return arrangeModeTest.report();
    });
    assert.equal(multi.total,140);assert.equal(multi.sheets,3);assert.deepEqual(multi.perSheet,[65,65,10]);

    const noContinuation = await doc.evaluate(async () => {
      arrangeModeTest.setFixture(70);document.getElementById('autoExtend').checked=false;
      var select=document.getElementById('arrangeMode'),button=document.getElementById('packBtn');select.value='max-fill';button.click();
      await new Promise((resolve,reject)=>{var start=performance.now();(function poll(){if(!button.disabled&&arrangeModeTest.mode==='max-fill')return resolve();if(performance.now()-start>10000)return reject(Error('arrange timeout'));setTimeout(poll,20);})();});
      return {report:arrangeModeTest.report(),skipped:arrangeModeTest.skipped,reason:arrangeModeTest.skipReason};
    });
    assert.equal(noContinuation.report.sheets,1);assert.equal(noContinuation.report.total,65);
    assert.equal(noContinuation.skipped,5);assert.equal(noContinuation.reason,'extension-disabled');
    assert.match(noContinuation.report.summary,/5 pieces remain unplaced because Create another sheet when full is off/);

    const recipe = await doc.evaluate(() => arrangeModeTest.renderRecipe());
    assert.deepEqual(recipe.size,[830,1170]);
    assert.deepEqual(recipe.recipe.map(row=>row.slice(3,9)),await doc.evaluate(()=>arrangeModeTest.sheets[0].placements.map(p=>[p.x,p.y,p.w,p.h,p.inst.baseW,p.inst.baseH])),
      'export recipe positions differ from preview placements');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({standard,maxFill,multiSheet:multi,noContinuation,exportSheet:recipe.size,screenshots:artifactDir},null,2));
  } finally {
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
