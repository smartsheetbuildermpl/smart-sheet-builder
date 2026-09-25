const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { provision } = require('../scripts/provision-basic-unlimited.cjs');

// Execute the actual route modules with only the Supabase network boundary mocked.
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const source = fs.readFileSync(file, 'utf8');
  const names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m => m[1]);
  const code = source.replace(/import \{([\s\S]*?)\} from '([^']+)';/g, (_, names, spec) => `const {${names}} = imports(${JSON.stringify(spec)});`).replace(/export /g, '');
  const result = new Function('imports', `${code}\nreturn {${names.join(',')}};`)(spec => spec === 'next/server' ? require('next/server') : load(path.resolve(path.dirname(file), spec + '.js')));
  cache.set(file, result);
  return result;
}

const owner = { id: 'owner-id', email: 'masterprintlabcorp@gmail.com' };
const basic = { id: 'basic-id', email: 'mpl.smartsheetbuilder@gmail.com' };
const other = { id: 'other-id', email: 'other-admin@example.test' };
const ordinary = { id: 'free-id', email: 'ordinary@example.test' };
const users = { owner, basic, other, ordinary };
Object.values(users).forEach(u => { u.email_confirmed_at = '2026-09-01T00:00:00Z'; });
const profiles = Object.fromEntries(Object.values(users).map(u => [u.id, { id: u.id, email: u.email, is_super_admin: u === owner, role: u === other ? 'admin' : 'customer', plan: 'free', status: 'active', exports_used: 5, exports_unlimited: u === basic }]));
const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon', SUPABASE_SERVICE_ROLE_KEY: 'test-service', SMART_SHEET_ADMIN_EMAILS: other.email };
Object.assign(process.env, env);
const writes = [];
let guestUsed = 0;
const design = { id: 'design-id', name: 'Test design', visible: true, storage_path: 'designs/test.png', width_px: 1, height_px: 1 };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  const u = new URL(url), method = options.method || 'GET', body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : null;
  if (u.pathname === '/auth/v1/user') return users[options.headers.Authorization?.slice(7)] ? response(users[options.headers.Authorization.slice(7)]) : response({ message: 'Invalid token' }, 401);
  if (method !== 'GET') writes.push({ path: u.pathname, method, body });
  if (u.pathname === '/rest/v1/rpc/ssb_import_guest_usage') return response(profiles[body.p_user]);
  if (u.pathname === '/rest/v1/rpc/ssb_consume_export') {
    const p = profiles[body.p_user];
    const unlimited = p.is_super_admin || p.exports_unlimited || p.role === 'admin';
    const allowed = p.status !== 'blocked' && (unlimited || p.exports_used < 5);
    if (allowed && !unlimited) p.exports_used++;
    return response({ allowed, profile: p });
  }
  if (u.pathname === '/rest/v1/profiles') {
    const id = u.searchParams.get('id')?.slice(3);
    if (method === 'PATCH') Object.assign(profiles[id], body);
    return response(profiles[id] ? [profiles[id]] : []);
  }
  if (u.pathname === '/rest/v1/guest_usage') {
    if (method === 'PATCH') guestUsed = body.exports_used;
    return response([{ guest_id: 'test-guest', exports_used: guestUsed }]);
  }
  if (u.pathname === '/rest/v1/design_library_designs') {
    const rows = [design, { ...design, id: 'hidden-id', visible: false }];
    return response(method === 'GET' ? (u.searchParams.has('id') ? [design] : u.searchParams.get('visible') === 'eq.true' ? rows.slice(0, 1) : rows) : [design]);
  }
  if (u.pathname === '/rest/v1/design_library_categories') return response([{ id: 'category-id', name: 'Test' }]);
  if (u.pathname.includes('/object/sign/')) return response({ signedURL: '/object/sign/test.png?token=test-only' });
  return response({});
};
function req(route, method, token, body) {
  return new Request(`http://localhost${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) });
}

(async () => {
  try {
    const lib = load('app/api/_lib/supabase.js');
    const catalog = load('app/api/library/route.js');
    const me = load('app/api/auth/me/route.js');
    const consume = load('app/api/export/consume/route.js');
    const mutations = [
      ['app/api/library/designs/route.js', 'POST'],
      ['app/api/library/designs/[id]/route.js', 'PATCH'],
      ['app/api/library/designs/[id]/route.js', 'DELETE'],
      ['app/api/library/categories/route.js', 'POST'],
      ['app/api/library/categories/[id]/route.js', 'PATCH'],
      ['app/api/library/categories/[id]/route.js', 'DELETE'],
    ];
    for (const token of [null, 'invalid', 'ordinary', 'basic', 'other']) {
      for (const [file, method] of mutations) {
        const start = writes.length;
        const result = await load(file)[method](req('/api/library/designs/design-id', method, token, method === 'DELETE' ? undefined : {}), { params: { id: 'design-id' } });
        assert.equal(result.status, token && token !== 'invalid' ? 403 : 401, `${token}: ${file} ${method}`);
        assert(!writes.slice(start).some(w => /design_library|storage/.test(w.path)), 'denied before catalog or storage mutations');
      }
    }
    for (const token of ['owner', 'basic', 'other', 'ordinary']) {
      const usage = (await (await me.GET(req('/api/auth/me', 'GET', token))).json()).usage;
      assert.equal(usage.canManageLibrary, token === 'owner');
      assert.equal(usage.isAdmin, token === 'owner' || token === 'other');
      assert.equal(usage.unlimited, token !== 'ordinary');
      if (token === 'basic') { assert.equal(usage.label, 'Basic account'); assert.equal(usage.plan, 'free'); }
      const data = await (await catalog.GET(req('/api/library?includeHidden=true', 'GET', token))).json();
      assert.equal(data.canManageLibrary, token === 'owner');
      assert.equal(data.designs.length, token === 'owner' ? 2 : 1, 'non-owner cannot request hidden designs');
      const used = profiles[users[token].id].exports_used;
      for (let i = 0; i < 7; i++) {
        const result = await (await consume.POST(req('/api/export/consume', 'POST', token, { exportKind: i % 2 ? 'png' : 'tiff' }))).json();
        assert.equal(result.allowed, token !== 'ordinary', 'unlimited accounts bypass the exhausted free allowance');
      }
      assert.equal(profiles[users[token].id].exports_used, used);
    }
    assert.equal(lib.usageForProfile({ ...profiles[basic.id], exports_unlimited: false }, basic).unlimited, false, 'email alone never grants unlimited');
    assert.equal(lib.canManageLibrary({ email: other.email }), false, 'configured admin cannot manage');
    assert.equal(lib.canManageLibrary(null), false, 'profile data alone cannot grant management');
    profiles[basic.id].status = 'blocked';
    assert.equal((await (await consume.POST(req('/api/export/consume', 'POST', 'basic', {}))).json()).allowed, false);
    assert.equal((await catalog.GET(req('/api/library', 'GET', 'basic'))).status, 403);
    profiles[basic.id].status = 'active';
    profiles[ordinary.id].exports_used = 0;
    for (let i = 0; i < 6; i++) assert.equal((await (await consume.POST(req('/api/export/consume', 'POST', 'ordinary', {}))).json()).allowed, i < 5);
    for (let i = 0; i < 3; i++) assert.equal((await (await consume.POST(req('/api/export/consume', 'POST', null, { guestId: 'test-guest' }))).json()).allowed, i < 2);
    await lib.migrateGuestUsageToProfile(basic, 'test-guest');
    assert.equal(profiles[basic.id].exports_used, 5, 'entitlement and export history survive login migration');
    for (const [file, method] of mutations) {
      let body = method === 'DELETE' ? undefined : { name: 'Test', categoryId: 'category-id', tags: ['new'], visible: false };
      if (file.endsWith('/designs/route.js')) {
        body = new FormData(); body.set('name', 'Test');
        body.set('file', new Blob([Uint8Array.from([137,80,78,71,13,10,26,10])], { type: 'image/png' }), 'test.png');
      }
      const result = await load(file)[method](req('/api/library', method, 'owner', body), { params: { id: 'design-id' } });
      assert(result.ok, `owner allowed: ${file} ${method}, ${result.status}`);
    }

    // Account provisioning: repeat-safe, no password reset, no history reset.
    let authUsers = [], saved = null, created = 0, authUpdates = [];
    const provisionFetch = async (url, options) => {
      const u = new URL(url), method = options.method, body = options.body ? JSON.parse(options.body) : null;
      if (u.pathname === '/rest/v1/profiles') {
        if (method === 'POST') saved = { exports_used: 0, ...body[0] };
        if (method === 'PATCH') Object.assign(saved, body);
        return response(saved ? [saved] : []);
      }
      if (u.pathname === '/auth/v1/admin/users' && method === 'GET') return response({ users: authUsers });
      if (u.pathname === '/auth/v1/admin/users' && method === 'POST') {
        created++; assert.equal(body.email_confirm, true); assert.equal(body.role, 'authenticated');
        authUsers = [{ id: 'provisioned-id', email: body.email }]; return response(authUsers[0]);
      }
      if (method === 'PUT') { authUpdates.push(body); return response(authUsers[0]); }
      throw Error('Unexpected provision request');
    };
    const first = await provision({ env, password: 'synthetic-test-only', fetchImpl: provisionFetch });
    assert.equal(first.existed, false); assert.equal(saved.exports_unlimited, true);
    saved.role = 'admin'; saved.plan = 'admin'; saved.exports_used = 12;
    const second = await provision({ env, fetchImpl: provisionFetch });
    assert.equal(second.existed, true); assert.equal(created, 1); assert.equal(saved.role, 'customer'); assert.equal(saved.plan, 'free'); assert.equal(saved.exports_used, 12);
    assert.deepEqual(authUpdates, [{ email_confirm: true, role: 'authenticated' }]);
    await assert.rejects(provision({ env: { ...env, SMART_SHEET_ADMIN_EMAILS: basic.email }, fetchImpl: provisionFetch }), /admin list/);
    await assert.rejects(provision({ env, password: 'synthetic-test-only', fetchImpl: async () => response({}, 400) }), /HTTP 400/);
    console.log('Access checks passed: real route guards for all six mutations; owner vs basic unlimited vs configured admin vs ordinary vs guest; hidden catalog protection; 2/5 export limits; blocked account; repeat-safe provisioning and history/password preservation (mock Supabase).');
  } finally { global.fetch = originalFetch; }
})().catch(error => { console.error(error); process.exitCode = 1; });
