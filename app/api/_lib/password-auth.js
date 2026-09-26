import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getSupabaseConfig, supabaseFetch } from './supabase';
import { failure } from './user-management';

export const COOKIE = 'ssb-password-recovery';
export function json(data, status = 200) { return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }); }
export function ready() { if (!getSupabaseConfig().configured) throw failure('Password service is unavailable. Contact support.', 503); }
export function sameOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw failure('Open this form from Smart Sheet Builder and try again.', 403);
}
export function resetUrl(request) {
  const deploymentHost = process.env.VERCEL_ENV === 'preview' ? process.env.VERCEL_URL : process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const value = process.env.SMART_SHEET_SITE_URL || (deploymentHost ? `https://${deploymentHost}` : '');
  const url = new URL(value || (process.env.NODE_ENV !== 'production' ? request.url : 'https://invalid.invalid'));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!value && process.env.NODE_ENV === 'production') || url.username || url.password || (url.protocol !== 'https:' && !(local && process.env.NODE_ENV !== 'production' && url.protocol === 'http:'))) throw failure('The password recovery site URL is not configured. Contact support.', 503);
  return `${url.origin}/reset-password`;
}
function key() {
  const secret = process.env.SMART_SHEET_RECOVERY_SECRET || getSupabaseConfig().serviceRoleKey;
  if (!secret) throw failure('Password service is unavailable.', 503);
  return createHash('sha256').update(`ssb-password-cookie-v1:${secret}`).digest();
}
export function readCookie(request) {
  try {
    const value = request.cookies.get(COOKIE)?.value;
    if (!value) return null;
    const bytes = Buffer.from(value, 'base64url'), decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
    return data.expires > Date.now() ? data : null;
  } catch { return null; }
}
export function setCookie(response, request, data) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  response.cookies.set(COOKIE, Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url'), { httpOnly: true, secure: new URL(request.url).protocol === 'https:', sameSite: 'lax', path: '/api/auth/password', maxAge: 900 });
  return response;
}
export function clearCookie(response) { response.cookies.set(COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/api/auth/password', maxAge: 0 }); return response; }
export function pkce() { const verifier = randomBytes(32).toString('base64url'); return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }; }
export async function bodyFields(request, allowed) {
  let data; try { data = await request.json(); } catch { throw failure('Invalid request.', 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !allowed.includes(k))) throw failure('Only your password form fields may be submitted.', 400);
  return data;
}
export function passwordFailure(error) {
  const code = error.data?.error_code || error.data?.code;
  if (code === 'same_password') return json({ message: 'Choose a different new password.', code }, 400);
  if (code === 'weak_password') return json({ message: 'This password does not meet the account security policy. Use a longer, stronger password.', code }, 400);
  if (['reauthentication_needed', 'reauthentication_not_valid'].includes(code)) return json({ message: 'Please sign in again, then retry changing your password.', code }, 401);
  if (error.status === 429) return json({ message: 'Too many attempts. Wait a minute, then try again.' }, 429);
  const safe = !error.data && [400, 403, 503].includes(error.status);
  return json({ message: error.safeMessage || (safe ? error.message : 'Password service could not complete the request. Please try again.'), code: 'password_request_failed' }, [400, 401, 403].includes(error.status) ? error.status : 503);
}
// The same authenticated /user endpoint used by supabase.auth.updateUser.
// Never use Auth's admin-user endpoint or a service-role token for a password.
export async function updateUserPassword(token, password) { return supabaseFetch('/auth/v1/user', { method: 'PUT', token, body: { password } }); }
export async function recordPasswordChange(userId) {
  try {
    await supabaseFetch('/rest/v1/rpc/ssb_record_password_change', { method: 'POST', service: true, body: { p_user: userId } });
    return '';
  } catch {
    return 'Your password was changed, but the activity record could not be saved. Contact support; do not resubmit the password change.';
  }
}
export async function revokeTemporarySession(token) {
  try { await supabaseFetch('/auth/v1/logout?scope=local', { method: 'POST', token }); } catch { /* Credential update already succeeded. Never misreport it as failed. */ }
}
