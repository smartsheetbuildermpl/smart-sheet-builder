import { getSupabaseConfig } from './supabase';

// Recovery has its own short-lived, in-memory SDK instance. Never adopt it into
// the regular browser login client or change registration/session detection.
async function recoveryAuth(verifier) {
  const { createClient } = await import('@supabase/supabase-js');
  const config = getSupabaseConfig(), storageKey = 'ssb-recovery-exchange';
  const values = new Map(verifier ? [[`${storageKey}-code-verifier`, JSON.stringify(`${verifier}/recovery`)]] : []);
  return createClient(config.url, config.anonKey, { auth: {
    storageKey, flowType: 'pkce', detectSessionInUrl: false,
    autoRefreshToken: false, persistSession: true,
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  }, global: { fetch: (...args) => fetch(...args) } }).auth;
}

export async function exchangeRecoveryCode(code, verifier) {
  const auth = await recoveryAuth(verifier);
  const { data, error } = await auth.exchangeCodeForSession(code);
  if (error) throw error;
  if (data.redirectType !== 'recovery' || !data.session?.access_token || !data.user?.id) throw new Error('No recovery session');
  return { ...data.session, user: data.user };
}

export async function establishRecoveryTokens(access_token, refresh_token) {
  const auth = await recoveryAuth();
  const { data, error } = await auth.setSession({ access_token, refresh_token });
  if (error) throw error;
  if (!data.session?.access_token || !data.user?.id) throw new Error('No recovery session');
  return { ...data.session, user: data.user };
}
