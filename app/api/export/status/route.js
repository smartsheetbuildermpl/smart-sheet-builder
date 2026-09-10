import { NextResponse } from 'next/server';
import {
  ensureProfile,
  getGuestUsage,
  getSupabaseConfig,
  getUserFromRequest,
  unconfiguredPayload,
  usageForGuest,
  usageForProfile,
} from '../../_lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const config = getSupabaseConfig();
  if (!config.configured) {
    return NextResponse.json(unconfiguredPayload(), { status: 501 });
  }

  try {
    const user = await getUserFromRequest(request);
    if (user) {
      const profile = await ensureProfile(user);
      return NextResponse.json({ configured: true, usage: usageForProfile(profile, user) });
    }
  } catch {
    return NextResponse.json({ code: 'invalid_session', message: 'Please sign in again.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const guestId = String(searchParams.get('guestId') || '');
  const guestUsage = await getGuestUsage(guestId);

  return NextResponse.json({
    configured: true,
    usage: usageForGuest(guestUsage),
  });
}
