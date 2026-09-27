import { NextResponse } from 'next/server';
import { accountActor, apiError, rpc, offset } from '../../_lib/user-management';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  try {
    const { user } = await accountActor(request);
    return NextResponse.json(await rpc('ssb_credit_history', { p_actor: user.id, p_target: user.id, p_offset: offset(new URL(request.url).searchParams.get('offset')) }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
