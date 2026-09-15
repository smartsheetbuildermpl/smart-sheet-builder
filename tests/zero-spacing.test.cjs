const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const source = fs.readFileSync('public/builder.html', 'utf8');
const hook = 'window.zeroTest={get sheets(){return sheets},settings:getSheetPixelSettings,overlaps:computeAllOverlaps,downloadPng,downloadTiff,getExportProfile};';
const html = source.replace(/\}\)\(\);\s*<\/script>/, hook + '})();</script>');
assert.notEqual(html, source);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.route('http://localhost:4179/**', route => {
      const name = new URL(route.request().url()).pathname;
      if (name === '/builder.html') return route.fulfill({ body: html, contentType: 'text/html' });
      if (/^\/(sheet-workspace|background-editor|print-optimizer)\.(js|css)$/.test(name)) return route.fulfill({ body: fs.readFileSync('public' + name), contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css' });
      return route.fulfill({ body: `<iframe src="/builder.html"></iframe><script>window.exportsRequested=[];addEventListener('message',e=>{if(e.data.type==='SMART_SHEET_EXPORT_REQUEST'){exportsRequested.push(e.data.exportKind);e.source.postMessage({type:'SMART_SHEET_EXPORT_RESPONSE',requestId:e.data.requestId,allowed:true},e.origin)}})</script>`, contentType: 'text/html' });
    });
    await page.goto('http://localhost:4179');
    const frame = page.frameLocator('iframe');
    await frame.locator('#gapNumber').waitFor();
    const doc = page.frames().find(f => f.url().endsWith('/builder.html'));
    assert.equal(await frame.locator('#gapNumber').inputValue(), '0');
    assert.equal(await frame.locator('#gap').inputValue(), '0');
    assert.equal(await frame.locator('#edgeAllowanceNumber').inputValue(), '0.30');
    assert.equal(await doc.evaluate(() => zeroTest.settings().autoEdgeAllowancePx), 90, 'default edge allowance is 0.30 in at 300 DPI');
    for (const unit of ['cm', 'ft', 'in']) {
      await frame.locator('#measureUnit').selectOption(unit);
      assert(await frame.locator('#gapNumber').evaluate(e => e.checkValidity() && Number(e.value) === 0 && e.min === '0'));
      assert.equal(await doc.evaluate(() => zeroTest.settings().gapPx), 0);
    }
    // This suite specifically checks zero inter-piece spacing. Turn off the
    // separate auto-layout inset so its established edge-touch cases remain
    // focused on spacing rather than the new margin setting.
    await frame.locator('#edgeAllowanceNumber').fill('0');
    await frame.locator('#dpi').fill('100'); await frame.locator('#sheetWidth').fill('2'); await frame.locator('#sheetLength').fill('2.36');
    await frame.locator('#autoRotate').uncheck();
    await doc.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 100;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 100, 100); ctx.clearRect(0, 0, 3, 3);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      window.zeroFile = () => new File([blob], 'zero-gap.png', { type: 'image/png' });
      await smartSheetWorkspace.addFile(zeroFile(), { sheetIndex: 0, x: 0, y: 0 });
    });
    // A nonzero prior sheet gap must not linger when the selected spacing is zero.
    await frame.locator('#gapNumber').fill('0.2');
    const rejected = () => doc.evaluate(async () => {
      const before = JSON.stringify(smartSheetWorkspace.snapshot());
      try { await smartSheetWorkspace.addFile(zeroFile(), { sheetIndex: 0, x: 100, y: 0 }); return false; }
      catch { return before === JSON.stringify(smartSheetWorkspace.snapshot()); }
    });
    assert(await rejected());
    await frame.locator('#gap').evaluate(e => { e.value = '0'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await frame.locator('#gapNumber').inputValue(), '0');
    await doc.evaluate(async () => {
      await smartSheetWorkspace.addFile(zeroFile(), { sheetIndex: 0, x: 100, y: 0 });
      await smartSheetWorkspace.addFile(zeroFile());
      await smartSheetWorkspace.addFile(zeroFile());
    });
    const state = await doc.evaluate(() => smartSheetWorkspace.snapshot());
    assert.equal(state.sheets.length, 1); assert.equal(state.sheets[0].gap, 0);
    assert.deepEqual(state.sheets[0].placements.slice(0,2).map(p => [p.x, p.y, p.w, p.h]), [[0,0,100,100],[100,0,100,100]]);
    assert(await doc.evaluate(() => {
      const sheet = zeroTest.sheets[0], p = sheet.placements[1];
      return smartSheetWorkspace.validate(p, sheet, p) && !smartSheetWorkspace.validate({ ...p, x: p.x - 1 }, sheet, p)
        && !smartSheetWorkspace.validate({ ...p, x: p.x + 1 }, sheet, p) && !zeroTest.overlaps().size;
    }), 'manual placements can touch the physical edge; one-pixel overlap or overflow is invalid');
    assert(await rejected());
    await frame.locator('#autoExtend').uncheck();
    assert(await doc.evaluate(async () => { try { await smartSheetWorkspace.addFile(zeroFile()); return false; } catch { return smartSheetWorkspace.snapshot().sheets.length === 1; } }));
    await frame.locator('#autoExtend').check();
    await doc.evaluate(() => smartSheetWorkspace.addFile(zeroFile()));
    await doc.evaluate(() => smartSheetWorkspace.setOpen(true));
    await frame.locator('#sw-arrange').click();
    const arranged = await doc.evaluate(() => smartSheetWorkspace.snapshot());
    assert.equal(arranged.sheets.length, 2);
    assert.equal(arranged.sheets.reduce((n,s) => n + s.placements.length, 0), 5);
    for (const s of arranged.sheets) for (const p of s.placements) {
      assert.equal(s.gap, 0); assert.equal(p.w, 100); assert.equal(p.h, 100);
      assert(p.x >= 0 && p.y >= 0 && p.x + p.w <= s.width && p.y + p.h <= s.height);
      for (const q of s.placements) if (p.id !== q.id) assert(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y);
    }
    const expected = await doc.evaluate(() => {
      const c = zeroTest.sheets[0].renderCanvas;
      return { width: c.width, height: c.height, rgba: Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data) };
    });
    // Exercise the existing download routines and inspect their actual file bytes.
    const pngEvent = page.waitForEvent('download');
    await doc.evaluate(() => zeroTest.downloadPng(zeroTest.sheets[0], 0));
    const png = fs.readFileSync(await (await pngEvent).path());
    const decodedPng = await doc.evaluate(async base64 => {
      const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'image/png' });
      const image = await createImageBitmap(blob), canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d').drawImage(image,0,0);
      return { width: canvas.width, height: canvas.height, rgba: Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data) };
    }, png.toString('base64'));
    assert.deepEqual(decodedPng, expected);
    const tiffEvent = page.waitForEvent('download');
    await doc.evaluate(() => zeroTest.downloadTiff(zeroTest.sheets[0], 0, { mode: 'tarp_normal', machine: 'Tarpaulin', baseMode: 'rgb', spotNames: [], normalAlpha: true, label: 'Normal TIFF' }));
    const tiff = fs.readFileSync(await (await tiffEvent).path());
    assert.equal(tiff.toString('ascii',0,2),'II');
    const ifd = tiff.readUInt32LE(4), tags = {};
    for (let i = 0; i < tiff.readUInt16LE(ifd); i++) {
      const at = ifd + 2 + i * 12, tag = tiff.readUInt16LE(at), type = tiff.readUInt16LE(at+2), count = tiff.readUInt32LE(at+4);
      if (![3,4].includes(type)) continue;
      const size = type === 3 ? 2 : 4, pos = count * size <= 4 ? at+8 : tiff.readUInt32LE(at+8);
      tags[tag] = Array.from({ length: count }, (_, n) => type === 3 ? tiff.readUInt16LE(pos+n*size) : tiff.readUInt32LE(pos+n*size));
    }
    assert.equal(tags[256][0], expected.width); assert.equal(tags[257][0], expected.height);
    assert.equal(tags[259][0], 1); assert.equal(tags[277][0], 4);
    const pixels = Buffer.concat(tags[273].map((offset,i) => tiff.subarray(offset, offset + tags[279][i])));
    assert.deepEqual(pixels, Buffer.from(expected.rgba), 'TIFF retains exact sheet pixels and transparency');
    for (const x of [99,100]) assert.equal(pixels[(86 * expected.width + x)*4+3],255,'no artificial gap at touching seam');
    assert.deepEqual(await page.evaluate(() => exportsRequested), ['png','tiff']);
    // A 23 × 39 in automatic run uses the full physical sheet dimensions but
    // keeps every auto-packed bounding box at least 0.30 in from each edge.
    await doc.evaluate(() => smartSheetWorkspace.setOpen(false));
    await frame.locator('#sheetWidth').fill('23'); await frame.locator('#sheetLength').fill('39');
    await frame.locator('#edgeAllowanceNumber').fill('0.3');
    await doc.evaluate(() => smartSheetWorkspace.setOpen(true));
    await frame.locator('#sw-arrange').click();
    const edged = await doc.evaluate(() => ({ settings:zeroTest.settings(), sheets:smartSheetWorkspace.snapshot().sheets }));
    assert.equal(edged.settings.sheetWidthPx, 2300); assert.equal(edged.settings.sheetLengthPx, 3900);
    assert.equal(edged.settings.autoEdgeAllowancePx, 30);
    for (const sheet of edged.sheets) for (const p of sheet.placements) {
      assert(p.x >= 30 && p.y >= 30 && p.x + p.w <= sheet.width - 30 && p.y + p.h <= sheet.height - 30,
        'auto-layout respects the physical 0.30 in allowance on every edge');
    }
    assert.deepEqual(errors, []);
    console.log('Zero spacing and edge allowance passed: defaults and unit/input/slider validity; manual edge placement; auto-layout 0.30 in margins; prior spacing cleared; overlap/bounds rejection; exact quantities and multi-sheet; real PNG/TIFF downloads decoded with identical RGBA pixels and no seam. Photoshop was not tested.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
