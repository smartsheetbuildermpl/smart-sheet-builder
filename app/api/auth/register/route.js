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

  if (password.length < 6) {
    return NextResponse.json({ message: 'Password must be at least 6 characters.' }, { status: 400 });
  }

  try {
    const auth = await supabaseFetch('/auth/v1/signup', {
      method: 'POST',
      body: { email, password },
    });

    const authUser = auth.user || auth;
    const user = {
      id: authUser?.id,
      email: authUser?.email || email,
    };

    if (!user.id) {
      return NextResponse.json(
        { message: 'Account created. Check your email to finish registration.' },
        { status: 202 }
      );
    }

    const profile = await migrateGuestUsageToProfile(user, guestId);
    const session = sessionFromAuth(auth);

    return NextResponse.json({
      configured: true,
      message: session
        ? 'Free account created. You now have 5 total trial exports.'
        : 'Free account created. Check your email, then sign in.',
      session,
      usage: usageForProfile(profile, user),
    });
  } catch (error) {
    return NextResponse.json(
      { message: error.data?.msg || error.data?.message || error.message || 'Registration failed.' },
      { status: error.status || 400 }
    );
  }
}
