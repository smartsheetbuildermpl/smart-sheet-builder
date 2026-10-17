const assert = require('node:assert/strict');
const { fixture, png } = require('./client-jobs.test.cjs');
(async () => {
  const f = await fixture();
  try {
    const initial = await (await f.owner.GET(f.req('/api/client-jobs', undefined, 'basic'))).json();
    assert.equal(initial.portal.settings.gapIn, 0.3);
    assert.equal(initial.portal.settings.edgeIn, 0.5);
    const token = await f.portal('basic', { widthIn:3, lengthIn:3, gapIn:0.17, edgeIn:0.22 });
    const created = await f.call('create',token);
    const uploaded = await f.call('upload',token,created.submission,png(300,150));
    const preview = await f.call('preview',token,created.submission,{quantities:uploaded.job.assets.map(a=>({id:a.id,qty:2,widthIn:1,heightIn:0.5}))});
    assert.equal(preview.status,200,preview.message);
    assert.equal(preview.job.manifest.sheets[0].gapPx,Math.ceil(0.17 * 300));
    assert.equal(preview.job.manifest.sheets[0].autoEdgeAllowancePx,66);
    const saved = await f.one('select manifest from client_jobs where id=$1',[created.job.id]);
    assert.equal(saved.manifest.config.gapIn,0.17);
    assert.equal(saved.manifest.config.edgeIn,0.22);
    await f.portal('basic',{widthIn:3,lengthIn:3,gapIn:0.3,edgeIn:0.5});
    const confirmed = await f.call('confirm',token,created.submission,{revision:preview.job.revision});
    assert.equal(confirmed.status,200,confirmed.message);
    const read = async () => (await (await f.owner.GET(f.req('/api/client-jobs?id='+created.job.id,undefined,'basic'))).json()).job;
    assert.deepEqual((await read()).manifest,saved.manifest,'confirmation uses reviewed snapshot even after portal edits');
    const rotated = await f.owner.POST(f.req('/api/client-jobs',{action:'rotate'},'basic'));
    assert.equal(rotated.status,200);
    assert.equal((await rotated.json()).portal.settings.edgeIn,0.5);
    assert.deepEqual((await read()).manifest,saved.manifest,'rotation cannot rewrite existing submission');
    assert.equal((await read()).expires_at,confirmed.job.expires_at);
    assert([...f.objects.values()].some(bytes=>Buffer.from(bytes).equals(png(300,150))));
    console.log('PASS: new portal defaults, saved overrides, preview-time snapshots, confirmation after settings change, link rotation, original bytes and expiry.');
  } finally { await f.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
