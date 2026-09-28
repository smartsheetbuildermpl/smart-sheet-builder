import { supabaseFetch } from '../../../_lib/supabase';
import { createHash } from 'node:crypto';
import { json, ready, sameOrigin, bodyFields, readCookie, setCookie, clearCookie } from '../../../_lib/password-auth';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  try {
    ready(); sameOrigin(request);
    const body = await bodyFields(request, ['code', 'token_hash', 'access_token']);
    if (Object.keys(body).length !== 1) throw new Error('Invalid recovery proof');
    const proof = readCookie(request);
    let session, implicitProof;
    if (typeof body.token_hash === 'string' && /^[a-zA-Z0-9_-]{20,512}$/.test(body.token_hash) && !body.code) {
      session = await supabaseFetch('/auth/v1/verify', { method: 'POST', body: { token_hash: body.token_hash, type: 'recovery' } });
    } else if (typeof body.code === 'string' && body.code.length <= 512 && !body.token_hash && proof?.verifier) {
      session = await supabaseFetch('/auth/v1/token?grant_type=pkce', { method: 'POST', body: { auth_code: body.code, code_verifier: proof.verifier } });
    } else if (typeof body.access_token === 'string' && body.access_token.length <= 16384) {
      // Supabase's implicit email verification uses AMR "otp". Validate the
      // exact JWT with Auth BEFORE reading claims, and require recent email
      // authentication after a recovery request. A password-session JWT plus
      // a forged #type=recovery fragment is never sufficient.
      const user = await supabaseFetch('/auth/v1/user', { token: body.access_token });
      const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString());
      const now = Date.now() / 1000, sent = Date.parse(user.recovery_sent_at) / 1000;
      const amr = claims.amr?.find(a => ['otp','recovery'].includes(a.method) && a.timestamp >= sent - 5 && a.timestamp <= now + 5 && now - a.timestamp <= 900);
      if (!user.id || claims.sub !== user.id || !claims.session_id || !amr || !Number.isFinite(sent) || now - sent > 900 || sent > now + 5 || !Number.isFinite(claims.exp) || claims.exp <= now) throw new Error('No recent recovery authentication');
      implicitProof = createHash('sha256').update(`${claims.session_id}:${amr.timestamp}`).digest('hex');
      session = { access_token: body.access_token, user };
    } else throw new Error('Invalid recovery proof');
    if (!session.access_token || !session.user?.id) throw new Error('No recovery session');
    const ticket = await supabaseFetch(`/rest/v1/rpc/${implicitProof ? 'ssb_create_implicit_password_recovery' : 'ssb_create_password_recovery'}`, { method: 'POST', service: true, body: { p_user: session.user.id, ...(implicitProof ? { p_proof: implicitProof } : {}) } });
    return setCookie(json({ ready: true }), request, { token: session.access_token, userId: session.user.id, ticket, expires: Date.now() + 900000 });
  } catch (error) {
    if (error.status >= 500 || error.data?.code === 'PGRST202') return clearCookie(json({ message: 'Recovery could not be prepared. Contact support or request a new link after the password service is available.', code: 'recovery_unavailable' }, 503));
    return clearCookie(json({ message: 'This recovery link is invalid, expired, or already used. Request a new reset link and open it in the same browser.', code: 'invalid_recovery' }, 401));
  }
}
