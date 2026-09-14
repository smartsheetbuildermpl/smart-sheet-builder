import { NextResponse } from 'next/server';
import { deleteLibraryObject, getLibraryActor, supabaseFetch } from '../../../_lib/supabase';
import { cleanName, cleanTags, getDesignById, libraryErrorResponse, libraryUnavailable, libraryUnavailableResponse, toDesign } from '../../_lib';

export const dynamic = 'force-dynamic';

export async function PATCH(request, { params }) {
  if (libraryUnavailable()) return libraryUnavailableResponse(NextResponse);
  try {
    await getLibraryActor(request, { manage: true });
    const body = await request.json();
    const patch = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) patch.name = cleanName(body.name, 'Design name');
    if (body.categoryId !== undefined) patch.category_id = String(body.categoryId || '') || null;
    if (body.tags !== undefined) patch.tags = cleanTags(body.tags);
    if (body.visible !== undefined) patch.visible = Boolean(body.visible);
    const rows = await supabaseFetch(`/rest/v1/design_library_designs?id=eq.${encodeURIComponent(params.id)}`, {
      method: 'PATCH', service: true, headers: { Prefer: 'return=representation' }, body: patch,
    });
    const design = rows?.[0];
    return NextResponse.json({ design: design ? await toDesign(design) : null });
  } catch (error) {
    return libraryErrorResponse(NextResponse, error);
  }
}

export async function DELETE(request, { params }) {
  if (libraryUnavailable()) return libraryUnavailableResponse(NextResponse);
  try {
    await getLibraryActor(request, { manage: true });
    const design = await getDesignById(params.id);
    if (!design) return NextResponse.json({ message: 'Design not found.' }, { status: 404 });
    // Delete the catalog record first. If Storage cleanup has a temporary failure, the asset stays orphaned but never visible.
    await supabaseFetch(`/rest/v1/design_library_designs?id=eq.${encodeURIComponent(params.id)}`, { method: 'DELETE', service: true });
    await deleteLibraryObject(design.storage_path);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return libraryErrorResponse(NextResponse, error);
  }
}
