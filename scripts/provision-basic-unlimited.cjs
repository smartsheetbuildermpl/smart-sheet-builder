// Server/operator use only. Never import this module into the app or browser.
const EMAIL = 'mpl.smartsheetbuilder@gmail.com';
const normalize = value => String(value || '').trim().toLowerCase();

function configuredAdminEmails(env) {
  return String(env.SMART_SHEET_ADMIN_EMAILS || env.NEXT_PUBLIC_SMART_SHEET_ADMIN_EMAILS || '')
    .split(',').map(normalize);
}

function adminClient(env, fetchImpl = fetch) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing server configuration. Supply NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY through the secure environment or .env.local.');
  const origin = new URL(url).origin;
  if (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error('Supabase must use HTTPS outside localhost.');
  if (configuredAdminEmails(env).includes(EMAIL)) throw new Error('The target account is in the configured admin list. Remove it from that list before provisioning a basic user.');
  return async (path, method = 'GET', body) => {
    let response;
    try {
      response = await fetchImpl(origin + path, {
        method, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      });
    } catch { throw new Error('Supabase connection failed. No secret or request body has been logged.'); }
    // Do not echo server error bodies: Auth errors can contain submitted values.
    if (!response.ok) {
      const error = new Error(`Supabase ${method} request failed (HTTP ${response.status}). Check project configuration and the access migration, then rerun safely.`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
}

async function preflight(client) {
  await client('/rest/v1/profiles?select=id,exports_unlimited&limit=0');
}

async function provision({ env = process.env, password, fetchImpl = fetch } = {}) {
  const client = adminClient(env, fetchImpl);
  await preflight(client); // Fail before creating an Auth user if SQL is missing.
  let user;
  for (let page = 1; ; page++) {
    const data = await client(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const users = data.users;
    if (!Array.isArray(users)) throw new Error('Unexpected Auth user-list response. No account was created.');
    user = users.find(item => normalize(item.email) === EMAIL);
    if (user || users.length < 1000) break;
  }
  const existed = Boolean(user);
  if (!user) {
    if (typeof password !== 'string' || password.length < 6) throw new Error('A password of at least 6 characters is required for a new account. Enter it through the secure prompt.');
    const created = await client('/auth/v1/admin/users', 'POST', { email: EMAIL, password, email_confirm: true, role: 'authenticated' });
    user = created.user || created;
  }
  if (!user?.id || normalize(user.email) !== EMAIL) throw new Error('Unexpected Auth identity. No profile was modified.');
  const id = encodeURIComponent(user.id);
  const rows = await client(`/rest/v1/profiles?id=eq.${id}&select=*`);
  const entitlement = { email: EMAIL, role: 'customer', plan: 'free', status: 'active', exports_unlimited: true, updated_at: new Date().toISOString() };
  if (rows?.length) await client(`/rest/v1/profiles?id=eq.${id}`, 'PATCH', entitlement);
  else {
    try { await client('/rest/v1/profiles', 'POST', [{ id: user.id, ...entitlement }]); }
    catch (error) {
      if (error.status !== 409) throw error;
      // A sign-in/profile trigger may race provisioning; never overwrite counters.
      await client(`/rest/v1/profiles?id=eq.${id}`, 'PATCH', entitlement);
    }
  }
  if (existed) await client(`/auth/v1/admin/users/${id}`, 'PUT', { email_confirm: true, role: 'authenticated' });
  const [profile] = await client(`/rest/v1/profiles?id=eq.${id}&select=role,plan,status,exports_unlimited`);
  if (profile?.role !== 'customer' || profile?.plan !== 'free' || profile?.status !== 'active' || profile?.exports_unlimited !== true) throw new Error('Profile verification failed. Rerun provisioning before using this account.');
  return { existed, email: EMAIL, role: profile.role, unlimited: true };
}

module.exports = { provision, adminClient, preflight };

if (require.main === module) {
  (async () => {
    require('@next/env').loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    if (process.argv.includes('--check')) {
      await preflight(adminClient(process.env));
      console.log('Server configuration and entitlement column are ready.');
      return;
    }
    if (process.stdin.isTTY) throw new Error('Use scripts/provision-basic-unlimited.ps1 for a private password prompt. Do not pass passwords as command arguments.');
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 16384) throw new Error('Provisioning input is too large.');
    }
    let credentials;
    try { credentials = JSON.parse(input); } catch { throw new Error('Invalid secure input. Use the PowerShell provisioning script.'); }
    input = '';
    const result = await provision({ password: credentials.password });
    credentials.password = '';
    console.log(`${result.existed ? 'Updated existing' : 'Created'} account ${result.email}: basic user, unlimited exports, email confirmed, no admin or library management access.`);
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
