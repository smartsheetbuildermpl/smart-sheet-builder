import { NextResponse } from 'next/server';
import { ensureProfile, getSupabaseConfig, getUserFromRequest, incrementProfileUsage, currentProfileUsage, getGuestUsage, usageForGuest, supabaseFetch, unconfiguredPayload } from '../../_lib/supabase';
import { guestIdentity, authorization, validAuthorization, validOperation } from '../../_lib/export-security';

export const dynamic = 'force-dynamic';
const reply = (data, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function POST(request) {
  if (!getSupabaseConfig().configured) return reply(unconfiguredPayload(), 501);
  let body;
  try { body = await request.json(); } catch { return reply({ allowed: false, message: 'Invalid export request.' }, 400); }
  if (!validOperation(body)) return reply({ allowed: false, message: 'Refresh Smart Sheet Builder and start a new export.' }, 400);
  try {
    const user = await getUserFromRequest(request);
    const guest = user ? null : await guestIdentity(request);
    const actor = user ? `user:${user.id}` : `guest:${guest.id}`;
    const profile = user ? await ensureProfile(user) : null;
    if (body.action === 'prepare') {
      const usage = user ? await currentProfileUsage(profile, user) : usageForGuest(await getGuestUsage(guest.id));
      if (profile?.status === 'blocked') return reply({ allowed: false, reason: 'account_blocked', message: 'This account is suspended. Contact support.', usage });
      if (!usage.unlimited && usage.remaining <= 0) return reply({ allowed: false, reason: user ? 'credits_empty' : 'limit_reached', message: user ? 'You’ve used your available free export credits.' : 'Guest trial used up. Create a free account for Free Export Credits.', usage });
      return reply({ allowed: true, usage, authorization: authorization(actor, body.exportKind, body.requestKey, body.fingerprint) });
    }
    // Preparation never charges. Recheck and deduct atomically when the final Blob exists.
    if ((!body.action || body.action === 'consume') && !validAuthorization(body.authorization, actor, body)) return reply({ allowed: false, reason: 'authorization_expired', message: 'Export authorization expired. Start the export again.' }, 403);
    if (user) return reply({ configured: true, ...await incrementProfileUsage(profile, user, body.exportKind, body) });
    const result = await supabaseFetch('/rest/v1/rpc/ssb_guest_export', { method: 'POST', service: true, body: { p_guest: guest.id, p_kind: body.exportKind, p_request: body.requestKey, p_fingerprint: body.fingerprint, p_action: body.action || 'consume', p_receipt: body.receipt || null } });
    return reply({ configured: true, allowed: result.allowed === true, reason: result.reason, message: result.message, receipt: result.receipt, duplicate: result.duplicate, usage: usageForGuest(result.guest) });
  } catch (error) {
    return reply({ allowed: false, code: error.code, message: error.code === 'invalid_session' ? 'Please sign in again.' : error.status === 401 ? error.message : 'Export access could not be verified. Reconnect and retry; no file was downloaded.' }, error.status || 503);
  }
}
