const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const source = fs.readFileSync('public/builder.html', 'utf8');
const hook = "window.rgbW1Test={downloadTiff,getExportProfile,settings:getSheetPixelSettings};";
const html = source.replace(/\}\)\(\);\s*<\/script>/, hook + '})();</script>');
assert.notEqual(html, source, 'test hook inserted');

function parseTiff(bytes) {
  assert.equal(bytes.toString('ascii', 0, 2), 'II', 'little-endian TIFF');
  assert.equal(bytes.readUInt16LE(2), 42, 'classic TIFF');
  const ifd = bytes.readUInt32LE(4);
  const count = bytes.readUInt16LE(ifd);
  const tags = new Map();
  const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };
  for (let index = 0; index < count; index++) {
    const at = ifd + 2 + index * 12;
    const tag = bytes.readUInt16LE(at), type = bytes.readUInt16LE(at + 2), items = bytes.readUInt32LE(at + 4);
    const size = sizes[type]; assert(size, `known TIFF field type ${type}`);
    const offset = size * items <= 4 ? at + 8 : bytes.readUInt32LE(at + 8);
    const values = Array.from({ length: items }, (_, item) => {
      const position = offset + item * size;
      if (type === 1 || type === 2 || type === 7) return bytes[position];
      if (type === 3) return bytes.readUInt16LE(position);
      if (type === 4) return bytes.readUInt32LE(position);
      return [bytes.readUInt32LE(position), bytes.readUInt32LE(position + 4)];
    });
    tags.set(tag, values);
  }
  return tags;
}

function rational(tags, tag) {
  const [numerator, denominator] = tags.get(tag)[0];
  return numerator / denominator;
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:4180/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (/^\/(sheet-workspace|background-editor|print-optimizer)\.(js|css)$/.test(pathname)) {
        return route.fulfill({ body: fs.readFileSync('public' + pathname), contentType: pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
      }
      return route.fulfill({ body: html, contentType: 'text/html' });
    });
    await page.goto('http://localhost:4180/builder.html');
    const fileDownload = page.waitForEvent('download');
    await page.evaluate(async () => {
      document.getElementById('dpi').value = '300';
      rgbW1Test.settings();
      const canvas = document.createElement('canvas');
      canvas.width = 5; canvas.height = 5;
      const context = canvas.getContext('2d');
      const image = context.createImageData(5, 5);
      for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) {
        const at = (y * 5 + x) * 4;
        image.data[at] = 12; image.data[at + 1] = 34; image.data[at + 2] = 56; image.data[at + 3] = 255;
      }
      context.putImageData(image, 0, 0);
      window.rgbW1Canvas = canvas;
      const profile = rgbW1Test.getExportProfile('rgb');
      if (profile.mode !== 'dtf_rgb_w1') throw new Error('Expected DTF RGB+W1 profile.');
      await rgbW1Test.downloadTiff({ renderCanvas: canvas, exportUi: {} }, 0, profile);
    });
    const bytes = fs.readFileSync(await (await fileDownload).path());
    const tags = parseTiff(bytes);
    assert.equal(tags.get(262)[0], 2, 'RGB photometric interpretation');
    assert.deepEqual(tags.get(258), [8, 8, 8, 8], 'four 8-bit RGB+W1 samples');
    assert.equal(tags.get(277)[0], 4, 'RGB TIFF remains four samples per pixel');
    assert.deepEqual(tags.get(338), [0], 'W1 remains the one unspecified extra sample, not a TIFF alpha declaration');
    assert.equal(rational(tags, 282), 300, 'X resolution remains 300 DPI');
    assert.equal(rational(tags, 283), 300, 'Y resolution remains 300 DPI');
    assert.equal(tags.get(296)[0], 2, 'resolution unit remains inches');
    assert.equal(tags.get(256)[0], 5); assert.equal(tags.get(257)[0], 5);
    const photoshopResources = Buffer.from(tags.get(34377));
    assert(photoshopResources.includes(Buffer.from('W1\0')), 'Photoshop resource retains the W1 channel name');
    const offsets = tags.get(273), sizes = tags.get(279);
    const pixelData = Buffer.concat(offsets.map((offset, index) => bytes.subarray(offset, offset + sizes[index])));
    const pixel = (x, y) => Array.from(pixelData.subarray((y * 5 + x) * 4, (y * 5 + x + 1) * 4));
    assert.deepEqual(pixel(0, 0), [255, 255, 255, 255], 'blank RGB+W1 pixel is white with the existing W1 blank value');
    assert.deepEqual(pixel(2, 2), [12, 34, 56, 0], 'opaque artwork RGB and populated W1 mask remain exact');
    assert.equal(pixelData.filter((value, index) => index % 4 === 3 && value === 0).length > 0, true, 'W1 has covered-art values');
    assert.equal(pixelData.filter((value, index) => index % 4 === 3 && value === 255).length > 0, true, 'W1 has blank-background values');

    // The RGB fallback is deliberately scoped to RGB+W1. CMYK+W1 retains its
    // zero-ink background and original five-channel production layout.
    const cmykDownload = page.waitForEvent('download');
    await page.evaluate(async () => {
      const profile = rgbW1Test.getExportProfile('cmyk');
      if (profile.mode !== 'dtf_cmyk_w1') throw new Error('Expected DTF CMYK+W1 profile.');
      await rgbW1Test.downloadTiff({ renderCanvas: window.rgbW1Canvas, exportUi: {} }, 0, profile);
    });
    const cmykBytes = fs.readFileSync(await (await cmykDownload).path());
    const cmykTags = parseTiff(cmykBytes);
    assert.equal(cmykTags.get(262)[0], 5, 'CMYK photometric interpretation remains unchanged');
    assert.deepEqual(cmykTags.get(258), [8, 8, 8, 8, 8], 'CMYK+W1 remains five 8-bit samples');
    assert.equal(cmykTags.get(277)[0], 5, 'CMYK+W1 remains five samples per pixel');
    assert.deepEqual(cmykTags.get(338), [0], 'CMYK W1 remains one unspecified extra sample');
    const cmykPixels = Buffer.concat(cmykTags.get(273).map((offset, index) => cmykBytes.subarray(offset, offset + cmykTags.get(279)[index])));
    assert.deepEqual(Array.from(cmykPixels.subarray(0, 5)), [0, 0, 0, 0, 255], 'CMYK blank pixels remain zero ink with the existing W1 blank value');
    assert.deepEqual(errors, []);
    console.log('RGB+W1 TIFF check passed: RGB/300 DPI, 4×8-bit samples, ExtraSamples=(0), Photoshop W1 resource, white alpha-zero RGB fallback, exact opaque art RGB, populated W1 values, and unchanged CMYK+W1 zero-ink background.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
