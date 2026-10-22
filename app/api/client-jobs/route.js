import { accountActor, failure } from '../_lib/user-management';
import { uploadProfileTemplates } from '../../lib/client-upload-profiles';
import { outputProblem } from '../../lib/client-portal-limits';
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
import { text } from '../_lib/client-jobs';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  try {
    const { user, profile } = await accountActor(request),
      id = new URL(request.url).searchParams.get('id');
    if (id) {
      const job = await jobs('get', { p_owner: user.id, p_job: uuid(id) });
      if (!job.confirmed_at)
        throw failure('The customer has not confirmed this job yet.', 409);
      const selected = new URL(request.url).searchParams.get('exportSheet');
      if (selected !== null) {
        const issue = outputProblem(job.manifest, /^\d+$/.test(selected) ? Number(selected) : -1, job.assets);
        if (issue) throw failure(issue, 400);
      }
      return reply({
        job: { ...job, notification: undefined, link_hash: undefined }
      });
    }
    const profiles = await jobs('profiles-init', {
        p_owner: user.id,
        p_data: {
          templates: uploadProfileTemplates.map(template => ({ ...newLink(), key: template.key, name: template.name,
            settings: settings({ ...defaults, dpi:template.dpi || defaults.dpi, machine: template.machine, widthIn: template.widthIn, lengthIn: template.lengthIn,
              shopName: profile.business_name || profile.full_name || 'Print shop', email: user.email }) }))
        }
      });
    const list = await jobs('list', { p_owner: user.id });
    const setupIssues = portalSetup(request);
    let origin = '';
    try { origin = publicOrigin(request); } catch { /* Report in setupIssues, do not fabricate a link. */ }
    const visibleProfiles = profiles.map(p => {
      const token = linkToken(p), active = Boolean(p.enabled && token && setupIssues.length === 0);
      return { id: p.id, name: p.name, template: p.template_key, settings: p.settings, enabled: p.enabled, active,
        status: active ? 'active' : 'setup_required', url: token && origin ? `${origin}/client-upload/${token}` : '' };
    });
    return reply({
      profiles: visibleProfiles,
      portal: visibleProfiles[0], // Compatibility for existing owner clients; no secret fields.
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
    const { user } = await accountActor(request), body = await request.json();
    await rate(request, `portal-settings:${user.id}`, 30);
    if (body.action !== 'disable') publicOrigin(request);
    if (body.action !== 'disable' && !process.env.CRON_SECRET)
      throw failure(
        'Configure Vercel CRON_SECRET before enabling uploads.',
        503
      );
    if (!['save', 'rotate', 'disable', 'enable', 'create', 'duplicate'].includes(body.action))
      throw failure('Invalid portal action.', 400);
    if (body.action !== 'disable' && !emailReady())
      throw failure(
        'Configure Client Jobs email delivery and SMART_SHEET_SITE_URL before enabling the upload link.',
        503
      );
    const profileId = body.profileId ? uuid(body.profileId) : null;
    const old = profileId
      ? await jobs('profile-get', { p_owner: user.id, p_data: { id: profileId } })
      : await jobs('portal', { p_owner: user.id });
    if (['duplicate','enable'].includes(body.action) && !profileId) throw failure('Choose an upload profile.',400);
    const link =
      !old || !linkToken(old) || body.action === 'rotate'
        ? newLink()
        : { hash: old.link_hash, secret: old.link_secret };
    const config = settings(['save','create'].includes(body.action) ? body.settings : old?.settings);
    if (profileId || body.action === 'create') {
      const name = text(['save','create'].includes(body.action) ? body.name : body.action === 'duplicate' ? `${old.name.slice(0,110)} (copy)` : old.name);
      if (!name || /[\u0000-\u001f\u007f]/.test(name)) throw failure('Enter a profile name.',400);
      const created = ['create','duplicate'].includes(body.action);
      const saved = await jobs(created ? 'profile-create' : 'profile-save', {
        p_owner: user.id, p_data: { id: profileId, ...(created ? newLink() : link), name, settings:config,
          enabled: body.action === 'disable' ? false : body.action === 'rotate' ? old.enabled : true }
      });
      const response = await GET(request), data = await response.json();
      if (!response.ok) return reply(data,response.status);
      return reply({ ...data, selectedProfileId:saved.id });
    }
    // Preserve the pre-profile owner API for legacy integrations and old links.
    await jobs('portal-save', {
      p_owner: user.id,
      p_data: { ...link, settings: config, enabled: body.action !== 'disable' }
    });
    return GET(request);
  } catch (e) {
    return errorReply(e);
  }
}
