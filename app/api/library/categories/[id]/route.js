import { NextResponse } from 'next/server';
import { getLibraryActor, supabaseFetch } from '../../../_lib/supabase';
import { cleanName, libraryErrorResponse, libraryUnavailable, libraryUnavailableResponse } from '../../_lib';

export const dynamic = 'force-dynamic';

export async function PATCH(request, { params }) {
  if (libraryUnavailable()) return libraryUnavailableResponse(NextResponse);
  try {
    await getLibraryActor(request, { admin: true });
    const body = await request.json();
    const patch = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) patch.name = cleanName(body.name, 'Category name');
    if (body.sortOrder !== undefined) patch.sort_order = Number(body.sortOrder) || 0;
    const rows = await supabaseFetch(`/rest/v1/design_library_categories?id=eq.${encodeURIComponent(params.id)}`, {
      method: 'PATCH', service: true, headers: { Prefer: 'return=representation' }, body: patch,
    });
    return NextResponse.json({ category: rows?.[0] || null });
  } catch (error) {
    return libraryErrorResponse(NextResponse, error);
  }
}

export async function DELETE(request, { params }) {
  if (libraryUnavailable()) return libraryUnavailableResponse(NextResponse);
  try {
    await getLibraryActor(request, { admin: true });
    await supabaseFetch(`/rest/v1/design_library_categories?id=eq.${encodeURIComponent(params.id)}`, { method: 'DELETE', service: true });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return libraryErrorResponse(NextResponse, error);
  }
}
