import { supabaseFetch } from '../../../_lib/supabase';
import { json, ready, sameOrigin, bodyFields, readCookie, setCookie, clearCookie } from '../../../_lib/password-auth';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  try {
    ready(); sameOrigin(request);
    const body = await bodyFields(request, ['code', 'token_hash']);
    const proof = readCookie(request);
    let session;
    if (typeof body.token_hash === 'string' && /^[a-zA-Z0-9_-]{20,512}$/.test(body.token_hash) && !body.code) {
      session = await supabaseFetch('/auth/v1/verify', { method: 'POST', body: { token_hash: body.token_hash, type: 'recovery' } });
    } else if (typeof body.code === 'string' && body.code.length <= 512 && !body.token_hash && proof?.verifier) {
      session = await supabaseFetch('/auth/v1/token?grant_type=pkce', { method: 'POST', body: { auth_code: body.code, code_verifier: proof.verifier } });
    } else throw new Error('Invalid recovery proof');
    if (!session.access_token || !session.user?.id) throw new Error('No recovery session');
    const ticket = await supabaseFetch('/rest/v1/rpc/ssb_create_password_recovery', { method: 'POST', service: true, body: { p_user: session.user.id } });
    return setCookie(json({ ready: true }), request, { token: session.access_token, userId: session.user.id, ticket, expires: Date.now() + 900000 });
  } catch (error) {
    if (error.status >= 500 || error.data?.code === 'PGRST202') return clearCookie(json({ message: 'Recovery could not be prepared. Contact support or request a new link after the password service is available.', code: 'recovery_unavailable' }, 503));
    return clearCookie(json({ message: 'This recovery link is invalid, expired, or already used. Request a new reset link and open it in the same browser.', code: 'invalid_recovery' }, 401));
  }
}
