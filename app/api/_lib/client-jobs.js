import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';
import packing from '../../../public/sheet-packing';
import { NextResponse } from 'next/server';
import { getSupabaseConfig } from './supabase';
import { rpc, failure } from './user-management';
import { seal, unseal } from './export-security';
import { publicAppOrigin } from './public-app-url';

export const BUCKET = 'client-job-sources';
export const defaults = {
  shopName: '',
  email: '',
  machine: 'dtf',
  widthIn: 23,
  lengthIn: 39,
  dpi: 300,
  gapIn: 0,
  edgeIn: 0.3,
  rotate: true,
  autoExtend: true
};
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function jobs(action, args = {}) {
  if (!getSupabaseConfig().configured) {
    console.error('[client-portal-config]', 'Missing Supabase URL, anon key or service-role key.');
    const e = failure('Client portal server configuration is incomplete.', 503);
    e.code = 'portal_configuration_error';
    throw e;
  }
  return rpc('ssb_client_jobs', { p_action: action, ...args });
}
export const reply = (data, status = 200) =>
  NextResponse.json(data, {
    status,
    headers: {
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer'
    }
  });
export function errorReply(e) {
  const portalErrors = {
    P0404: [404, 'portal_not_found', 'This upload link is invalid or has been replaced. Ask the shop for the current link.'],
    P0403: [403, 'portal_disabled', 'This upload portal is currently disabled.'],
    P0423: [403, 'portal_paused', 'This shop is not currently accepting uploads.'],
    P0410: [410, 'submission_expired', 'This submission session has expired. Start a new submission.']
  };
  const mapped = portalErrors[e.data?.code];
  if (mapped) return reply({ code: mapped[1], message: mapped[2] }, mapped[0]);
  const legacyLookup = e.data?.code === 'P0002' && e.message === 'Upload link unavailable. Ask the shop for a new link.';
  if (legacyLookup || (e.data?.code === '42501' && /^permission denied/i.test(e.message)) || ['PGRST202', 'PGRST205', '42P01', '42883', '42703'].includes(e.data?.code)) {
    console.error('[client-portal-schema]', e.data?.code, 'Apply/re-run supabase-client-jobs-v1.sql in the same project as NEXT_PUBLIC_SUPABASE_URL; reload PostgREST schema.');
    return reply({ code: 'portal_setup_required', message: 'The upload portal needs a server database update. Please contact the shop; replacing the link will not fix this.' }, 503);
  }
  const code = e.data?.code,
    status =
      code === '42501'
        ? 403
        : code === 'P0002'
          ? 404
          : code === '40001'
            ? 409
            : code === '22023'
              ? 400
              : e.data
                ? 503
                : e.status || 503;
  if (status >= 500) console.error('[client-portal-service]', e.data?.code || e.code || 'configuration_or_transport', 'Check Supabase environment, Client Jobs migration, public URL and notification/maintenance setup.');
  return reply(
    {
      code: status >= 500 ? 'portal_configuration_error' : e.code || 'portal_request_failed',
      message:
        status >= 500
          ? 'The upload portal could not connect to its configured services. Please retry later or contact the shop. This is not an expired link.'
          : e.message
    },
    status
  );
}
export function uuid(value) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      value || ''
    )
  )
    throw failure('Invalid job or file.', 400);
  return value;
}
export function text(value, max = 120) {
  if (typeof value !== 'string' || value.length > max)
    throw failure(`Text must be at most ${max} characters.`, 400);
  return value.trim();
}
export function settings(value) {
  const s = { ...defaults, ...value };
  s.shopName = text(s.shopName);
  s.email = text(s.email, 254);
  if (!s.shopName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email))
    throw failure('Enter a shop name and notification email.', 400);
  if (!['dtf', 'uvdtf24', 'uvdtf12', 'tarpaulin'].includes(s.machine))
    throw failure('Choose a printing machine.', 400);
  for (const [key, min, max] of [
    ['widthIn', 1, 63],
    ['lengthIn', 1, 120],
    ['dpi', 72, 600],
    ['gapIn', 0, 2],
    ['edgeIn', 0, 3]
  ])
    if (
      typeof s[key] !== 'number' ||
      !Number.isFinite(s[key]) ||
      s[key] < min ||
      s[key] > max
    )
      throw failure(`Invalid ${key}. Allowed range: ${min}–${max}.`, 400);
  if (s.machine !== 'dtf' && s.lengthIn > 39)
    throw failure('This machine uses sheets up to 39 inches long.', 400);
  s.rotate = s.rotate === true;
  s.autoExtend = s.autoExtend !== false;
  if (
    s.widthIn <= 2 * s.edgeIn ||
    s.lengthIn <= Math.max(0.36, s.edgeIn) + s.edgeIn
  )
    throw failure('The edge allowance leaves no usable sheet area.', 400);
  return Object.fromEntries(Object.keys(defaults).map((k) => [k, s[k]]));
}
export function newLink() {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hash(token),
    secret: seal({ type: 'client-link', token })
  };
}
export function linkToken(portal) {
  const value = unseal(portal?.link_secret);
  return value?.type === 'client-link' && typeof value.token === 'string' && hash(value.token) === portal.link_hash ? value.token : '';
}
export function publicOrigin(request) {
  return publicAppOrigin(request, { localPortal: true });
}
export function emailReady() {
  return Boolean(
    process.env.RESEND_API_KEY &&
      process.env.CLIENT_JOBS_EMAIL_FROM
  );
}
export function portalSetup(request) {
  const issues = [];
  try { publicOrigin(request); } catch { issues.push('Set SMART_SHEET_SITE_URL to the public app origin.'); }
  if (!process.env.RESEND_API_KEY) issues.push('Set RESEND_API_KEY for job notifications.');
  if (!process.env.CLIENT_JOBS_EMAIL_FROM) issues.push('Set CLIENT_JOBS_EMAIL_FROM to a verified sender.');
  if (!process.env.CRON_SECRET) issues.push('Set Vercel CRON_SECRET for the daily cleanup job.');
  return issues;
}
export async function rate(request, scope, limit) {
  const name = process.env.VERCEL
    ? 'x-vercel-forwarded-for'
    : process.env.SMART_SHEET_TRUSTED_IP_HEADER;
  const ip = name
    ? String(request.headers.get(name) || '')
        .split(',')[0]
        .trim()
    : '';
  const key = createHmac(
    'sha256',
    process.env.SMART_SHEET_EXPORT_SECRET || getSupabaseConfig().serviceRoleKey
  )
    .update(`client:${scope}:${isIP(ip) ? ip : 'shared-untrusted-network'}`)
    .digest('hex');
  if (!(await jobs('rate', { p_data: { key, limit } })).allowed)
    throw failure('Too many requests. Please try again in an hour.', 429);
}
export async function publicActor(request, token, needsDraft = true) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw Object.assign(failure('This upload link is invalid. Ask the shop for the current link.', 404), { code: 'portal_not_found' });
  const link = hash(token),
    portal = await jobs('info', { p_link: link });
  if (!needsDraft) return { link, portal };
  const session = unseal(request.headers.get('x-client-submission'));
  if (
    session?.type !== 'client-draft' ||
    session.link !== link
  )
    throw Object.assign(failure('This submission session is invalid. Start a new submission.', 401), { code: 'submission_invalid' });
  if (session.exp <= Date.now())
    throw Object.assign(failure('This submission session has expired. Start a new submission.', 410), { code: 'submission_expired' });
  const args = { p_link: link, p_job: uuid(session.id) },
    job = await jobs('get', args);
  return { link, portal, job, args };
}
export function publicJob(job) {
  return {
    id: job.id,
    reference: job.reference,
    revision: job.revision,
    confirmed_at: job.confirmed_at,
    expires_at: job.expires_at,
    quantity: job.quantity,
    meters: job.meters,
    assets: job.assets
      .filter((a) => a.ready)
      .map(({ id, name, width, height, crop, qty }) => ({
        id,
        name,
        width,
        height,
        crop,
        qty
      })),
    manifest: job.manifest ? { ...job.manifest, config: undefined } : null
  };
}
export function decodePng(bytes) {
  if (
    bytes.length > 4194304 ||
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString('ascii', 12, 16) !== 'IHDR'
  )
    throw failure('Upload a valid PNG up to 4 MiB.', 400);
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16777216
  )
    throw failure(
      `PNG ${width} × ${height} exceeds the portal limit: 16 megapixels, 8192 pixels per side. The source is never downscaled.`,
      400
    );
  if (bytes[24] !== 8)
    throw failure('Use an 8-bit PNG for this upload portal.', 400);
  // Enforce chunk framing and reject animation before decompression. pngjs verifies CRCs.
  let pos = 8,
    ended = false;
  const compressed = [];
  while (pos + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(pos),
      type = bytes.toString('ascii', pos + 4, pos + 8);
    if (size > bytes.length - pos - 12 || type === 'acTL')
      throw failure('Invalid or animated PNG. Use a static PNG.', 400);
    if (type === 'IDAT' && bytes[28] === 1)
      compressed.push(bytes.subarray(pos + 8, pos + 8 + size));
    pos += size + 12;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended || pos !== bytes.length)
    throw failure('Invalid PNG contents.', 400);
  // pngjs bounds ordinary PNG inflation internally, but its Adam7 path uses
  // unbounded zlib. Preflight that path with a strict native-pixel bound.
  if (bytes[28] === 1) {
    try {
      inflateSync(Buffer.concat(compressed), {
        maxOutputLength: width * height * 4 + height * 7 + 64
      });
    } catch {
      throw failure('Invalid or oversized interlaced PNG data.', 400);
    }
  }
  let png;
  try {
    png = PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw failure(
      'The PNG could not be decoded. Re-save it as a PNG and retry.',
      400
    );
  }
  let l = width,
    t = height,
    r = -1,
    b = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (png.data[(y * width + x) * 4 + 3]) {
        l = Math.min(l, x);
        t = Math.min(t, y);
        r = Math.max(r, x);
        b = Math.max(b, y);
      }
  if (r < 0) throw failure('This PNG is entirely transparent.', 400);
  // Exactly the builder trim: alpha > 0, one native pixel padding, no resampling.
  l = Math.max(0, l - 1);
  t = Math.max(0, t - 1);
  r = Math.min(width - 1, r + 1);
  b = Math.min(height - 1, b + 1);
  return {
    width,
    height,
    crop: { x: l, y: t, w: r - l + 1, h: b - t + 1 },
    sha256: hash(bytes)
  };
}
export function layout(assets, config) {
  const s = settings(config),
    dpi = s.dpi,
    width = Math.round(s.widthIn * dpi),
    length = Math.round(s.lengthIn * dpi),
    gap = Math.ceil(s.gapIn * dpi),
    edge = Math.ceil(s.edgeIn * dpi),
    top = Math.max(Math.round(0.36 * dpi), edge);
  const items = [];
  for (const a of assets) {
    if (!a.ready || !Number.isInteger(a.qty) || a.qty < 1 || a.qty > 500)
      throw failure('Use 1–500 copies per design.', 400);
    for (let i = 0; i < a.qty; i++)
      items.push({
        id: `${a.id}:${i}`,
        assetId: a.id,
        baseW: Math.max(1, Math.round((a.crop.w / 300) * dpi)),
        baseH: Math.max(1, Math.round((a.crop.h / 300) * dpi))
      });
  }
  if (!items.length || items.length > 500)
    throw failure('A submission must contain 1–500 pieces.', 400);
  if (assets.reduce((sum, a) => sum + a.width * a.height, 0) > 33554432)
    throw failure(
      'The submission exceeds 32 megapixels of source artwork. Split it into smaller submissions; resolution will not be reduced.',
      400
    );
  const continuous = s.machine === 'dtf' && !s.autoExtend,
    sheets = [];
  let remaining = items;
  while (remaining.length) {
    const packed = packing.packSheet(
      remaining,
      width - edge * 2,
      (continuous ? 3000000 : length) - top - edge,
      gap,
      s.rotate
    );
    if (!packed.placements.length)
      throw failure(
        'A design cannot fit the shop’s sheet preset at 300 PPI. Ask the shop to adjust its preset.',
        400
      );
    const placements = packed.placements.map((p) => ({
      assetId: p.inst.assetId,
      x: p.x + edge,
      y: p.y + top,
      w: p.w,
      h: p.h,
      baseW: p.inst.baseW,
      baseH: p.inst.baseH,
      rotation: p.inst.rotation
    }));
    const used = Math.max(...placements.map((p) => p.y + p.h)) + gap + edge,
      height = continuous ? Math.max(length, used) : length;
    if (
      width * height > 128000000 ||
      width > 32767 ||
      height > 32767 ||
      sheets.length >= 10
    )
      throw failure(
        'This layout exceeds the portal’s full-resolution output budget (128 megapixels per sheet, 10 sheets). Ask the shop for a smaller sheet preset or submit fewer pieces.',
        400
      );
    sheets.push({
      widthPx: width,
      heightPx: height,
      widthIn: width / dpi,
      heightIn: height / dpi,
      headerHeightPx: Math.round(0.36 * dpi),
      gapPx: gap,
      autoEdgeAllowancePx: edge,
      placements
    });
    remaining = packed.unplaced;
    if (remaining.length && !s.autoExtend && !continuous)
      throw failure(
        'The requested quantity needs more sheets. Ask the shop to enable additional sheets.',
        400
      );
  }
  return {
    version: 1,
    config: s,
    dpi,
    sheets,
    totalPieces: items.length,
    meters: sheets.reduce((n, p) => n + p.heightIn * 0.0254, 0)
  };
}
export async function storage(method, path, bytes) {
  const c = getSupabaseConfig(),
    response = await fetch(
      `${c.url}/storage/v1/object/${BUCKET}${path ? '/' + path : ''}`,
      {
        method,
        headers: {
          apikey: c.serviceRoleKey,
          Authorization: `Bearer ${c.serviceRoleKey}`,
          'Content-Type':
            method === 'DELETE' ? 'application/json' : 'image/png',
          'Cache-Control': 'no-store'
        },
        ...(bytes ? { body: bytes } : {}),
        cache: 'no-store',
        signal: AbortSignal.timeout(10000)
      }
    );
  if (!response.ok)
    throw failure('Private upload storage is unavailable. Please retry.', 503);
  return response;
}
export async function removePaths(paths) {
  if (paths.length)
    await storage('DELETE', '', JSON.stringify({ prefixes: paths }));
}
export async function cleanup() {
  const expired = await jobs('cleanup-list');
  let removed = 0;
  for (const job of expired) {
    await removePaths(job.assets.map((a) => a.path));
    await jobs('purged', { p_job: job.id });
    removed++;
  }
  return removed;
}
export async function notifications() {
  if (!emailReady())
    throw failure('Shop email notifications are not configured.', 503);
  const pending = await jobs('notifications');
  let sent = 0;
  for (const job of pending) {
    const n = job.notification;
    // Stable bytes across retries are required by the provider's idempotency key.
    // Email clients cannot reliably execute a live countdown; the job page can.
    const expires = new Date(n.expiresAt).toISOString(),
      summary = `${n.designCount} designs · ${n.quantity} pieces · ${Number(n.meters).toFixed(3)} m`;
    const escape = (v) =>
      String(v).replace(
        /[&<>"']/g,
        (c) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
          })[c]
      );
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `client-job-${job.id}`
      },
      body: JSON.stringify({
        from: process.env.CLIENT_JOBS_EMAIL_FROM,
        to: [n.email],
        subject: `New client job — ${n.shopName}`,
        text: `${n.shopName}\n${n.reference || 'Client submission'}\n${summary}\nExpires exactly ${expires} (UTC), 24 hours after confirmation.\nOpen Client Job (sign in required): ${n.url}\nThe job page shows the live countdown. Files are temporary and access ends at expiry.`,
        html: `<h1>${escape(n.shopName)}</h1><p>${escape(n.reference || 'Client submission')}</p><p>${escape(summary)}</p><p>Expires exactly ${escape(expires)} (UTC), 24 hours after confirmation.</p><p><a style="display:inline-block;background:#164753;color:white;padding:12px 20px;border-radius:8px" href="${escape(n.url)}">Open Client Job</a></p><p>Sign in to see the live countdown. Files are temporary and access ends at expiry.</p>`
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok)
      throw failure(
        'Client notification delivery failed. The notification remains queued for retry.',
        503
      );
    await jobs('notified', { p_job: job.id });
    sent++;
  }
  return sent;
}
export function submission(id, link) {
  return seal({
    type: 'client-draft',
    id,
    link,
    exp: Date.now() + 2 * 3600000
  });
}
export function sourceId() {
  return randomUUID();
}
