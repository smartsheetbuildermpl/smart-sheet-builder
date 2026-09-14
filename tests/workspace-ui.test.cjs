const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const baseUrl = process.env.SMART_SHEET_TEST_URL || 'http://localhost:3000';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tests-'));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = []; let consumes = 0;
  try {
    async function setup(admin = false) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => localStorage.setItem('smart-sheet-builder-v53b-session', JSON.stringify({ accessToken: 'test-token' })));
      await page.route('**/api/auth/me', r => r.fulfill({ json: { configured: true, usage: { email: admin ? 'masterprintlabcorp@gmail.com' : 'mpl.smartsheetbuilder@gmail.com', signedIn: true, unlimited: true, isAdmin: admin, canManageLibrary: admin, plan: admin ? 'admin' : 'free', label: admin ? 'Admin' : 'Basic account', remaining: null } } }));
      await page.route('**/api/export/consume', r => { consumes++; return r.fulfill({ json: { allowed: true } }); });
      await page.goto(baseUrl);
      const png = await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 120; c.height = 80;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#268477'; ctx.beginPath(); ctx.arc(60,40,35,0,2*Math.PI); ctx.fill();
        ctx.fillStyle = '#f4bd59'; ctx.beginPath(); ctx.arc(60,40,14,0,2*Math.PI); ctx.fill();
        return c.toDataURL().split(',')[1];
      });
      await page.route('**/test-library-source.png', async r => { await new Promise(resolve => setTimeout(resolve, 200)); return r.fulfill({ contentType:'image/png', body:Buffer.from(png,'base64') }); });
      await page.route('**/api/library?*', r => r.fulfill({ json: { configured:true,canManageLibrary:admin,categories:[{id:'floral',name:'Floral'}], designs:[{id:'flower',name:'Soft flower',categoryId:'floral',category:'Floral',tags:['summer'],widthPx:120,heightPx:80,visible:true,imageUrl:`${baseUrl}/test-library-source.png`}] } }));
      const frame = page.frameLocator('iframe'); await frame.locator('#openDesignLibrary').waitFor();
      const doc = page.frames().find(f => f.url().includes('builder.html'));
      await frame.locator('#langToggleEN').click();
      for (const [id,v] of [['dpi','100'],['sheetWidth','6'],['sheetLength','6'],['gapNumber','0.2']]) await frame.locator('#'+id).fill(v);
      await frame.locator('#gapNumber').blur();
      await frame.locator('#autoRotate').uncheck();
      await frame.locator('#openDesignLibrary').click();
      await page.getByRole('button',{name:'+ Add to sheet',exact:true}).waitFor();
      return {page,frame,doc};
    }
    const {page,frame,doc} = await setup();
    const snapshot = () => doc.evaluate(() => window.smartSheetWorkspace.snapshot());
    const waitCount = n => doc.waitForFunction(n => window.smartSheetWorkspace.snapshot().sheets.reduce((n,s)=>n+s.placements.length,0)===n,n);
    assert.equal(await page.locator('.library-admin').count(),0);
    await page.getByLabel('Search designs or tags').fill('missing'); assert.equal(await page.locator('.library-design').count(),0);
    await page.getByLabel('Search designs or tags').fill('summer');
    await page.getByRole('button',{name:'Preview Soft flower'}).click();
    await page.getByRole('button',{name:'Close design preview'}).click();
    const add = page.getByRole('button',{name:'+ Add to sheet',exact:true});
    await add.click(); assert(await add.isDisabled(),'duplicate additions disabled while loading'); await waitCount(1);
    await add.click(); await waitCount(2);
    const initial = await snapshot();
    assert.equal(initial.sheets[0].placements[0].sourceWidth,120); assert.equal(initial.sheets[0].placements[0].sourceHeight,80);
    assert.equal(initial.sheets[0].placements[0].w,120); assert.equal(consumes,0);
    async function dragAt(x,y,valid) {
      const canvas = frame.locator('.sheet-block:not([hidden]) canvas.sheet-canvas');
      const box = await canvas.boundingBox();
      const thumb = await page.getByRole('button',{name:'Preview Soft flower'}).boundingBox();
      const target = {x:box.x+x/600*box.width,y:box.y+y/600*box.height};
      await page.mouse.move(thumb.x+thumb.width/2,thumb.y+thumb.height/2); await page.mouse.down();
      await page.mouse.move(thumb.x+thumb.width/2+12,thumb.y+thumb.height/2,{steps:4});
      await page.mouse.move(target.x,target.y,{steps:20}); await page.mouse.move(target.x+1,target.y,{steps:2});
      await page.screenshot({path:path.join(output,'drag-debug.png')});
      await frame.locator('.library-drop-outline.'+(valid?'valid':'invalid')).waitFor({timeout:5000}); await page.mouse.up();
    }
    await dragAt(350,210,true); await waitCount(3);
    let state = await snapshot(), drop=state.sheets[0].placements.at(-1);
    assert(Math.abs(drop.x-290)<=3 && Math.abs(drop.y-170)<=3,'drop physical coordinates');
    assert.deepEqual(state.sheets[0].placements.slice(0,2),initial.sheets[0].placements,'earlier placements unchanged');
    const beforeInvalid=await snapshot(); await dragAt(350,210,false); assert.deepEqual(await snapshot(),beforeInvalid);
    await dragAt(5,150,false); assert.deepEqual(await snapshot(),beforeInvalid);
    await frame.locator('#sw-zoom').selectOption('2');
    await frame.locator('.canvas-wrap').evaluate(el=>{el.scrollLeft=180;el.scrollTop=700;});
    await dragAt(290,350,true); await waitCount(4);
    drop=(await snapshot()).sheets[0].placements.at(-1);
    assert(Math.abs(drop.x-230)<=3 && Math.abs(drop.y-310)<=3,'zoom and scrolling coordinates');
    await frame.locator('#sw-zoom').selectOption('1');
    await frame.locator('#sw-width').fill('1'); await frame.locator('#sw-quantity').fill('2');
    await frame.getByRole('button',{name:'Apply',exact:true}).click(); await waitCount(5);
    await frame.locator('#sw-rotate').click(); assert.equal((await snapshot()).sheets[0].placements.find(p=>p.id===drop.id).rotation,90);
    await frame.locator('#sw-remove').click(); await waitCount(4);
    const saved=await snapshot(); await page.screenshot({path:path.join(output,'workspace-desktop.png')});
    await page.getByRole('button',{name:'Close Design Library'}).click(); await frame.locator('#openDesignLibrary').waitFor();
    assert.deepEqual(await snapshot(),saved); await frame.locator('#openDesignLibrary').click(); assert.deepEqual(await snapshot(),saved);
    await frame.locator('#sw-arrange').click(); await waitCount(4); state=await snapshot();
    for(const s of state.sheets)for(const p of s.placements){
      assert(p.x>=0&&p.y>=36&&p.x+p.w<=s.width&&p.y+p.h<=s.height);
      for(const q of s.placements)if(p.id!==q.id)assert(p.x+p.w+s.gap<=q.x||q.x+q.w+s.gap<=p.x||p.y+p.h+s.gap<=q.y||q.y+q.h+s.gap<=p.y);
    }
    await page.setViewportSize({width:375,height:812}); await page.getByRole('tab',{name:'Library',exact:true}).click();
    assert.equal(await frame.locator('#sw-arrange').isVisible(),false); await add.click(); await waitCount(5);
    assert.equal(await page.getByRole('tab',{name:'Sheet',exact:true}).getAttribute('aria-selected'),'true');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(output,'workspace-mobile-sheet.png')});
    await page.getByRole('tab',{name:'Library',exact:true}).click(); await page.screenshot({path:path.join(output,'workspace-mobile-library.png')});
    await page.getByRole('tab',{name:'Sheet',exact:true}).click(); await frame.locator('#sw-arrange').focus(); await page.keyboard.press('Escape');
    await page.locator('.builder-workspace:not(.is-open)').waitFor();
    assert(await frame.locator('#openDesignLibrary').evaluate(e=>e===document.activeElement)); await page.close();
    const admin=await setup(true); await admin.page.getByText('Manage library',{exact:false}).click();
    await admin.page.getByRole('heading',{name:'Upload PNG',exact:true}).waitFor(); assert.equal(await admin.page.locator('.library-admin').count(),1); await admin.page.close();
    assert.deepEqual(errors,[]);
    console.log('Workspace checks passed: native drag/drop at Fit and 200%, scrolling, invalid drops, repeated additions, size/quantity/rotation/removal, packing, source dimensions, persistence, mobile tabs, Escape/focus, admin visibility. Screenshots: '+output);
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
