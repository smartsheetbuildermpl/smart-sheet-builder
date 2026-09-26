const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { NextRequest } = require('next/server');
const cache = new Map();
function load(file) {
  file = path.resolve(file); if (cache.has(file)) return cache.get(file);
  const source = fs.readFileSync(file, 'utf8'), names = [...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m => m[1]);
  const code = source.replace(/import \{([\s\S]*?)\} from '([^']+)';/g, (_, n, s) => `const {${n}}=imports(${JSON.stringify(s)});`).replace(/export /g, '');
  const result = new Function('imports', `${code}\nreturn {${names.join(',')}};`)(s => s === 'next/server' || s.startsWith('node:') ? require(s) : load(path.resolve(path.dirname(file), s + '.js')));
  cache.set(file, result); return result;
}
Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-test', SUPABASE_SERVICE_ROLE_KEY: 'service-key-test', SMART_SHEET_SITE_URL: 'https://builder.example.test', NODE_ENV: 'production' });
const user = { id: '00000000-0000-4000-8000-000000000002', email: 'user@example.test', email_confirmed_at: '2026-01-01T00:00:00Z' };
const snapshot = { role: 'user', exports_used: 4, exports_unlimited: false, can_manage_design_library: false, full_name: 'Unchanged' };
const calls = [], tickets = new Set(); let recoveryConsumed = false, wrongIdentity = false, auditFailure = false;
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
global.fetch = async (url, options = {}) => {
  const u = new URL(url), body = options.body ? JSON.parse(options.body) : null, token = options.headers?.Authorization?.slice(7);
  calls.push({ path: u.pathname, query: u.searchParams, method: options.method, body, token });
  assert(!u.pathname.includes('/admin/'), 'never use administrative password APIs');
  if (u.pathname === '/auth/v1/recover') return body.email === 'limited@example.test' ? response({ message: 'account-specific rate limit' }, 429) : body.email === 'smtp@example.test' ? response({ message: 'account-specific SMTP failure' }, 500) : response({});
  if (u.pathname === '/auth/v1/verify') { if (body.token_hash !== 'a'.repeat(64) || recoveryConsumed) return response({ message: 'expired' }, 403); recoveryConsumed = true; return response({ access_token: 'recovery-token', user }); }
  if (u.pathname === '/auth/v1/token') {
    if (u.searchParams.get('grant_type') === 'pkce') return body.auth_code === 'valid-code' && body.code_verifier ? response({ access_token: 'recovery-token', user }) : response({ message: 'bad code' }, 400);
    return body.password === 'correct-current' ? response({ access_token: 'fresh-token', user: wrongIdentity ? { ...user, id: 'different' } : user }) : response({ message: 'invalid credentials' }, 400);
  }
  if (u.pathname === '/auth/v1/user') {
    assert.notEqual(token, 'service-key-test', 'password update must use user JWT');
    if (!['session-token', 'fresh-token', 'recovery-token'].includes(token)) return response({ message: 'Expired' }, 401);
    if (options.method === 'PUT') { assert.deepEqual(Object.keys(body), ['password']); return response(user); }
    return response(user);
  }
  if (u.pathname === '/rest/v1/rpc/ssb_create_password_recovery') { const id = `ticket-${tickets.size}`; tickets.add(id); return response(id); }
  if (u.pathname === '/rest/v1/rpc/ssb_claim_password_recovery') { const exists = tickets.delete(body.p_ticket); return response(exists); }
  if (u.pathname === '/rest/v1/rpc/ssb_record_password_change') { assert.deepEqual(body, { p_user: user.id }); return auditFailure ? response({ message: 'unavailable' }, 500) : response(null); }
  if (u.pathname === '/auth/v1/logout') return response(null);
  throw new Error(`Unexpected call: ${u.pathname}`);
};
const req = (name, body, { token, cookie, origin = 'https://builder.example.test' } = {}) => new NextRequest(`https://builder.example.test/api/auth/password/${name}`, { method: 'POST', headers: { origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = r => r.headers.get('set-cookie')?.split(';')[0];
(async () => {
  const request = load('app/api/auth/password/request/route.js'), verify = load('app/api/auth/password/verify/route.js'), reset = load('app/api/auth/password/reset/route.js'), change = load('app/api/auth/password/change/route.js');
  const helper = load('app/api/_lib/password-auth.js');
  let firstMessage;
  for (const email of [user.email, 'unknown@example.test', 'limited@example.test', 'smtp@example.test']) {
    const start = calls.length, r = await request.POST(req('request', { email })), data = await r.json();
    assert.equal(r.status, 200); firstMessage ||= data.message; assert.equal(data.message, firstMessage); assert.equal(data.retryAfter, 60);
    assert.equal(calls.length - start, 1, 'request never touches profiles or permissions');
    assert.equal(calls.at(-1).query.get('redirect_to'), 'https://builder.example.test/reset-password');
    assert.equal(calls.at(-1).body.code_challenge_method, 's256');
    assert.match(r.headers.get('set-cookie'), /HttpOnly/i); assert.match(r.headers.get('set-cookie'), /Secure/i);
    const again = await request.POST(req('request', { email }, { cookie: cookieOf(r) })); assert.equal((await again.json()).message, firstMessage); assert.equal(calls.length - start, 1, 'server resend cooldown');
  }
  assert.equal((await request.POST(req('request', { email: user.email, redirectTo: 'https://evil.test' }))).status, 400);
  assert.equal((await request.POST(req('request', { email: user.email }, { origin: 'https://evil.test' }))).status, 403);
  delete process.env.SMART_SHEET_SITE_URL; process.env.VERCEL_PROJECT_PRODUCTION_URL = 'production.example.test'; assert.equal(helper.resetUrl(req('request', {})), 'https://production.example.test/reset-password'); delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  assert.throws(() => helper.resetUrl(req('request', {}))); process.env.SMART_SHEET_SITE_URL = 'https://builder.example.test';
  const sent = await request.POST(req('request', { email: user.email }));
  assert.equal((await verify.POST(req('verify', { code: 'valid-code' }))).status, 401, 'PKCE needs original browser proof');
  let verified = await verify.POST(req('verify', { code: 'valid-code' }, { cookie: cookieOf(sent) })); assert.equal(verified.status, 200); assert.deepEqual(await verified.json(), { ready: true }, 'do not expose Auth tokens');
  const recoveryCookie = cookieOf(verified);
  const credentials = { password: 'new-password-123', confirmation: 'new-password-123' };
  assert.equal((await reset.POST(req('reset', { ...credentials, confirmation: 'mismatch' }, { cookie: recoveryCookie }))).status, 400);
  assert.equal((await reset.POST(req('reset', credentials, { token: 'session-token' }))).status, 401, 'ordinary bearer cannot bypass current password');
  assert.equal((await reset.POST(req('reset', credentials, { cookie: recoveryCookie + 'tampered' }))).status, 401);
  let r = await reset.POST(req('reset', credentials, { cookie: recoveryCookie })); assert.equal(r.status, 200); assert.equal((await r.json()).message, 'Password changed successfully');
  assert.equal((await reset.POST(req('reset', credentials, { cookie: recoveryCookie }))).status, 401, 'same cookie cannot replay reset');
  assert.equal((await verify.POST(req('verify', { token_hash: 'invalid-hash' }))).status, 401);
  verified = await verify.POST(req('verify', { token_hash: 'a'.repeat(64) })); assert.equal(verified.status, 200);
  assert.equal((await verify.POST(req('verify', { token_hash: 'a'.repeat(64) }))).status, 401, 'used email link rejected');
  const data = { ...credentials, currentPassword: 'correct-current' };
  for (const token of [undefined, 'expired-token']) assert.equal((await change.POST(req('change', data, { token }))).status, 401);
  const before = calls.filter(c => c.method === 'PUT').length;
  assert.equal((await change.POST(req('change', { ...data, currentPassword: 'wrong' }, { token: 'session-token' }))).status, 400);
  assert.equal((await change.POST(req('change', { ...data, confirmation: 'different' }, { token: 'session-token' }))).status, 400);
  assert.equal((await change.POST(req('change', { ...data, userId: 'owner-id' }, { token: 'session-token' }))).status, 400);
  wrongIdentity = true; assert.equal((await change.POST(req('change', data, { token: 'session-token' }))).status, 401); wrongIdentity = false;
  assert.equal(calls.filter(c => c.method === 'PUT').length, before);
  r = await change.POST(req('change', data, { token: 'session-token' })); assert.equal(r.status, 200); assert.equal((await r.json()).message, 'Password changed successfully');
  assert.equal(calls.findLast(c => c.method === 'PUT').token, 'fresh-token');
  assert.equal(calls.findLast(c => c.path === '/auth/v1/token').body.email, user.email, 'identity comes from verified session');
  auditFailure = true; r = await change.POST(req('change', data, { token: 'session-token' })); const failedAudit = await r.json(); assert.equal(r.status, 200); assert.match(failedAudit.warning, /activity record could not be saved/);
  assert(!calls.some(c => c.path === '/rest/v1/profiles'));
  assert.deepEqual(snapshot, { role: 'user', exports_used: 4, exports_unlimited: false, can_manage_design_library: false, full_name: 'Unchanged' });
  console.log('PASS: identical known/unknown/rate-limited/SMTP-error messages, trusted redirect, cooldown, CSRF, PKCE, single-use recovery, tampered/expired sessions, current-password reauthentication, identity binding, validation, password-free audit, no profile/permission/usage writes.');
})().catch(e => { console.error(e); process.exitCode = 1; });
