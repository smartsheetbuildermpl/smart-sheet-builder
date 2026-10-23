const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, randomUUID } = require('node:crypto');
const { fixture, png, load } = require('./client-jobs.test.cjs');

const sourcePath = process.env.CLIENT_PORTAL_PNG_PATH || path.join(process.env.USERPROFILE || '', 'Downloads', 'BORACAY 22x39.png');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function chunk(type, data) {
  const value = Buffer.alloc(data.length + 12);
  value.writeUInt32BE(data.length, 0); value.write(type, 4); data.copy(value, 8);
  value.writeInt32BE(require('pngjs/lib/crc').crc32(value.subarray(4, -4)), value.length - 4);
  return value;
}
function highResolutionFixture() {
  const width = 6600, height = 11700, stride = width * 4 + 1;
  // A valid 8-bit RGBA PNG with one visible pixel and a large ancillary chunk.
  // The ancillary chunk gives the same 37.17 MiB transfer class as Boracay
  // without adding a binary fixture to the repository.
  const raw = Buffer.alloc(stride * height);
  const pixel = 100 * stride + 1 + 100 * 4;
  raw[pixel] = 36; raw[pixel + 1] = 140; raw[pixel + 2] = 210; raw[pixel + 3] = 255;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const fixed = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
  const target = 38974269, pad = Buffer.alloc(target - fixed.length - 12);
  Buffer.from('fixture\0').copy(pad);
  return Buffer.concat([fixed.subarray(0, -12), chunk('tEXt', pad), fixed.subarray(-12)]);
}

(async () => {
  const f = await fixture();
  try {
    const limits = load('app/lib/client-portal-limits.js');
    assert.deepEqual(limits.uploadLimits(), {
      maxFileMiB: 50, maxTotalMiB: 150, maxFileBytes: 52428800,
      maxTotalBytes: 157286400, maxFiles: 10, maxPieces: 500
    });
    const token = await f.portal();
    const publicInfo = await f.pub.GET(f.req(`/api/client-upload/${token}`), { params: { token } });
    assert.equal(publicInfo.status, 200);
    assert.equal((await publicInfo.json()).limits.maxFileMiB, 50, 'public portal exposes the active, server-enforced profile limit');

    const tooLarge = await f.call('create', token);
    const tooLargeStart = await f.call('upload-start', token, tooLarge.submission, {
      id: randomUUID(), name: '51-mib.png', bytes: 51 * 1024 * 1024
    });
    assert.equal(tooLargeStart.status, 400);
    assert.match(tooLargeStart.message, /per-file limit 50 MiB/);

    const total = await f.call('create', token);
    for (let index = 0; index < 3; index++) {
      const response = await f.call('upload-start', token, total.submission, {
        id: randomUUID(), name: `fifty-${index}.png`, bytes: 50 * 1024 * 1024
      });
      assert.equal(response.status, 200, response.message);
    }
    const totalOverflow = await f.call('upload-start', token, total.submission, {
      id: randomUUID(), name: 'over-total.png', bytes: 1024 * 1024
    });
    assert.equal(totalOverflow.status, 400);
    assert.match(totalOverflow.message, /remaining submission allowance|remaining of 150 MiB/);

    const small = await f.call('create', token);
    const smallUpload = await f.call('upload', token, small.submission, png(120, 80));
    assert.equal(smallUpload.status, 200, smallUpload.message);

    if (!fs.existsSync(sourcePath) && process.env.CLIENT_PORTAL_SYNTHETIC_LARGE !== '1') {
      console.log(`PASS: 50 MiB per file / 150 MiB per submission server guards, unchanged small PNG path. Set CLIENT_PORTAL_PNG_PATH to run the optional Boracay source check, or CLIENT_PORTAL_SYNTHETIC_LARGE=1 for an equivalent 37.17 MiB 6600 x 11700 static PNG.`);
      return;
    }
    const boracay = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath) : highResolutionFixture();
    assert.equal(boracay.length, 38974269, 'the supplied Boracay production fixture is unchanged');
    assert(boracay.length > 32 * 1024 * 1024 && boracay.length < 50 * 1024 * 1024);
    const draft = await f.call('create', token);
    const id = randomUUID();
    const started = await f.call('upload-start', token, draft.submission, { id, name: 'BORACAY 22x39.png', bytes: boracay.length });
    assert.equal(started.status, 200, started.message);
    assert.equal((await fetch(started.url, { method: 'PUT', body: boracay })).status, 200, 'large original uses the private signed storage URL');
    const uploaded = await f.call('upload-finish', token, draft.submission, { id });
    assert.equal(uploaded.status, 200, uploaded.message);
    const asset = uploaded.job.assets.find((item) => item.id === id);
    assert.deepEqual([asset.width, asset.height], [6600, 11700]);
    assert.equal(asset.bytes, boracay.length);
    assert.equal(sha256(f.objects.get(`${draft.job.id}/${id}.png`)), sha256(boracay), 'private stored original is byte-identical');
    const preview = await f.call('preview', token, draft.submission, {
      reference: 'Boracay portal limit verification', quantities: [{ id, qty: 1, widthIn: 5, heightIn: 5 }]
    });
    assert.equal(preview.status, 200, preview.message);
    const confirmed = await f.call('confirm', token, draft.submission, { revision: preview.job.revision });
    assert.equal(confirmed.status, 200, confirmed.message);
    const source = await f.files.GET(f.req('/file', undefined, 'basic'), { params: { id: draft.job.id, file: id } });
    assert.equal(source.status, 200);
    assert.equal(sha256(Buffer.from(await source.arrayBuffer())), sha256(boracay), 'owner receives the original bytes after preview and confirmation');
    console.log(`PASS: Boracay ${boracay.length} bytes accepted through private signed upload, source 6600 x 11700 retained, 5 x 5 preview generated, owner source byte-identical.`);
  } finally {
    await f.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
