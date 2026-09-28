import { accountActor, failure } from '../../../../_lib/user-management';
import { jobs, uuid, storage, errorReply } from '../../../../_lib/client-jobs';
export const dynamic = 'force-dynamic';
export async function GET(request, { params }) {
  try {
    const { user } = await accountActor(request),
      job = await jobs('get', { p_owner: user.id, p_job: uuid(params.id) });
    if (!job.confirmed_at) throw failure('This job is not confirmed.', 409);
    const asset = job.assets.find((a) => a.id === uuid(params.file) && a.ready);
    if (!asset) throw failure('File unavailable.', 404);
    const source = await storage('GET', asset.path);
    // Recheck after storage fetch; never issue signed URLs or cacheable file responses.
    await jobs('get', { p_owner: user.id, p_job: job.id });
    return new Response(source.body, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      }
    });
  } catch (e) {
    return errorReply(e);
  }
}
