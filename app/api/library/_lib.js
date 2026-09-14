import { getSupabaseConfig, librarySignedUrl, supabaseFetch, unconfiguredPayload } from '../_lib/supabase';

export function libraryUnavailable() {
  return !getSupabaseConfig().configured;
}

export function libraryUnavailableResponse(NextResponse) {
  return NextResponse.json(unconfiguredPayload(), { status: 501 });
}

export function libraryErrorResponse(NextResponse, error) {
  return NextResponse.json(
    { code: error.code || 'library_error', message: error.message || 'The Design Library request failed.' },
    { status: error.status || 500 }
  );
}

export function cleanName(value, label = 'Name') {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > 120) {
    const error = new Error(`${label} must be between 1 and 120 characters.`);
    error.status = 400;
    throw error;
  }
  return clean;
}

export function cleanTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(source.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 20).map((tag) => tag.slice(0, 40));
}

export async function toDesign(row) {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id || '',
    category: row.design_library_categories?.name || 'Uncategorized',
    tags: row.tags || [],
    widthPx: row.width_px || null,
    heightPx: row.height_px || null,
    visible: Boolean(row.visible),
    imageUrl: await librarySignedUrl(row.storage_path),
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

export async function getDesignById(id) {
  const rows = await supabaseFetch(
    `/rest/v1/design_library_designs?id=eq.${encodeURIComponent(id)}&select=*,design_library_categories(name)`,
    { service: true }
  );
  return rows?.[0] || null;
}
