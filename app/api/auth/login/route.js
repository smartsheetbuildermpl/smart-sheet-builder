import { NextResponse } from 'next/server';
import {
  getSupabaseConfig,
  migrateGuestUsageToProfile,
  sessionFromAuth,
  supabaseFetch,
  unconfiguredPayload,
  usageForProfile,
} from '../../_lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const config = getSupabaseConfig();
  if (!config.configured) {
    return NextResponse.json(unconfiguredPayload(), { status: 501 });
  }

  const body = await request.json();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const guestId = String(body.guestId || '');

  if (!email || !password) {
    return NextResponse.json({ message: 'Email and password are required.' }, { status: 400 });
  }

  try {
    const auth = await supabaseFetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email, password },
    });
    const session = sessionFromAuth(auth);
    const user = { id: auth.user.id, email: auth.user.email };
    const profile = await migrateGuestUsageToProfile(user, guestId);

    return NextResponse.json({
      configured: true,
      message: 'Signed in. Your export counter is now server-side.',
      session,
      usage: usageForProfile(profile, user),
    });
  } catch (error) {
    return NextResponse.json(
      { message: error.data?.error_description || error.data?.msg || error.message || 'Sign in failed.' },
      { status: error.status || 401 }
    );
  }
}
