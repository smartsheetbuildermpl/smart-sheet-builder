import { NextResponse } from 'next/server';
import {
  ensureProfile,
  getSupabaseConfig,
  getUserFromRequest,
  incrementGuestUsage,
  incrementProfileUsage,
  unconfiguredPayload,
} from '../../_lib/supabase';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const config = getSupabaseConfig();
  if (!config.configured) {
    return NextResponse.json(unconfiguredPayload(), { status: 501 });
  }

  const body = await request.json();
  const guestId = String(body.guestId || '');
  const exportKind = String(body.exportKind || 'download');

  try {
    const user = await getUserFromRequest(request);
    if (user) {
      const profile = await ensureProfile(user);
      const result = await incrementProfileUsage(profile, user, exportKind);
      return NextResponse.json({ configured: true, ...result });
    }
  } catch (error) {
    if (error.code === 'invalid_session') {
      return NextResponse.json({ code: 'invalid_session', message: 'Please sign in again.' }, { status: 401 });
    }
    throw error;
  }

  if (!guestId) {
    return NextResponse.json({ message: 'Guest ID is required.' }, { status: 400 });
  }

  try {
    const result = await incrementGuestUsage(guestId, exportKind);
    return NextResponse.json({ configured: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { message: error.message || 'Export access check failed.' },
      { status: error.status || 500 }
    );
  }
}
