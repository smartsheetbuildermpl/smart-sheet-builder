import { NextResponse } from 'next/server';
import { accountActor, apiError, profileFields } from '../../_lib/user-management';
import { supabaseFetch } from '../../_lib/supabase';
export const dynamic = 'force-dynamic';
function ownFields(profile) {
  return Object.fromEntries(['full_name', 'business_name', 'mobile', 'city', 'country', 'machine_type', 'monthly_usage'].map(key => [key, profile[key] || '']));
}
export async function GET(request) {
  try { const { profile } = await accountActor(request); return NextResponse.json({ profile: ownFields(profile) }, { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return apiError(error); }
}
export async function PATCH(request) {
  try {
    const { user } = await accountActor(request);
    const fields = profileFields(await request.json());
    if (Object.keys(fields).length) await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}`, { method: 'PATCH', service: true, body: fields });
    return NextResponse.json({ message: 'Profile saved.' });
  } catch (error) { return apiError(error); }
}
