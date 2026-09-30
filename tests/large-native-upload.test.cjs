const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { PNG } = require('pngjs');

const source = fs.readFileSync('public/builder.html', 'utf8');
const hook = `
  window.largeUploadTest={
    get designs(){return designs},get sheets(){return sheets},
    assertNativeImageDimensions,trimTransparentMargins,downloadPng,downloadTiff,getExportProfile
  };
  exportDelivery=SmartSheetExportDelivery.create({
    gate:async()=>({allowed:true,authorization:'encoder-fixture-only'}),save:saveExportBlob
  });
`;
const html = source.replace(/\}\)\(\);\s*<\/script>/, hook + '})();</script>');
assert.notEqual(html, source, 'test hook inserted');

function tiffDimensions(bytes) {
  const ifd = bytes.readUInt32LE(4), count = bytes.readUInt16LE(ifd), tags = {};
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12, tag = bytes.readUInt16LE(at), type = bytes.readUInt16LE(at + 2);
    const length = bytes.readUInt32LE(at + 4), offset = length * (type === 3 ? 2 : 4) <= 4 ? at + 8 : bytes.readUInt32LE(at + 8);
    if (tag === 256 || tag === 257) tags[tag] = type === 3 ? bytes.readUInt16LE(offset) : bytes.readUInt32LE(offset);
  }
  return [tags[256], tags[257]];
}

function alphaCrop(buffer, padding = 1) {
  const decoded = PNG.sync.read(buffer);
  let left = decoded.width, top = decoded.height, right = -1, bottom = -1;
  for (let y = 0; y < decoded.height; y++) {
    for (let x = 0; x < decoded.width; x++) {
      if (decoded.data[(y * decoded.width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top) return null;
  left = Math.max(0, left - padding); top = Math.max(0, top - padding);
  right = Math.min(decoded.width - 1, right + padding); bottom = Math.min(decoded.height - 1, bottom + padding);
  return {
    original: [decoded.width, decoded.height],
    active: [right - left + 1, bottom - top + 1],
    rect: { x: left, y: top, w: right - left + 1, h: bottom - top + 1 },
    noChange: left === 0 && top === 0 && right === decoded.width - 1 && bottom === decoded.height - 1
  };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(180000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:4201/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/builder.html') return route.fulfill({ body: html, contentType: 'text/html' });
      if (/^\/(sheet-workspace|background-editor|print-optimizer|export-delivery|sheet-packing|builder-shell|workspace-theme)\.(js|css)$/.test(pathname)) {
        return route.fulfill({ body: fs.readFileSync('public' + pathname), contentType: pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
      }
      return route.fulfill({ body: '<iframe src="/builder.html"></iframe>', contentType: 'text/html' });
    });
    await page.goto('http://localhost:4201');
    const frame = page.frameLocator('iframe'), doc = page.frames().find(item => item.url().endsWith('/builder.html'));
    await frame.locator('#fileInput').waitFor();
    const validation = await doc.evaluate(() => {
      const empty = document.createElement('canvas'); empty.width = empty.height = 4500;
      let emptyRejected = false, sideRejected = false;
      try { largeUploadTest.trimTransparentMargins(empty, 1); } catch (error) { emptyRejected = /transparent|empty/i.test(error.message); }
      try { largeUploadTest.assertNativeImageDimensions(8193, 1, 'PNG upload'); } catch (error) { sideRejected = /8192/.test(error.message); }
      empty.width = empty.height = 1;
      return { emptyRejected, sideRejected };
    });
    assert.deepEqual(validation, { emptyRejected: true, sideRejected: true }, 'empty-image and 8192-per-side validation remain active');

    let buffer, name;
    if (process.env.LARGE_PNG_PATH) {
      buffer = fs.readFileSync(process.env.LARGE_PNG_PATH);
      name = 'supplied-4500.png';
    } else {
      const base64 = await doc.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4500;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#123154'; ctx.fillRect(0, 0, 4500, 4500);
        ctx.fillStyle = '#19a6bd'; ctx.fillRect(1, 1, 12, 12); ctx.fillRect(4487, 4487, 12, 12);
        ctx.fillStyle = '#f4f3ee'; ctx.fillRect(2200, 2200, 100, 100);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(binary);
      });
      buffer = Buffer.from(base64, 'base64'); name = 'native-4500.png';
    }
    const expectedNative = [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
    if (!process.env.LARGE_PNG_PATH) assert.deepEqual(expectedNative, [4500, 4500], 'synthetic acceptance fixture is exactly 4500 × 4500');
    const expectedCrop = alphaCrop(buffer, 1);
    assert(expectedCrop, 'fixture contains visible artwork');
    assert.deepEqual(expectedCrop.original, expectedNative);
    const originalHash = crypto.createHash('sha256').update(buffer).digest('hex');
    await frame.locator('#fileInput').setInputFiles({ name, mimeType: 'image/png', buffer });
    await doc.waitForFunction(fileName => largeUploadTest.designs.some(d => d.file.name === fileName), name);

    const uploaded = await doc.evaluate(async fileName => {
      const d = largeUploadTest.designs.find(item => item.file.name === fileName);
      const digest = await crypto.subtle.digest('SHA-256', await d.file.arrayBuffer());
      const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      const originalCtx = d.originalCanvas.getContext('2d', { willReadFrequently: true });
      const activeCtx = d.trimmed.canvas.getContext('2d', { willReadFrequently: true });
      const samples = [[0, 0], [d.trimmed.w - 1, 0], [0, d.trimmed.h - 1], [d.trimmed.w - 1, d.trimmed.h - 1],
        [Math.floor(d.trimmed.w / 2), Math.floor(d.trimmed.h / 2)]];
      const exactCropPixels = samples.every(([x, y]) => {
        const source = originalCtx.getImageData(d.trimRect.x + x, d.trimRect.y + y, 1, 1).data;
        const active = activeCtx.getImageData(x, y, 1, 1).data;
        return source[0] === active[0] && source[1] === active[1] && source[2] === active[2] && source[3] === active[3];
      });
      return {
        file: [d.file.name, d.file.type, d.file.size, hash], original: [d.originalCanvas.width, d.originalCanvas.height],
        active: [d.trimmed.w, d.trimmed.h], sameNativeCanvas: d.trimmed.canvas === d.originalCanvas,
        trimRect: d.trimRect, aspect: d.aspect, printSize: [d.widthIn, d.heightIn], exactCropPixels,
        feedback: document.querySelector('.design-item [role=status]').textContent,
        error: document.getElementById('errorMsg').textContent
      };
    }, name);
    assert.deepEqual(uploaded.original, expectedNative);
    assert.deepEqual(uploaded.active, expectedCrop.active);
    assert.deepEqual(uploaded.trimRect, expectedCrop.rect);
    assert.equal(uploaded.sameNativeCanvas, expectedCrop.noChange, 'only a tightly cropped source reuses the decoded canvas');
    assert.equal(uploaded.exactCropPixels, true, 'cropping copies source RGBA pixels exactly without resampling');
    assert.equal(uploaded.aspect, expectedCrop.active[0] / expectedCrop.active[1]);
    assert.deepEqual(uploaded.printSize, [expectedCrop.active[0] / 300, expectedCrop.active[1] / 300]);
    if (expectedCrop.noChange) {
      assert.match(uploaded.feedback, /already tightly cropped/i);
    } else {
      assert.equal(uploaded.feedback, `Transparent margins trimmed: ${expectedNative[0]} × ${expectedNative[1]} px → ${expectedCrop.active[0]} × ${expectedCrop.active[1]} px`);
    }
    assert.deepEqual(uploaded.file, [name, 'image/png', buffer.length, originalHash], 'original File/Blob bytes remain unchanged');
    assert(!/16 megapixel|256 MiB|memory limit|estimated peak/i.test(uploaded.error + uploaded.feedback));
    await doc.evaluate(expectedActive => {
      largeUploadTest.assertNativeImageDimensions(4500, 4500, 'PNG upload');
      const d = largeUploadTest.designs[0]; d.widthIn = 2; d.heightIn = 2 / d.aspect; d.qty = 1;
      document.getElementById('dpi').value = '300'; document.getElementById('sheetWidth').value = '3';
      document.getElementById('sheetLength').value = '3'; document.getElementById('autoExtend').checked = true;
      window.exportDrawSources = [];
      const nativeDraw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
        if (source?.width === expectedActive[0] && source?.height === expectedActive[1]) exportDrawSources.push([source.width, source.height]);
        return nativeDraw.call(this, source, ...args);
      };
    }, expectedCrop.active);
    await frame.getByRole('button', { name: 'Add to layout', exact: true }).click();
    await doc.waitForFunction(() => largeUploadTest.sheets[0]?.placements.length === 1);
    const layout = await doc.evaluate(() => {
      const d = largeUploadTest.designs[0], p = largeUploadTest.sheets[0].placements[0];
      return { sheet: [largeUploadTest.sheets[0].renderCanvas.width, largeUploadTest.sheets[0].renderCanvas.height],
        source: [p.inst.canvas.width, p.inst.canvas.height], exactSource: p.inst.canvas === d.trimmed.canvas,
        placement: [p.inst.baseW / 300, p.inst.baseH / 300] };
    });
    assert.deepEqual(layout.sheet, [900, 900]);
    assert.deepEqual(layout.source, expectedCrop.active);
    assert.equal(layout.exactSource, true);
    assert.equal(layout.placement[0], 2);
    assert(Math.abs(layout.placement[1] - (2 / uploaded.aspect)) <= 1 / 300,
      'layout height follows the cropped aspect ratio to the nearest export pixel');
    const pngEvent = page.waitForEvent('download');
    await doc.evaluate(() => largeUploadTest.downloadPng(largeUploadTest.sheets[0], 0));
    const pngBytes = fs.readFileSync(await (await pngEvent).path()), decoded = PNG.sync.read(pngBytes);
    assert.deepEqual([decoded.width, decoded.height], [900, 900]);
    const tiffEvent = page.waitForEvent('download');
    await doc.evaluate(() => largeUploadTest.downloadTiff(largeUploadTest.sheets[0], 0, largeUploadTest.getExportProfile('rgb')));
    const tiffBytes = fs.readFileSync(await (await tiffEvent).path());
    assert.deepEqual(tiffDimensions(tiffBytes), [900, 900]);
    assert((await doc.evaluate(() => exportDrawSources.length)) >= 1, 'the export sheet raster is drawn from the full-resolution cropped active source');
    assert.equal(await doc.evaluate(async expected => {
      const file = largeUploadTest.designs[0].file, digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') === expected;
    }, originalHash), true, 'export leaves the original File unchanged');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ expectedCrop, upload: uploaded, layout, exports: { png: [decoded.width, decoded.height], tiff: tiffDimensions(tiffBytes), sourceDraws: await doc.evaluate(() => exportDrawSources) } }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
