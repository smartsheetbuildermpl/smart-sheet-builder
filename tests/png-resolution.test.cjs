const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const source = fs.readFileSync('public/builder.html', 'utf8');
const hook = `window.pngResolutionTest={
  seedFull:function(){
    var canvas=document.createElement('canvas');canvas.width=6900;canvas.height=11700;
    var context=canvas.getContext('2d');context.fillStyle='rgba(18,92,166,.75)';context.fillRect(300,300,1500,600);
    var sheet={widthPx:6900,heightPx:11700,headerHeightPx:0,placements:[{x:300,y:300,w:1500,h:600}],renderCanvas:canvas,exportUi:{progress:document.createElement('p')}};
    canvas._ssbExportRecipe=['png-resolution',6900,11700,300];sheets=[sheet];dpiGlobal=300;
    return {sheet:function(){return sheet},designPixels:1500};
  },
  download:function(){return downloadPng(sheets[0],0)},
  metadata:function(blob,dpi){return addPngPhysicalResolution(blob,dpi)},
  smallIdentity:async function(){
    var canvas=document.createElement('canvas');canvas.width=17;canvas.height=13;
    var context=canvas.getContext('2d'),image=context.createImageData(17,13);
    for(var i=0;i<image.data.length;i+=4){var p=i/4;image.data[i]=(p*17)%256;image.data[i+1]=(p*31)%256;image.data[i+2]=(p*47)%256;image.data[i+3]=(p*53)%256;}
    context.putImageData(image,0,0);
    var raw=await new Promise(function(resolve){canvas.toBlob(resolve,'image/png')});
    var withOld=await addPngPhysicalResolution(raw,72),patched=await addPngPhysicalResolution(withOld,300),alternate=await addPngPhysicalResolution(raw,150);
    async function pixels(blob){var bitmap=await createImageBitmap(blob),copy=document.createElement('canvas');copy.width=bitmap.width;copy.height=bitmap.height;copy.getContext('2d').drawImage(bitmap,0,0);return Array.from(copy.getContext('2d').getImageData(0,0,copy.width,copy.height).data);}
    return {raw:Array.from(new Uint8Array(await raw.arrayBuffer())),patched:Array.from(new Uint8Array(await patched.arrayBuffer())),alternate:Array.from(new Uint8Array(await alternate.arrayBuffer())),rawPixels:await pixels(raw),patchedPixels:await pixels(patched)};
  }
};`;
const html = source.replace(/\}\)\(\);\s*<\/script>/, hook + '})();</script>');
assert.notEqual(html, source, 'PNG metadata test hook inserted');

function chunks(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  const result = []; let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    assert(end <= bytes.length, 'PNG chunk is complete');
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), data: bytes.subarray(offset + 8, offset + 8 + length), bytes: bytes.subarray(offset, end) });
    offset = end;
  }
  assert.equal(offset, bytes.length);
  return result;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function metadata(bytes) {
  const list = chunks(bytes), header = list.find(chunk => chunk.type === 'IHDR');
  const physical = list.filter(chunk => chunk.type === 'pHYs');
  assert(header, 'IHDR exists');
  return { width: header.data.readUInt32BE(0), height: header.data.readUInt32BE(4), physical, list };
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:4193/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/builder.html') return route.fulfill({ body: html, contentType: 'text/html' });
      if (/^\/(sheet-workspace|background-editor|print-optimizer|export-delivery|sheet-packing|builder-shell|workspace-theme)\.(js|css)$/.test(pathname)) {
        return route.fulfill({ body: fs.readFileSync('public' + pathname), contentType: pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
      }
      return route.fulfill({ body: `<iframe src="/builder.html"></iframe><script>addEventListener('message',event=>{if(event.data.type==='SMART_SHEET_EXPORT_REQUEST')event.source.postMessage({type:'SMART_SHEET_EXPORT_RESPONSE',requestId:event.data.requestId,allowed:true,authorization:'png-resolution-test'},event.origin)})</script>`, contentType: 'text/html' });
    });
    await page.goto('http://localhost:4193');
    const doc = page.frames().find(frame => frame.url().endsWith('/builder.html'));
    await doc.waitForFunction(() => window.pngResolutionTest);

    const identity = await doc.evaluate(() => pngResolutionTest.smallIdentity());
    assert.deepEqual(identity.patchedPixels, identity.rawPixels, 'RGBA and transparency are pixel-identical after metadata insertion');
    const raw = metadata(Buffer.from(identity.raw)), patched = metadata(Buffer.from(identity.patched)), alternate = metadata(Buffer.from(identity.alternate));
    assert.equal(patched.physical.length, 1, 'an existing pHYs chunk is replaced, not duplicated');
    assert.deepEqual([alternate.physical[0].data.readUInt32BE(0), alternate.physical[0].data.readUInt32BE(4), alternate.physical[0].data[8]], [5906,5906,1], 'selected non-300 DPI is converted to rounded pixels per metre');
    assert.deepEqual(
      patched.list.filter(chunk => chunk.type !== 'pHYs').map(chunk => [chunk.type, chunk.bytes.toString('hex')]),
      raw.list.filter(chunk => chunk.type !== 'pHYs').map(chunk => [chunk.type, chunk.bytes.toString('hex')]),
      'all original PNG chunks and compressed image bytes remain byte-identical'
    );

    const seeded = await doc.evaluate(() => { const fixture=pngResolutionTest.seedFull(); return {designPixels:fixture.designPixels}; });
    const downloadEvent = page.waitForEvent('download');
    await doc.evaluate(() => pngResolutionTest.download());
    const exported = fs.readFileSync(await (await downloadEvent).path());
    const png = metadata(exported);
    assert.deepEqual([png.width, png.height], [6900, 11700], '23 × 39 in at 300 PPI retains exact pixels');
    assert.equal(png.physical.length, 1, 'export contains exactly one pHYs chunk');
    const xPpm = png.physical[0].data.readUInt32BE(0), yPpm = png.physical[0].data.readUInt32BE(4), unit = png.physical[0].data[8];
    assert.deepEqual([xPpm, yPpm, unit], [11811, 11811, 1]);
    assert.equal(png.physical[0].bytes.readUInt32BE(png.physical[0].bytes.length - 4), crc32(png.physical[0].bytes.subarray(4, png.physical[0].bytes.length - 4)), 'pHYs CRC is valid');
    const effectivePpi = xPpm * 0.0254;
    const widthIn = png.width / effectivePpi, heightIn = png.height / effectivePpi, designIn = seeded.designPixels / effectivePpi;
    assert(Math.abs(widthIn - 23) < 0.001 && Math.abs(heightIn - 39) < 0.001 && Math.abs(designIn - 5) < 0.001);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ pixels:[png.width,png.height], pHYs:{xPpm,yPpm,unit,effectivePpi}, photoshopInches:[widthIn,heightIn], fiveInchDesign:designIn, pHYsCount:png.physical.length, rgbaPixelIdentical:true, nonPhysicalChunksByteIdentical:true }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
