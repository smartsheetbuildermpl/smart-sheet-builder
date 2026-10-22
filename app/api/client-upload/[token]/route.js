import { failure, rpc } from '../../_lib/user-management';
import { defaultDesignSize, validDesignSize } from '../../../lib/client-design-size';
import { MAX_UPLOAD_BYTES, PROXY_UPLOAD_BYTES, uploadProblem } from '../../../lib/client-portal-limits';
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
  signedUpload,
  uuid,
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
async function bytes(request, limit = PROXY_UPLOAD_BYTES) {
  const reader = request.body?.getReader();
  if (!reader) throw failure('Choose a PNG.', 400);
  let count = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > limit)
        throw failure('Upload exceeds the allowed transfer size. Retry using the current upload page.', 413);
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
    return reply({ shopName: portal.settings.shopName, profileName: portal.name, machine: portal.settings.machine });
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
        if (e.status === 400) e.message = uploadProblem(name, data.length, e.message);
        throw e;
      }
    }
    const body = await request.json();
    if (action === 'upload-start') {
      if (job.confirmed_at) throw failure('This submission is locked.', 409);
      const id = uuid(body.id), name = text(body.name), size = body.bytes;
      if (!Number.isInteger(size) || size < 33 || size > MAX_UPLOAD_BYTES || !/\.png$/i.test(name))
        throw failure(uploadProblem(name, Number(size) || 0, 'Choose a valid static PNG within the upload limit.'), 400);
      const path = `${job.id}/${id}.png`;
      const reserved = await rpc('ssb_client_upload_reserve', { ...args, p_data: { id, path, name, bytes: size, ready: false, qty: 1, directUpload: true,
        uploadCleanupAfter: new Date(new Date(job.expires_at).getTime() + 2 * 3600000).toISOString() } });
      if (reserved.assets.find(a => a.id === id)?.ready) return reply({ job: publicJob(reserved) });
      return reply({ id, url: await signedUpload(path) });
    }
    if (action === 'upload-finish') {
      if (job.confirmed_at) throw failure('This submission is locked.', 409);
      const asset = job.assets.find(a => a.id === uuid(body.id) && a.directUpload && !a.deleted);
      if (!asset) throw failure('Upload reservation is unavailable. Re-add this file.', 400);
      if (asset.ready) return reply({ job: publicJob(job) });
      const data = await bytes(await storage('GET', asset.path), MAX_UPLOAD_BYTES);
      try {
        if (data.length !== asset.bytes) throw failure('The stored file size does not match the selected original. Retry the upload.', 400);
        const decoded = decodePng(data);
        const updated = await jobs('ready', { ...args, p_data: { id: asset.id, ...decoded } });
        return reply({ job: publicJob(updated) });
      } catch (e) {
        if (e.status === 400) e.message = uploadProblem(asset.name, data.length, e.message);
        throw e;
      }
    }
    if (action === 'remove')
      return reply({
        job: publicJob(
          await jobs('remove', { ...args, p_data: { id: body.id } })
        )
      });
    if (action === 'preview') {
      const reference = text(body.reference || '');
      if (!reference || /[\u0000-\u001f\u007f]/.test(reference)) throw failure('Enter a Project / Client Name before generating the preview.',400);
      if (
        !Array.isArray(body.quantities) ||
        body.quantities.length !== job.assets.filter((a) => a.ready).length ||
        new Set(body.quantities.map(q => q?.id)).size !== body.quantities.length ||
        body.quantities.some(q => !job.assets.some(a => a.ready && a.id === q?.id))
      )
        throw failure('Upload files, then set each quantity.', 400);
      const assets = job.assets.map((a) => {
          if (!a.ready) return a;
          const requested = body.quantities.find(q => q.id === a.id);
          const size = requested.widthIn === undefined && requested.heightIn === undefined
            ? defaultDesignSize(a) : { widthIn: requested.widthIn, heightIn: requested.heightIn };
          if (!validDesignSize(size)) throw failure('Enter a positive width and height up to 120 inches for each design.', 400);
          return { ...a, qty: requested.qty, ...size };
        }),
        manifest = layout(
          assets.filter((a) => a.ready),
          portal.settings
        );
      manifest.profile = { id:portal.id, name:portal.name, machine:portal.settings.machine, reference };
      const updated = await jobs('preview', {
        ...args,
        p_data: {
          revision: job.revision,
          profileVersion: portal.updated_at,
          assets,
          manifest,
          reference,
          quantity: manifest.totalPieces,
          meters: manifest.meters
        }
      });
      return reply({ job: publicJob(updated) });
    }
    if (action === 'confirm') {
      if (!job.confirmed_at && !job.reference?.trim()) throw failure('Enter a Project / Client Name and generate the preview before confirming.',400);
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
            email: job.manifest?.config?.email || portal.settings.email,
            shopName: job.manifest?.config?.shopName || portal.settings.shopName,
            reference: job.reference,
            profileName: job.profile_name || portal.name,
            machine: job.machine || job.manifest?.config?.machine,
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
          'Your gang sheet was submitted to the shop. Email notification is queued for delivery.'
      });
    }
    throw failure('Invalid submission action.', 400);
  } catch (e) {
    return errorReply(e);
  }
}
