import { NextResponse } from 'next/server';
import { accountActor, apiError, rpc, offset } from '../../_lib/user-management';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  try {
    const { user } = await accountActor(request, true);
    const q = new URL(request.url).searchParams;
    const result = await rpc('ssb_admin_users', { p_actor: user.id, p_search: (q.get('search') || '').slice(0, 200), p_status: q.get('status') || '', p_access: q.get('access') || '', p_offset: offset(q.get('offset')) });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
