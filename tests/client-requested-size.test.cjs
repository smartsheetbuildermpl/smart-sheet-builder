const assert = require('node:assert/strict');
const { fixture, png } = require('./client-jobs.test.cjs');
(async () => {
  const f = await fixture();
  try {
    const token = await f.portal('basic', { widthIn: 3, lengthIn: 3, rotate: false });
    const draft = await f.call('create', token);
    const original = png(600, 400);
    const uploaded = await f.call('upload', token, draft.submission, original);
    assert.equal(uploaded.status, 200);
    const asset = uploaded.job.assets[0];
    const preview = values => f.call('preview', token, draft.submission, { quantities: [{ id: asset.id, qty: 2, ...values }] });
    const sized = await preview({ widthIn: 1.25, heightIn: 0.75 });
    assert.equal(sized.status, 200, sized.message);
    assert.equal(sized.job.assets[0].widthIn, 1.25); assert.equal(sized.job.assets[0].heightIn, 0.75);
    assert(sized.job.manifest.sheets.flatMap(s=>s.placements).every(p=>p.baseW===375 && p.baseH===225));
    const larger = await preview({ qty: 3, widthIn: 1.4, heightIn: 1.4 });
    assert.equal(larger.status, 200, larger.message);
    assert.equal(larger.job.manifest.sheets.length, 3); assert(larger.job.meters > sized.job.meters);
    assert.equal(larger.job.expires_at, sized.job.expires_at, 'editing size cannot extend expiry');
    for (const values of [{ widthIn: 0, heightIn: 1 }, { widthIn: -1, heightIn: 1 }, { widthIn: null, heightIn: 1 }, { widthIn: '1', heightIn: 1 }, { widthIn: 1 }, { widthIn: 121, heightIn: 1 }, { widthIn: 0.00001, heightIn: 1 }, { widthIn: 10, heightIn: 10 }]) {
      assert.equal((await preview(values)).status, 400, JSON.stringify(values));
    }
    assert.equal((await f.call('preview', token, draft.submission, { quantities: [{ id: 'unknown', qty: 1, widthIn: 1, heightIn: 1 }] })).status, 400);
    assert([...f.objects.values()].some(bytes=>Buffer.from(bytes).equals(original)), 'stored original PNG remains byte-identical');
    const confirmed = await f.call('confirm', token, draft.submission, { revision: larger.job.revision });
    assert.equal(confirmed.status, 200, confirmed.message);
    const owner = await f.owner.GET(f.req('/api/client-jobs?id='+confirmed.job.id, undefined, 'basic'));
    const ownerJob = (await owner.json()).job;
    assert(ownerJob.manifest.sheets.flatMap(s=>s.placements).every(p=>p.baseW===420 && p.baseH===420));
    assert.equal(ownerJob.assets[0].widthIn, 1.4);
    assert.equal((await preview({ widthIn: 1, heightIn: 1 })).status, 400, 'confirmed layout is locked');
    console.log('PASS: requested inch sizes, server validation/fit/budget, meters, original PNG bytes, persisted owner manifest, locked confirmation and unchanged expiry.');
  } finally { await f.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
