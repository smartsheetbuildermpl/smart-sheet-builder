import { NextResponse } from 'next/server';
import { getSupabaseConfig, getUserFromRequest, ensureProfile, supabaseFetch } from './supabase';

const fields = { full_name: 120, business_name: 160, mobile: 40, city: 100, country: 100, machine_type: 20, monthly_usage: 100 };
export function profileFields(body, { registration = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('Invalid profile.', 400);
  const allowed = [...Object.keys(fields), ...(registration ? ['terms_accepted'] : [])];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw failure('Only registration profile fields may be edited.', 400);
  const data = {};
  for (const [key, length] of Object.entries(fields)) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'string' || body[key].length > length) throw failure(`Invalid ${key.replaceAll('_', ' ')} (maximum ${length} characters).`, 400);
    data[key] = body[key].trim();
  }
  if ((registration || 'full_name' in data) && !data.full_name) throw failure('Full name is required.', 400);
  if (data.machine_type && !['DTF', 'UV-DTF', 'Tarpaulin', 'Other'].includes(data.machine_type)) throw failure('Choose a supported printing use.', 400);
  if (registration) data.terms_accepted = body.terms_accepted === true;
  return data;
}
export function failure(message, status) { const error = new Error(message); error.status = status; return error; }
export function apiError(error) {
  const code = error.data?.code;
  const status = code === '42501' ? 403 : code === '40001' ? 409 : code === 'P0002' ? 404 : code === 'PGRST202' ? 503 : code === '22023' || error instanceof SyntaxError ? 400 : error.status || 500;
  return NextResponse.json({ message: status >= 500 ? 'Account service unavailable. Check that the user-management migration is installed, then retry.' : error.message }, { status, headers: { 'Cache-Control': 'no-store' } });
}
export async function accountActor(request, owner = false) {
  if (!getSupabaseConfig().configured) throw failure('Account service is not configured.', 503);
  const user = await getUserFromRequest(request);
  if (!user) throw failure('Please sign in.', 401);
  const profile = await ensureProfile(user);
  if (profile.status !== 'active') throw failure('This account is suspended. Contact support.', 403);
  if (owner) {
    if (profile.is_super_admin !== true) throw failure('Super Admin required.', 403);
    await rpc('ssb_require_owner', { p_actor: user.id });
  }
  return { user, profile };
}
export async function rpc(name, body) { return supabaseFetch(`/rest/v1/rpc/${name}`, { method: 'POST', service: true, body }); }
export function userId(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw failure('Invalid user ID.', 400);
  return id;
}
export function offset(value) { return Math.max(0, Math.min(1000000, Number.parseInt(value, 10) || 0)); }
