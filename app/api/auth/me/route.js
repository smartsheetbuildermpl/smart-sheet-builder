import { NextResponse } from 'next/server';
import {
  ensureProfile,
  getSupabaseConfig,
  getUserFromRequest,
  unconfiguredPayload,
  currentProfileUsage,
} from '../../_lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const config = getSupabaseConfig();
  if (!config.configured) {
    return NextResponse.json(unconfiguredPayload(), { status: 501 });
  }

  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ code: 'invalid_session', message: 'Please sign in.' }, { status: 401 });
    }
    const profile = await ensureProfile(user);
    if (profile.status === 'blocked') return NextResponse.json({ code: 'account_blocked', message: 'This account is suspended. Contact support.' }, { status: 403 });

    return NextResponse.json({
      configured: true,
      usage: await currentProfileUsage(profile, user),
    });
  } catch (error) {
    return NextResponse.json(
      { code: error.code || 'account_unavailable', message: error.message || 'Account status temporarily unavailable.' },
      { status: error.status || 503 }
    );
  }
}
