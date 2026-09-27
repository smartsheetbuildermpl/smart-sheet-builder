const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { PNG } = require('pngjs'),
  { NextRequest } = require('next/server'),
  { randomUUID } = require('node:crypto');
const { fixture: baseFixture } = require('./export-enforcement.test.cjs');
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const src = fs.readFileSync(file, 'utf8'),
    names = [
      ...src.matchAll(/export (?:async )?(?:function|const) (\w+)/g)
    ].map((m) => m[1]);
  const code = src
    .replace(
      /import ([^;]+?) from '([^']+)';/g,
      (_, n, s) => `const ${n}=imports(${JSON.stringify(s)});`
    )
    .replace(/export /g, '');
  const result = new Function(
    'imports',
    code + `\nreturn {${names.join(',')}};`
  )((s) =>
    s.startsWith('.')
      ? s.includes('/public/')
        ? require(path.resolve(path.dirname(file), s))
        : load(path.resolve(path.dirname(file), s + '.js'))
      : require(s)
  );
  cache.set(file, result);
  return result;
}
function png(w = 60, h = 40) {
  const p = new PNG({ width: w, height: h });
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      p.data[i] = 20;
      p.data[i + 1] = 140;
      p.data[i + 2] = 200;
      p.data[i + 3] = x === 1 ? 4 : 255;
    }
  return PNG.sync.write(p);
}
async function fixture() {
  const f = await baseFixture();
  await f.db.exec(
    'alter table storage.buckets add column name text;alter table storage.buckets add column file_size_limit bigint;alter table storage.buckets add column allowed_mime_types text[];'
  );
  const sql = fs.readFileSync('supabase-client-jobs-v1.sql', 'utf8');
  await f.db.exec(sql);
  await f.db.exec(sql);
  Object.assign(process.env, {
    RESEND_API_KEY: 'test-provider',
    CLIENT_JOBS_EMAIL_FROM: 'print@test.example',
    SMART_SHEET_SITE_URL: 'https://shop.test',
    CLIENT_JOBS_CRON_SECRET: 'test-maintenance'
  });
  const prior = global.fetch,
    objects = new Map(),
    emails = [];
  let mailFails = false,
    storageFails = false;
  global.fetch = async (url, options = {}) => {
    const u = new URL(url);
    if (u.host === 'api.resend.com') {
      if (mailFails) return new Response('{}', { status: 503 });
      emails.push(JSON.parse(options.body));
      return new Response('{"id":"test-mail"}');
    }
    if (u.pathname.startsWith('/storage/v1/object/client-job-sources')) {
      if (storageFails) return new Response('{}', { status: 503 });
      const name = u.pathname.slice(
        '/storage/v1/object/client-job-sources/'.length
      );
      if (options.method === 'POST') {
        objects.set(name, Buffer.from(options.body));
        return new Response('{}');
      }
      if (options.method === 'DELETE') {
        for (const p of JSON.parse(options.body).prefixes) objects.delete(p);
        return new Response('{}');
      }
      return objects.has(name)
        ? new Response(objects.get(name), {
            headers: { 'Content-Type': 'image/png' }
          })
        : new Response('{}', { status: 404 });
    }
    if (u.pathname.startsWith('/rest/v1/rpc/ssb_client_')) {
      const name = u.pathname.split('/').at(-1),
        body = JSON.parse(options.body),
        keys = Object.keys(body);
      try {
        return Response.json(
          (
            await f.one(
              `select ${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) d`,
              Object.values(body)
            )
          ).d
        );
      } catch (e) {
        return Response.json(
          { message: e.message, code: e.code },
          { status: 400 }
        );
      }
    }
    return prior(url, options);
  };
  const owner = load('app/api/client-jobs/route.js'),
    pub = load('app/api/client-upload/[token]/route.js'),
    files = load('app/api/client-jobs/[id]/files/[file]/route.js'),
    maintenance = load('app/api/client-jobs/maintenance/route.js'),
    lib = load('app/api/_lib/client-jobs.js');
  const req = (url, body, token, headers = {}) =>
    new NextRequest(`https://shop.test${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'x-test-ingress-ip': '203.0.113.87',
        ...headers
      },
      ...(body === undefined
        ? {}
        : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) })
    });
  const call = async (action, token, session, body = {}) => {
    const r = await pub.POST(
      req(`/api/client-upload/${token}?action=${action}`, body, null, {
        'x-client-submission': session || '',
        ...(Buffer.isBuffer(body)
          ? { 'Content-Type': 'image/png', 'x-file-name': 'art.png' }
          : {})
      }),
      { params: { token } }
    );
    return { status: r.status, ...(await r.json()) };
  };
  async function portal(user = 'basic', config = {}) {
    const r = await owner.POST(
      req(
        '/api/client-jobs',
        {
          action: 'save',
          settings: {
            ...lib.defaults,
            shopName: 'Test shop',
            email: 'notify@test.example',
            ...config
          }
        },
        user
      )
    );
    const d = await r.json();
    assert.equal(r.status, 200, JSON.stringify(d));
    return d.portal.url.split('/').at(-1);
  }
  async function confirmed(token, count = 2, bytes = png()) {
    const draft = await call('create', token);
    assert.equal(draft.status, 200);
    const upload = await call('upload', token, draft.submission, bytes);
    assert.equal(upload.status, 200, upload.message);
    const preview = await call('preview', token, draft.submission, {
      reference: 'Jersey order',
      quantities: upload.job.assets.map((a) => ({ id: a.id, qty: count }))
    });
    assert.equal(preview.status, 200, preview.message);
    const locked = await call('confirm', token, draft.submission, {
      revision: preview.job.revision
    });
    assert.equal(locked.status, 200, locked.message);
    return { ...draft, job: locked.job, preview: preview.job };
  }
  return {
    ...f,
    exportCall: f.call,
    owner,
    pub,
    files,
    maintenance,
    lib,
    objects,
    emails,
    req,
    call,
    portal,
    confirmed,
    mailFails: (v) => (mailFails = v),
    storageFails: (v) => (storageFails = v),
    close: async () => {
      global.fetch = prior;
      await f.close();
    }
  };
}
async function run() {
  const f = await fixture();
  try {
    const { lib, call, req } = f;
    const original = png(2048, 2048),
      decoded = lib.decodePng(original);
    assert.deepEqual(decoded.crop, { x: 0, y: 0, w: 2048, h: 2048 });
    assert.throws(() => lib.decodePng(Buffer.from('not a png')));
    const corrupt = Buffer.from(original);
    corrupt[corrupt.length - 6] ^= 255;
    assert.throws(() => lib.decodePng(corrupt));
    // A small Adam7 header must not permit unbounded decompression before decode.
    const chunk = (type, data) => {
      const b = Buffer.alloc(data.length + 12);
      b.writeUInt32BE(data.length);
      b.write(type, 4);
      data.copy(b, 8);
      b.writeInt32BE(require('pngjs/lib/crc').crc32(b.subarray(4, -4)), b.length - 4);
      return b;
    };
    const header = Buffer.from(png(8, 8).subarray(16, 29));
    header[12] = 1;
    const inflatedBomb = Buffer.concat([
      original.subarray(0, 8),
      chunk('IHDR', header),
      chunk('IDAT', require('node:zlib').deflateSync(Buffer.alloc(4096))),
      chunk('IEND', Buffer.alloc(0))
    ]);
    assert.throws(() => lib.decodePng(inflatedBomb), /oversized interlaced/);
    const token = await f.portal(),
      other = await f.portal('unlimited');
    const before = await f.one(
      'select exports_used from profiles where id=$1',
      [f.users.basic.id]
    );
    const draft = await call('create', token),
      upload = await call('upload', token, draft.submission, png(810, 345)),
      upload2 = await call('upload', token, draft.submission, png(80, 40));
    assert.equal(upload2.job.assets.length, 2);
    assert.equal(
      (await call('preview', other, draft.submission, {})).status,
      401,
      'opaque session cannot cross portals'
    );
    const preview = await call('preview', token, draft.submission, {
      reference: '20 wide logos',
      quantities: upload2.job.assets.map((a, i) => ({
        id: a.id,
        qty: i ? 2 : 20
      }))
    });
    assert.equal(preview.status, 200, preview.message);
    assert.equal(preview.job.quantity, 22);
    assert.equal(
      preview.job.manifest.config,
      undefined,
      'public preview never reveals notification email/settings'
    );
    const ps = preview.job.manifest.sheets[0].placements;
    assert(
      ps
        .filter((p) => p.assetId === upload.job.assets[0].id)
        .every((p) => p.rotation === 0)
    );
    assert.equal(new Set(ps.slice(0, 20).map((p) => p.y)).size, 3);
    assert(Math.max(...ps.slice(0, 20).map((p) => p.y + p.h)) < 1200);
    assert(ps.every((p) => p.x >= 90 && p.y >= 90));
    assert(Math.abs(preview.job.meters - 0.9906) < 1e-10);
    f.mailFails(true);
    const locked = await call('confirm', token, draft.submission, {
      revision: preview.job.revision
    });
    assert.equal(locked.status, 200);
    assert.equal(f.emails.length, 0);
    f.mailFails(false);
    await f.q(
      "update client_jobs set notification_attempt_at=clock_timestamp()-interval '6 minutes'"
    );
    await lib.notifications();
    assert.equal(f.emails.length, 1);
    assert.deepEqual(f.emails[0].to, ['notify@test.example']);
    assert(
      f.emails[0].text.includes(`https://shop.test/?clientJob=${locked.job.id}`)
    );
    assert(!f.emails[0].text.includes('/files/'));
    assert.equal(
      new Date(locked.job.expires_at) - new Date(locked.job.confirmed_at),
      86400000
    );
    const duplicate = await call('confirm', token, draft.submission, {
      revision: preview.job.revision
    });
    assert.equal(duplicate.job.expires_at, locked.job.expires_at);
    assert.equal(f.emails.length, 1);
    assert.equal(
      (
        await call('remove', token, draft.submission, {
          id: upload.job.assets[0].id
        })
      ).status,
      400
    );
    assert.deepEqual(
      await f.one('select exports_used from profiles where id=$1', [
        f.users.basic.id
      ]),
      before,
      'public preview/confirm no quota'
    );
    const id = locked.job.id,
      file = upload.job.assets[0].id;
    assert.equal(
      (await f.owner.GET(req(`/?id=${id}`, undefined, 'unlimited'))).status,
      404
    );
    assert.equal(
      (
        await f.files.GET(req('/file', undefined, 'unlimited'), {
          params: { id, file }
        })
      ).status,
      404
    );
    assert.equal((await f.owner.GET(req('/'))).status, 401);
    const source = await f.files.GET(req('/file', undefined, 'basic'), {
      params: { id, file }
    });
    assert.equal(source.status, 200);
    assert.match(source.headers.get('Cache-Control'), /no-store/);
    assert.deepEqual(Buffer.from(await source.arrayBuffer()), png(810, 345));
    const own = await (
      await f.owner.GET(req(`/?id=${id}`, undefined, 'basic'))
    ).json();
    assert.deepEqual(
      own.job.manifest.sheets,
      preview.job.manifest.sheets,
      'confirmation locks exactly previewed coordinates'
    );
    const op = {
      exportKind: 'png',
      jobId: id,
      requestKey: randomUUID(),
      fingerprint: 'locked-client-job-source',
      action: 'prepare'
    };
    const prepared = await f.exportCall('basic', null, op);
    assert(prepared.allowed);
    assert(
      !(
        await f.exportCall('basic', null, {
          ...op,
          jobId: undefined,
          action: 'consume',
          authorization: prepared.authorization
        })
      ).allowed,
      'job cannot be stripped from ticket'
    );
    const charged = await f.exportCall('basic', null, {
      ...op,
      action: 'consume',
      authorization: prepared.authorization
    });
    assert(charged.allowed);
    await f.exportCall('basic', null, {
      ...op,
      action: 'saved',
      receipt: charged.receipt,
      authorization: prepared.authorization
    });
    assert(
      (await f.one('select downloaded_png from client_jobs where id=$1', [id]))
        .downloaded_png
    );
    await f.q(
      'update free_export_credits set balance=0,refill_from=clock_timestamp() where user_id=$1',
      [f.users.basic.id]
    );
    assert(
      !(await f.exportCall('basic', null, { ...op, requestKey: randomUUID() }))
        .allowed,
      'existing credits enforced'
    );
    await f.q(
      'update free_export_credits set balance=2,refill_from=null where user_id=$1',
      [f.users.basic.id]
    );
    const lateOp = { ...op, requestKey: randomUUID() },
      late = await f.exportCall('basic', null, lateOp);
    assert(late.allowed);
    const rotate = await f.owner.POST(req('/', { action: 'rotate' }, 'basic'));
    assert.equal(rotate.status, 200);
    assert.equal((await call('create', token)).status, 404);
    assert.equal(
      (await f.owner.GET(req(`/?id=${id}`, undefined, 'basic'))).status,
      200,
      'rotation preserves confirmed owner jobs'
    );
    await f.q(
      "update client_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [id]
    );
    assert.equal(
      (
        await f.files.GET(req('/file', undefined, 'basic'), {
          params: { id, file }
        })
      ).status,
      410
    );
    assert(
      !(
        await f.exportCall('basic', null, {
          ...lateOp,
          action: 'consume',
          authorization: late.authorization
        })
      ).allowed,
      'expiry between prepare and consume blocks cached exports'
    );
    assert.equal(
      (
        await f.one(
          'select balance from free_export_credits where user_id=$1',
          [f.users.basic.id]
        )
      ).balance,
      2
    );
    f.storageFails(true);
    await assert.rejects(() => lib.cleanup());
    assert.equal(
      (await f.one('select purged_at from client_jobs where id=$1', [id]))
        .purged_at,
      null,
      'do not claim deletion on storage failure'
    );
    f.storageFails(false);
    await lib.cleanup();
    assert.equal(f.objects.size, 0);
    const expired = await f.one('select * from client_jobs where id=$1', [id]);
    assert.equal(expired.manifest, null);
    assert.deepEqual(expired.assets, []);
    assert(expired.purged_at);
    assert.equal(expired.quantity, 22);
    assert(expired.downloaded_png);
    const rotated = (await rotate.json()).portal.url.split('/').at(-1);
    const abandoned = await call('create', rotated);
    await call('upload', rotated, abandoned.submission, png());
    await f.q(
      "update client_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [abandoned.job.id]
    );
    await lib.cleanup();
    assert.equal(f.objects.size, 0);
    await f.owner.POST(req('/', { action: 'disable' }, 'basic'));
    const disabled = await call('create', rotated);
    assert.equal(disabled.status, 403);
    assert.equal(disabled.code, 'portal_disabled');
    assert.equal(disabled.message, 'This upload portal is currently disabled.');
    assert.equal(
      (await f.maintenance.POST(req('/maintenance', {}))).status,
      401
    );
    await f.db.exec('set role authenticated');
    await assert.rejects(() => f.q('select * from client_jobs'));
    await assert.rejects(() => f.q("select ssb_client_jobs('list')"));
    await f.db.exec('reset role');
    console.log(
      'PASS: PNG CRC/native2048 validation, multi-file quantities, 300PPI/trim/horizontal rows/0.30in/meter layout, locked manifest, opaque-session isolation, owner isolation, exact24h, notification outbox retry/idempotency, quota+ticket binding, expiry mid-export, private byte-identical sources, storage failure honesty/purge/history,2h drafts,rotate/disable,RLS.'
    );
  } finally {
    await f.close();
  }
}
module.exports = { fixture, png };
if (require.main === module)
  run().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
