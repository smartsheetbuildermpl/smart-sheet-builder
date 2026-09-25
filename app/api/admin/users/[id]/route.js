import { NextResponse } from 'next/server';
import { accountActor, apiError, failure, rpc, userId, offset } from '../../../_lib/user-management';
export const dynamic = 'force-dynamic';
export async function GET(request, { params }) {
  try {
    const { user } = await accountActor(request, true);
    return NextResponse.json(await rpc('ssb_admin_user', { p_actor: user.id, p_target: userId(params.id), p_offset: offset(new URL(request.url).searchParams.get('offset')) }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request, { params }) {
  try {
    const { user } = await accountActor(request, true);
    const body = await request.json();
    if (!body || Object.keys(body).some(k => !['field', 'value', 'expectedUpdatedAt'].includes(k)) ||
      !(body.field === 'status' ? ['active', 'blocked'] : body.field === 'export_access' ? ['standard', 'unlimited'] : []).includes(body.value) ||
      typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) throw failure('Review a valid access or status change.', 400);
    await rpc('ssb_admin_change', { p_actor: user.id, p_target: userId(params.id), p_field: body.field, p_value: body.value, p_expected: body.expectedUpdatedAt });
    return NextResponse.json({ message: 'Account updated. Change recorded in history.' });
  } catch (error) { return apiError(error); }
}
