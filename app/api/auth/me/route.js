import { NextResponse } from 'next/server';
import {
  ensureProfile,
  getSupabaseConfig,
  getUserFromRequest,
  unconfiguredPayload,
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
    if (!user) {
      return NextResponse.json({ code: 'invalid_session', message: 'Please sign in.' }, { status: 401 });
    }
    const profile = await ensureProfile(user);

    return NextResponse.json({
      configured: true,
      usage: usageForProfile(profile, user),
    });
  } catch (error) {
    return NextResponse.json(
      { code: error.code || 'invalid_session', message: error.message || 'Please sign in again.' },
      { status: error.status || 401 }
    );
  }
}
