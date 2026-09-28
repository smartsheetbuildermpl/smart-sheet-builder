import { failure } from '../../_lib/user-management';
import {
  jobs,
  reply,
  errorReply,
  publicActor,
  publicJob,
  rate,
  sourceId,
  submission,
  decodePng,
  storage,
  removePaths,
  layout,
  text,
  emailReady,
  publicOrigin,
  portalSetup,
  notifications
} from '../../_lib/client-jobs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
async function bytes(request) {
  const reader = request.body?.getReader();
  if (!reader) throw failure('Choose a PNG.', 400);
  let count = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > 4194304)
        throw failure('Each PNG must be at most 4 MiB.', 413);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export async function GET(request, { params }) {
  try {
    await rate(request, 'public-view', 240);
    const { portal } = await publicActor(request, params.token, false);
    if (portalSetup(request).length) throw failure('Portal service configuration is incomplete.', 503);
    return reply({ shopName: portal.settings.shopName });
  } catch (e) {
    return errorReply(e);
  }
}
export async function POST(request, { params }) {
  try {
    const action = new URL(request.url).searchParams.get('action');
    await rate(request, 'public-mutation', 120);
    if (action === 'create') {
      const { link } = await publicActor(request, params.token, false);
      if (portalSetup(request).length) throw failure('Portal service configuration is incomplete.', 503);
      if (!emailReady())
        throw failure(
          'This shop’s upload portal is not ready. Please contact the shop.',
          503
        );
      await rate(request, 'new-submission', 10);
      publicOrigin(request);
      const id = sourceId();
      const job = await jobs('create', { p_link: link, p_job: id });
      return reply({ job: publicJob(job), submission: submission(id, link) });
    }
    const { args, job, portal } = await publicActor(request, params.token);
    if (action === 'upload') {
      if (job.confirmed_at) throw failure('This submission is locked.', 409);
      if (request.headers.get('content-type') !== 'image/png')
        throw failure('Only PNG uploads are accepted.', 400);
      const data = await bytes(request),
        id = sourceId(),
        path = `${job.id}/${id}.png`,
        name = text(
          decodeURIComponent(request.headers.get('x-file-name') || 'design.png')
        );
      await jobs('reserve', {
        ...args,
        p_data: { id, path, name, bytes: data.length, ready: false, qty: 1 }
      });
      try {
        const decoded = decodePng(data);
        await storage('POST', path, data);
        const updated = await jobs('ready', {
          ...args,
          p_data: { id, ...decoded }
        });
        return reply({ job: publicJob(updated) });
      } catch (e) {
        await removePaths([path]).catch(() => {});
        await jobs('remove', { ...args, p_data: { id } }).catch(() => {});
        throw e;
      }
    }
    const body = await request.json();
    if (action === 'remove')
      return reply({
        job: publicJob(
          await jobs('remove', { ...args, p_data: { id: body.id } })
        )
      });
    if (action === 'preview') {
      if (
        !Array.isArray(body.quantities) ||
        body.quantities.length !== job.assets.filter((a) => a.ready).length
      )
        throw failure('Upload files, then set each quantity.', 400);
      const assets = job.assets.map((a) =>
          a.ready
            ? { ...a, qty: body.quantities.find((q) => q.id === a.id)?.qty }
            : a
        ),
        manifest = layout(
          assets.filter((a) => a.ready),
          portal.settings
        );
      const updated = await jobs('preview', {
        ...args,
        p_data: {
          revision: job.revision,
          assets,
          manifest,
          reference: text(body.reference || ''),
          quantity: manifest.totalPieces,
          meters: manifest.meters
        }
      });
      return reply({ job: publicJob(updated) });
    }
    if (action === 'confirm') {
      if (!emailReady())
        throw failure(
          'Shop email notifications are not configured. Contact the shop.',
          503
        );
      const updated = await jobs('confirm', {
        ...args,
        p_data: {
          revision: body.revision,
          notification: {
            email: portal.settings.email,
            shopName: portal.settings.shopName,
            reference: job.reference,
            designCount: job.design_count,
            quantity: job.quantity,
            meters: job.meters,
            url: `${publicOrigin(request)}/?clientJob=${job.id}`
          }
        }
      });
      await notifications().catch(() => {}); // Durable outbox retries through the maintenance endpoint.
      return reply({
        job: publicJob(updated),
        message:
          'Confirmed and sent to the shop’s Client Jobs. Email notification is queued for delivery.'
      });
    }
    throw failure('Invalid submission action.', 400);
  } catch (e) {
    return errorReply(e);
  }
}
