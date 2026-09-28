'use client';
import { createClient } from '@supabase/supabase-js';

let client;
const MIGRATED = 'ssb-auth-sdk-migrated-v1';
export function browserAuth() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || typeof window === 'undefined') return null;
  // Match the server: legacy configuration sometimes includes /rest/v1/.
  // Passing that path to the SDK sends Auth traffic to /rest/v1/auth/v1.
  if (!client) client = createClient(new URL(url.trim()).origin, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'ssb-supabase-auth-v1' } });
  return client.auth;
}
export function appSession(session) {
  return session?.access_token ? { accessToken: session.access_token, refreshToken: session.refresh_token, expiresAt: session.expires_at, user: { id: session.user?.id, email: session.user?.email } } : null;
}
export async function restoreSession(legacy, { force = false } = {}) {
  const auth = browserAuth();
  if (!auth) return legacy;
  let result = await auth.getSession();
  if (result.error) throw result.error;
  // Import the previous REST-login session once. Never overwrite a newer SDK
  // refresh token with the older compatibility copy.
  if (!result.data.session && legacy?.refreshToken && !localStorage.getItem(MIGRATED)) result = await auth.setSession({ access_token: legacy.accessToken, refresh_token: legacy.refreshToken });
  else if (force && result.data.session) result = await auth.refreshSession();
  if (result.error) throw result.error;
  if (result.data.session) localStorage.setItem(MIGRATED, '1');
  return appSession(result.data.session) || (legacy?.refreshToken || localStorage.getItem(MIGRATED) ? null : legacy);
}
export async function adoptSession(session) {
  const auth = browserAuth();
  if (!auth || !session?.refreshToken) return session;
  const { data, error } = await auth.setSession({ access_token: session.accessToken, refresh_token: session.refreshToken });
  if (error) throw error;
  localStorage.setItem(MIGRATED, '1');
  return appSession(data.session);
}
export function terminalAuthError(error) {
  return ['refresh_token_not_found','refresh_token_already_used','session_not_found','session_expired','invalid_refresh_token'].includes(error?.code) ||
    (error?.name === 'AuthApiError' && [400,401,403].includes(error.status) && /refresh token|session.*expired/i.test(error.message));
}
