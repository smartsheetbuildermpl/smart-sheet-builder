const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const base = process.env.SMART_SHEET_TEST_URL || 'http://localhost:3115';
const out = process.env.SMART_SHEET_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-design-'));
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', r => r.fulfill({ json: { configured: true, usage: { signedIn: false, label: 'Guest trial', remaining: 2, limit: 2, used: 0 } } }));
    await page.goto(base);
    const frame = page.frameLocator('#workspace-sheet');
    await frame.locator('#fileInput').waitFor();
    const native = page.frames().find(f => f.url().includes('/builder.html'));
    const dock = await frame.locator('#dock-tab-sheet').count();
    if (dock) await frame.locator('#dock-tab-sheet').click();
    await frame.locator('#sheetWidth').fill('23');
    await frame.locator('#sheetLength').fill('12');
    if (dock) await frame.locator('#dock-tab-designs').click();
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 900; c.height = 600;
      const x = c.getContext('2d'); x.fillStyle = '#122944'; x.fillRect(20, 20, 860, 560);
      x.strokeStyle = '#39b4c7'; x.lineWidth = 8; x.strokeRect(44, 44, 812, 512);
      x.fillStyle = '#fff'; x.font = 'bold 72px sans-serif'; x.textAlign = 'center'; x.fillText('PRINT SAMPLE', 450, 285);
      x.fillStyle = '#65ccdb'; x.font = '26px sans-serif'; x.fillText('Full-resolution PNG · verification fixture', 450, 355);
      return c.toDataURL().split(',')[1];
    });
    await frame.locator('#fileInput').setInputFiles({ name: 'print-sample.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await frame.locator('.design-item').waitFor();
    await frame.locator('.design-item input[type=number]').first().fill('12');
    await frame.locator('#packBtn').click();
    await native.waitForFunction(() => !document.getElementById('packBtn').disabled && document.querySelectorAll('.drag-handle').length === 12);
    await frame.locator('.sheet-canvas').waitFor();
    await page.screenshot({ path: path.join(out, 'builder-desktop.png'), fullPage: true });
    await frame.getByRole('button', { name: 'Optimize for Print', exact: true }).click();
    await frame.locator('.print-optimizer[open]').waitFor();
    await native.waitForFunction(() => !document.querySelector('.print-optimizer [data-apply]').disabled);
    await page.screenshot({ path: path.join(out, 'optimizer-modal.png'), fullPage: true });
    await frame.locator('.print-optimizer').getByRole('button', { name: 'Cancel', exact: true }).click();
    if (dock) {
      const before = await native.evaluate(() => JSON.stringify(smartSheetWorkspace.snapshot()));
      for (const tab of ['sheet', 'output', 'designs']) await frame.locator('#dock-tab-' + tab).click();
      await frame.locator('#dock-collapse').click();
      assert(await frame.locator('.layout-grid').evaluate(e => e.classList.contains('dock-collapsed')));
      await frame.locator('#dock-collapse').click();
      assert.equal(await native.evaluate(() => JSON.stringify(smartSheetWorkspace.snapshot())), before, 'tabs and collapse preserve every placement');
      await frame.locator('#dock-tab-sheet').focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await frame.locator('#dock-tab-output').getAttribute('aria-selected'), 'true');
      await frame.locator('#dock-output-links button').first().click();
      assert(await frame.locator('.download-row button').first().evaluate(e => e === document.activeElement), 'Output links focus the existing export action');
      await frame.locator('#dock-tab-designs').click();
    }
    await page.locator('.access-reveal-handle').hover();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.screenshot({ path: path.join(out, 'account-desktop.png'), fullPage: true });
    await page.getByRole('button', { name: 'Close account' }).click();
    await page.setViewportSize({ width: 390, height: 780 });
    await page.mouse.move(1, 770);
    await page.waitForTimeout(700);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await native.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(out, 'builder-mobile.png'), fullPage: true });
    if (dock) {
      for (const viewport of [{width:1280,height:480},{width:390,height:600}]) {
        await page.setViewportSize(viewport);
        await frame.getByRole('button',{name:'Add to layout',exact:true}).click({trial:true});
        const add = await frame.getByRole('button',{name:'Add to layout',exact:true}).boundingBox();
        const arrange = await frame.locator('#packBtn').boundingBox();
        assert(add.y + add.height <= arrange.y, 'scrolled Add remains above Arrange footer');
        await frame.locator('#dock-tab-sheet').click();
        await frame.locator('#edgeAllowanceNumber').click({trial:true});
        await frame.locator('#dock-tab-output').click();
        await frame.locator('#dpi').click({trial:true});
        await frame.locator('#dock-tab-designs').click();
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: guest builder upload/arrange, unchanged placement state across UI tabs/collapse, keyboard tabs, optimizer/account modal, mobile bounds. Screenshots: ' + out);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
