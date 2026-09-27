import { accountActor, failure } from '../_lib/user-management';
import {
  jobs,
  reply,
  errorReply,
  defaults,
  settings,
  newLink,
  linkToken,
  emailReady,
  portalSetup,
  publicOrigin,
  uuid,
  rate
} from '../_lib/client-jobs';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  try {
    const { user, profile } = await accountActor(request),
      id = new URL(request.url).searchParams.get('id');
    if (id) {
      const job = await jobs('get', { p_owner: user.id, p_job: uuid(id) });
      if (!job.confirmed_at)
        throw failure('The customer has not confirmed this job yet.', 409);
      return reply({
        job: { ...job, notification: undefined, link_hash: undefined }
      });
    }
    let portal = await jobs('portal', { p_owner: user.id });
    if (!portal)
      portal = await jobs('portal-create', {
        p_owner: user.id,
        p_data: {
          ...newLink(),
          settings: {
            ...defaults,
            shopName:
              profile.business_name || profile.full_name || 'Print shop',
            email: user.email
          }
        }
      });
    const list = await jobs('list', { p_owner: user.id });
    const token = linkToken(portal);
    const setupIssues = portalSetup(request);
    if (!token) setupIssues.push('The saved link cannot be recovered with the current signing key. Click Create/Enable link to replace it.');
    const active = Boolean(portal?.enabled && token && setupIssues.length === 0);
    let origin = '';
    try { origin = publicOrigin(request); } catch { /* Report in setupIssues, do not fabricate a link. */ }
    return reply({
      portal: portal
        ? {
            settings: portal.settings,
            enabled: portal.enabled,
            active,
            status: active ? 'active' : 'setup_required',
            url: token && origin ? `${origin}/client-upload/${token}` : ''
          }
        : {
            settings: { ...defaults, email: user.email },
            enabled: false,
            url: ''
          },
      jobs: list,
      setupIssues,
      emailConfigured: emailReady(),
      serverTime: new Date().toISOString()
    });
  } catch (e) {
    return errorReply(e);
  }
}
export async function POST(request) {
  try {
    const { user } = await accountActor(request),
      body = await request.json(),
      old = await jobs('portal', { p_owner: user.id });
    await rate(request, `portal-settings:${user.id}`, 30);
    if (body.action !== 'disable') publicOrigin(request);
    if (body.action !== 'disable' && !process.env.CRON_SECRET)
      throw failure(
        'Configure Vercel CRON_SECRET before enabling uploads.',
        503
      );
    if (!['save', 'rotate', 'disable'].includes(body.action))
      throw failure('Invalid portal action.', 400);
    if (body.action !== 'disable' && !emailReady())
      throw failure(
        'Configure Client Jobs email delivery and SMART_SHEET_SITE_URL before enabling the upload link.',
        503
      );
    const link =
      !old || !linkToken(old) || body.action === 'rotate'
        ? newLink()
        : { hash: old.link_hash, secret: old.link_secret };
    const config = settings(
      body.action === 'save' ? body.settings : old?.settings
    );
    await jobs('portal-save', {
      p_owner: user.id,
      p_data: { ...link, settings: config, enabled: body.action !== 'disable' }
    });
    return GET(request);
  } catch (e) {
    return errorReply(e);
  }
}
