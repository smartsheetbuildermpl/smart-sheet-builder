import { NextResponse } from 'next/server';
import { getLibraryActor, supabaseFetch } from '../../_lib/supabase';
import { cleanName, libraryErrorResponse, libraryUnavailable, libraryUnavailableResponse } from '../_lib';

export const dynamic = 'force-dynamic';

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export async function POST(request) {
  if (libraryUnavailable()) return libraryUnavailableResponse(NextResponse);
  try {
    await getLibraryActor(request, { manage: true });
    const body = await request.json();
    const name = cleanName(body.name, 'Category name');
    const slug = slugify(name);
    if (!slug) return NextResponse.json({ message: 'Category name needs letters or numbers.' }, { status: 400 });
    const rows = await supabaseFetch('/rest/v1/design_library_categories', {
      method: 'POST', service: true, headers: { Prefer: 'return=representation' },
      body: [{ name, slug, sort_order: Number.isInteger(body.sortOrder) ? body.sortOrder : 0 }],
    });
    return NextResponse.json({ category: rows?.[0] }, { status: 201 });
  } catch (error) {
    return libraryErrorResponse(NextResponse, error);
  }
}
