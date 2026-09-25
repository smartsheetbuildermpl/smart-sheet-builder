const GUEST_LIMIT = 2;
const FREE_LIMIT = 5;
const OWNER_EMAILS = ['masterprintlabcorp@gmail.com'];

function normalizeSupabaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/(?:auth|rest|storage|functions)\/v1(?:\/.*)?$/i, '').replace(/\/+$/, '');
  }
}

export function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  return {
    url: normalizeSupabaseUrl(url),
    anonKey: anonKey || '',
    serviceRoleKey: serviceRoleKey || '',
    configured: Boolean(url && anonKey && serviceRoleKey),
  };
}

export function unconfiguredPayload() {
  return {
    configured: false,
    code: 'supabase_not_configured',
    message: 'Supabase environment variables are not configured yet.',
  };
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function getAdminEmails() {
  const configuredEmails = String(process.env.SMART_SHEET_ADMIN_EMAILS || process.env.NEXT_PUBLIC_SMART_SHEET_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
  return [...new Set(OWNER_EMAILS.concat(configuredEmails))];
}

export async function supabaseFetch(path, options = {}) {
  const config = getSupabaseConfig();
  const key = options.service ? config.serviceRoleKey : config.anonKey;
  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(options.service ? { Authorization: `Bearer ${config.serviceRoleKey}` } : {}),
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers || {}),
  };

  const response = await fetch(`${config.url}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const error = new Error(data?.msg || data?.message || data?.error_description || 'Supabase request failed.');
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export function sessionFromAuth(data) {
  const source = data?.access_token ? data : data?.session;
  if (!source?.access_token) return null;
  const user = data?.user || source?.user || {};
  return {
    accessToken: source.access_token,
    refreshToken: source.refresh_token || '',
    expiresAt: source.expires_at || null,
    user: {
      id: user.id || '',
      email: normalizeEmail(user.email),
    },
  };
}

export async function getUserFromRequest(request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;

  try {
    const user = await supabaseFetch('/auth/v1/user', { token });
    if (!user.id || !user.email_confirmed_at) {
      const error = new Error('Verify your email, then sign in.');
      error.status = 401;
      throw error;
    }
    return {
      id: user.id,
      email: normalizeEmail(user.email),
      token,
    };
  } catch (error) {
    error.code = 'invalid_session';
    throw error;
  }
}

export async function getProfile(userId) {
  const rows = await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`, {
    service: true,
  });
  return rows?.[0] || null;
}

async function createProfile(user) {
  // Recovery for an older verified account only. Signup profiles are created by
  // the auth.users trigger; neither metadata nor configured emails grant roles.
  const rows = await supabaseFetch('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    service: true,
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: [
      {
        id: user.id,
        email: normalizeEmail(user.email),
        role: 'user',
        plan: 'free',
        status: 'active',
        exports_used: 0,
      },
    ],
  });
  return rows?.[0] || getProfile(user.id);
}

async function updateProfileEmail(profile, user) {
  const email = normalizeEmail(user.email);
  const isOwner = OWNER_EMAILS.includes(email);

  // The owner account is already granted Admin/Unlimited below. Avoid a redundant
  // profile PATCH on every sign-in, which is the request timing out on Vercel.
  if (isOwner || profile.email === email) return profile;

  const patch = {
    email,
    updated_at: new Date().toISOString(),
  };

  const rows = await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, {
    method: 'PATCH',
    service: true,
    headers: { Prefer: 'return=representation' },
    body: patch,
  });
  return rows?.[0] || profile;
}

export async function ensureProfile(user) {
  const current = await getProfile(user.id);
  if (!current) return createProfile(user);
  return updateProfileEmail(current, user);
}

export function isAdminProfile(profile, user) {
  const email = normalizeEmail(user?.email || profile?.email);
  return getAdminEmails().includes(email) || profile?.role === 'admin' || profile?.plan === 'admin';
}

export function canManageLibrary(user, profile) {
  // The migration binds the existing owner's UUID once. Only that same verified
  // Auth identity may manage the library; roles/plans/email metadata cannot grant it.
  return Boolean(user?.id && user.id === profile?.id && profile?.is_super_admin === true);
}

export async function getLibraryActor(request, { manage = false } = {}) {
  const user = await getUserFromRequest(request);
  if (!user) {
    const error = new Error('Please sign in to use the Design Library.');
    error.status = 401;
    error.code = 'invalid_session';
    throw error;
  }
  const profile = await ensureProfile(user);
  if (profile?.status === 'blocked') {
    const error = new Error('This account is blocked. Please contact support.');
    error.status = 403;
    error.code = 'account_blocked';
    throw error;
  }
  const canManage = canManageLibrary(user, profile);
  if (manage && !canManage) {
    const error = new Error('Only the library owner can manage designs and categories.');
    error.status = 403;
    error.code = 'owner_required';
    throw error;
  }
  return { user, profile, canManageLibrary: canManage };
}

export async function librarySignedUrl(storagePath) {
  const config = getSupabaseConfig();
  const encodedPath = String(storagePath || '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  const response = await fetch(`${config.url}/storage/v1/object/sign/smart-sheet-library/${encodedPath}`, {
    method: 'POST',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 3600 }),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !(data.signedURL || data.signedUrl)) {
    const error = new Error('Unable to prepare the library image.');
    error.status = response.status || 500;
    throw error;
  }
  const signedPath = data.signedURL || data.signedUrl;
  return signedPath.startsWith('http') ? signedPath : `${config.url}/storage/v1${signedPath}`;
}

export async function uploadLibraryPng(storagePath, bytes) {
  const config = getSupabaseConfig();
  const response = await fetch(
    `${config.url}/storage/v1/object/smart-sheet-library/${String(storagePath).split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'POST',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        'Content-Type': 'image/png',
        'x-upsert': 'false',
      },
      body: bytes,
      cache: 'no-store',
    }
  );
  if (!response.ok) {
    const error = new Error('Unable to save the PNG to Supabase Storage.');
    error.status = response.status;
    throw error;
  }
}

export async function deleteLibraryObject(storagePath) {
  if (!storagePath) return;
  const config = getSupabaseConfig();
  await fetch(`${config.url}/storage/v1/object/smart-sheet-library`, {
    method: 'DELETE',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: [storagePath] }),
    cache: 'no-store',
  });
}

export async function getGuestUsage(guestId) {
  if (!guestId) return { guest_id: '', exports_used: 0 };
  const rows = await supabaseFetch(`/rest/v1/guest_usage?guest_id=eq.${encodeURIComponent(guestId)}&select=*`, {
    service: true,
  });
  return rows?.[0] || { guest_id: guestId, exports_used: 0 };
}

export async function migrateGuestUsageToProfile(user, guestId) {
  await ensureProfile(user);
  return supabaseFetch('/rest/v1/rpc/ssb_import_guest_usage', {
    method: 'POST', service: true, body: { p_user: user.id, p_guest: String(guestId || '').slice(0, 200) },
  });
}

export function usageForProfile(profile, user) {
  const email = normalizeEmail(user?.email || profile?.email);
  const isOwner = profile?.is_super_admin === true;
  const plan = isOwner ? 'admin' : profile?.plan || 'free';
  const role = isOwner ? 'admin' : profile?.role || 'customer';
  const isAdmin = isOwner || plan === 'admin' || role === 'admin';
  const unlimited = isOwner || (profile?.export_access_override != null
    ? profile.export_access_override === 'unlimited'
    : isAdmin || plan === 'subscriber' || profile?.exports_unlimited === true);
  const used = Number(profile?.exports_used || 0);

  return {
    email,
    label: isAdmin ? 'Admin' : plan === 'subscriber' ? 'Subscribed' : unlimited ? 'Basic account' : 'Free account',
    isAdmin,
    isSuperAdmin: profile?.is_super_admin === true && profile?.status === 'active',
    canManageLibrary: profile?.status !== 'blocked' && canManageLibrary(user, profile),
    plan,
    limit: unlimited ? null : FREE_LIMIT,
    used,
    remaining: unlimited ? null : Math.max(0, FREE_LIMIT - used),
    signedIn: true,
    unlimited,
    mode: 'server',
  };
}

export function usageForGuest(guestUsage) {
  const used = Number(guestUsage?.exports_used || 0);
  return {
    email: '',
    label: 'Guest trial',
    plan: 'guest',
    limit: GUEST_LIMIT,
    used,
    remaining: Math.max(0, GUEST_LIMIT - used),
    signedIn: false,
    unlimited: false,
    mode: 'server',
  };
}

export async function recordUsageExport({ userId = null, guestId = null, exportKind = 'download' }) {
  try {
    await supabaseFetch('/rest/v1/usage_exports', {
      method: 'POST',
      service: true,
      body: [
        {
          user_id: userId,
          guest_id: guestId,
          export_kind: String(exportKind || 'download').slice(0, 40),
        },
      ],
    });
  } catch {
    // Export history is useful for audit logs, but the counter should remain the source of truth.
  }
}

export async function incrementProfileUsage(profile, user, exportKind) {
  const result = await supabaseFetch('/rest/v1/rpc/ssb_consume_export', {
    method: 'POST', service: true, body: { p_user: user.id, p_kind: String(exportKind || 'download').slice(0, 40) },
  });
  return { allowed: result.allowed === true, reason: result.reason, message: result.message, usage: usageForProfile(result.profile, user) };
}

export async function incrementGuestUsage(guestId, exportKind) {
  const guestUsage = await getGuestUsage(guestId);
  const currentUsage = usageForGuest(guestUsage);

  if (currentUsage.remaining <= 0) {
    return {
      allowed: false,
      reason: 'limit_reached',
      message: 'Guest trial used up. Create a free account for 5 total exports.',
      usage: currentUsage,
    };
  }

  const nextUsed = Number(guestUsage.exports_used || 0) + 1;
  const body = {
    guest_id: guestId,
    exports_used: nextUsed,
    last_export_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  if (guestUsage.guest_id) {
    await supabaseFetch(`/rest/v1/guest_usage?guest_id=eq.${encodeURIComponent(guestId)}`, {
      method: 'PATCH',
      service: true,
      body: {
        exports_used: nextUsed,
        last_export_at: body.last_export_at,
      },
    });
  } else {
    await supabaseFetch('/rest/v1/guest_usage', {
      method: 'POST',
      service: true,
      body: [body],
    });
  }
  await recordUsageExport({ guestId, exportKind });

  return {
    allowed: true,
    usage: usageForGuest({ ...guestUsage, exports_used: nextUsed }),
  };
}
