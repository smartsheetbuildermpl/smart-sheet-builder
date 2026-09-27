import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { getSupabaseConfig, supabaseFetch } from './supabase';

const COOKIE = 'ssb_guest_trial';
function secret() {
  const value = process.env.SMART_SHEET_EXPORT_SECRET || getSupabaseConfig().serviceRoleKey;
  if (!value) throw new Error('Export authorization is not configured.');
  return value;
}
function mac(value) { return createHmac('sha256', secret()).update(value).digest('base64url'); }
export function seal(data) { const payload = Buffer.from(JSON.stringify(data)).toString('base64url'); return `${payload}.${mac(payload)}`; }
export function unseal(value) {
  try {
    const [payload, signature, extra] = String(value || '').split('.');
    if (extra || !signature) return null;
    const expected = Buffer.from(mac(payload)), actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch { return null; }
}
export async function guestIdentity(request, { create = false } = {}) {
  const value = request.cookies?.get(COOKIE)?.value;
  const guest = unseal(value);
  if (guest?.type === 'guest' && guest.exp > Date.now() && /^[0-9a-f-]{36}$/.test(guest.id)) return { id: guest.id };
  if (!create) { const error = new Error('Reload the app to initialize your guest trial.'); error.status = 401; throw error; }
  // Only trust Vercel's overwritten ingress header. Other deployments must name
  // an IP header that their reverse proxy strips/overwrites, never a client IP.
  const header = process.env.VERCEL ? 'x-vercel-forwarded-for' : process.env.SMART_SHEET_TRUSTED_IP_HEADER;
  const ip = header ? String(request.headers.get(header) || '').split(',')[0].trim() : '';
  const network = isIP(ip) ? mac(`guest-network:${ip}`) : null;
  const id = randomUUID();
  // A legacy hint can only import already-spent quota, never create credits.
  const legacy = new URL(request.url).searchParams.get('legacyGuestId');
  const result = await supabaseFetch('/rest/v1/rpc/ssb_create_guest', { method: 'POST', service: true, body: { p_guest: id, p_network: network, p_legacy: legacy?.slice(0, 200) || null } });
  if (!result.allowed) { const error = new Error('Too many new guest trials from this network. Try again in an hour or sign in. Existing guest trials still work.'); error.status = 429; throw error; }
  return { id, cookie: seal({ type: 'guest', id, exp: Date.now() + 365 * 86400000 }) };
}
export function attachGuest(response, identity) {
  if (identity?.cookie) response.cookies.set(COOKIE, identity.cookie, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 365 * 86400 });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
export function authorization(actor, kind, requestKey, fingerprint) {
  return seal({ type: 'export', actor, kind, requestKey, fingerprint, exp: Date.now() + 10 * 60000 });
}
export function validAuthorization(token, actor, body) {
  const value = unseal(token);
  return value?.type === 'export' && value.exp > Date.now() && value.actor === actor && value.kind === body.exportKind && value.requestKey === body.requestKey && value.fingerprint === body.fingerprint;
}
export function validOperation(body) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return body && !Array.isArray(body) && ['png','tiff'].includes(body.exportKind) && uuid.test(body.requestKey || '') && typeof body.fingerprint === 'string' && /^[a-zA-Z0-9:._-]{8,200}$/.test(body.fingerprint) &&
    ['prepare','consume','saved','refund'].includes(body.action || 'consume') && (!['saved','refund'].includes(body.action) || uuid.test(body.receipt || '')) &&
    !Object.keys(body).some(k => !['exportKind','guestId','requestKey','fingerprint','action','receipt','authorization'].includes(k));
}
