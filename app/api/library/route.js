import { NextResponse } from 'next/server';
import { getLibraryActor, supabaseFetch } from '../_lib/supabase';
import { libraryErrorResponse, libraryUnavailable, libraryUnavailableResponse, toDesign } from './_lib';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  if (libraryUnavailable()) return libraryUnavailableResponse(NextResponse);
  try {
    const actor = await getLibraryActor(request);
    const url = new URL(request.url);
    const categoryId = String(url.searchParams.get('category') || '').trim();
    const visibility = actor.isAdmin && url.searchParams.get('includeHidden') === 'true' ? '' : '&visible=eq.true';
    const categoryFilter = categoryId ? `&category_id=eq.${encodeURIComponent(categoryId)}` : '';
    const rows = await supabaseFetch(
      `/rest/v1/design_library_designs?select=*,design_library_categories(name)&order=created_at.desc${visibility}${categoryFilter}`,
      { service: true }
    );
    const categories = await supabaseFetch('/rest/v1/design_library_categories?select=*&order=sort_order.asc,name.asc', { service: true });
    return NextResponse.json({
      configured: true,
      isAdmin: actor.isAdmin,
      categories: categories || [],
      designs: await Promise.all((rows || []).map(toDesign)),
    });
  } catch (error) {
    return libraryErrorResponse(NextResponse, error);
  }
}
