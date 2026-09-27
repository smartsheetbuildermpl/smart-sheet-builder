import { NextResponse } from 'next/server';
import { ensureProfile, getGuestUsage, getSupabaseConfig, getUserFromRequest, unconfiguredPayload, usageForGuest, currentProfileUsage } from '../../_lib/supabase';
import { guestIdentity, attachGuest } from '../../_lib/export-security';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  if (!getSupabaseConfig().configured) return NextResponse.json(unconfiguredPayload(), { status: 501 });
  try {
    const user = await getUserFromRequest(request);
    if (user) {
      const profile = await ensureProfile(user);
      if (profile.status === 'blocked') return NextResponse.json({ code: 'account_blocked', message: 'This account is suspended. Contact support.' }, { status: 403 });
      return attachGuest(NextResponse.json({ configured: true, usage: await currentProfileUsage(profile, user) }));
    }
    const guest = await guestIdentity(request, { create: true });
    return attachGuest(NextResponse.json({ configured: true, usage: usageForGuest(await getGuestUsage(guest.id)) }), guest);
  } catch (error) {
    return attachGuest(NextResponse.json({ code: error.code || 'status_unavailable', message: error.status === 429 ? error.message : 'Account status is temporarily unavailable. Reconnect and retry.' }, { status: error.status || 503 }));
  }
}
