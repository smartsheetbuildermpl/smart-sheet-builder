import { NextResponse } from 'next/server';
import {
  getSupabaseConfig,
  migrateGuestUsageToProfile,
  sessionFromAuth,
  supabaseFetch,
  unconfiguredPayload,
  usageForProfile,
} from '../../_lib/supabase';
import { profileFields, apiError, failure } from '../../_lib/user-management';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const config = getSupabaseConfig();
  if (!config.configured) {
    return NextResponse.json(unconfiguredPayload(), { status: 501 });
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('Invalid registration.', 400);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const guestId = String(body.guestId || '');
    if (!email || !password) throw failure('Email and password are required.', 400);
    if (password.length < 6) throw failure('Password must be at least 6 characters.', 400);
    const data = profileFields(body.profile || {}, { registration: true });
    if (password.length > 1024 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw failure('Enter a valid email and password.', 400);
    const auth = await supabaseFetch('/auth/v1/signup', {
      method: 'POST',
      body: { email, password, data },
    });

    const authUser = auth.user || auth;
    const user = {
      id: authUser?.id,
      email: authUser?.email || email,
    };

    const session = sessionFromAuth(auth);
    if (!session || !user.id) {
      return NextResponse.json(
        { configured: true, message: 'Check your email to finish registration. If you already have an account, sign in or use your existing confirmation email.' },
        { status: 202 }
      );
    }

    const profile = await migrateGuestUsageToProfile(user, guestId);

    return NextResponse.json({
      configured: true,
      message: 'Free account created with the standard allowance of 5 total exports, including carried-over guest usage.',
      session,
      usage: usageForProfile(profile, user),
    });
  } catch (error) {
    return apiError(error);
  }
}
