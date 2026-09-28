// Shared server-side origin policy. Never trust forwarded Host headers for links.
export function publicAppOrigin(request, { localPortal = false } = {}) {
  const isLocal = (u) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  const current = request ? new URL(request.url) : null;
  // `next start` is also used locally. It must not copy a production portal URL.
  if (localPortal && !process.env.VERCEL && current && isLocal(current) && ['http:', 'https:'].includes(current.protocol)) return current.origin;
  const host = process.env.VERCEL_ENV === 'preview' ? process.env.VERCEL_URL : process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const configured = process.env.SMART_SHEET_SITE_URL || (host ? `https://${host}` : '');
  const fallback = process.env.NODE_ENV !== 'production' && current && isLocal(current) ? current.origin : '';
  try {
    const url = new URL(configured || fallback);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        (url.protocol !== 'https:' && !(isLocal(url) && !process.env.VERCEL && process.env.NODE_ENV !== 'production' && url.protocol === 'http:')) ||
        (isLocal(url) && (process.env.VERCEL || process.env.NODE_ENV === 'production'))) throw Error();
    return url.origin;
  } catch {
    const error = new Error('Configure SMART_SHEET_SITE_URL with the app origin (HTTPS in production).');
    error.status = 503;
    error.code = 'portal_configuration_error';
    throw error;
  }
}
