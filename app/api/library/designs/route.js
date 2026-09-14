import { NextResponse } from 'next/server';
import { getLibraryActor, supabaseFetch, uploadLibraryPng } from '../../_lib/supabase';
import { cleanName, cleanTags, libraryErrorResponse, libraryUnavailable, libraryUnavailableResponse, toDesign } from '../_lib';

export const dynamic = 'force-dynamic';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_PNG_BYTES = 16 * 1024 * 1024;

function isPng(bytes) {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export async function POST(request) {
  if (libraryUnavailable()) return libraryUnavailableResponse(NextResponse);
  try {
    await getLibraryActor(request, { manage: true });
    const form = await request.formData();
    const file = form.get('file');
    const name = cleanName(form.get('name') || file?.name?.replace(/\.png$/i, ''), 'Design name');
    if (!file || typeof file.arrayBuffer !== 'function' || file.type !== 'image/png' || file.size > MAX_PNG_BYTES) {
      return NextResponse.json({ message: 'Upload one transparent PNG up to 16 MB.' }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPng(bytes)) return NextResponse.json({ message: 'The uploaded file is not a valid PNG.' }, { status: 400 });
    const extension = 'png';
    const storagePath = `designs/${crypto.randomUUID()}.${extension}`;
    await uploadLibraryPng(storagePath, bytes);
    try {
      const rows = await supabaseFetch('/rest/v1/design_library_designs', {
        method: 'POST', service: true, headers: { Prefer: 'return=representation' },
        body: [{
          name,
          category_id: String(form.get('categoryId') || '') || null,
          tags: cleanTags(form.get('tags')),
          storage_path: storagePath,
          width_px: Number(form.get('widthPx')) || null,
          height_px: Number(form.get('heightPx')) || null,
          visible: String(form.get('visible')) !== 'false',
        }],
      });
      const design = rows?.[0];
      return NextResponse.json({ design: await toDesign(design) }, { status: 201 });
    } catch (error) {
      // The object remains unlisted if its metadata insert fails; keep the original error clear for the admin.
      throw error;
    }
  } catch (error) {
    return libraryErrorResponse(NextResponse, error);
  }
}
