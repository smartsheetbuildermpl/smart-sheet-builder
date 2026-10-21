import { supabaseFetch } from '../../../_lib/supabase';
import { createHash } from 'node:crypto';
import { json, ready, sameOrigin, bodyFields, readCookie, setCookie, clearCookie } from '../../../_lib/password-auth';
import { exchangeRecoveryCode, establishRecoveryTokens } from '../../../_lib/recovery-session';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  let phase = 'proof', pending;
  try {
    ready(); sameOrigin(request);
    const body = await bodyFields(request, ['code', 'token_hash', 'access_token', 'refresh_token', 'resume']);
    const fields = Object.keys(body);
    if (!(fields.length === 1 || fields.length === 2 && fields.includes('access_token') && fields.includes('refresh_token'))) throw new Error('Invalid recovery proof');
    const proof = readCookie(request);
    if (typeof body.code === 'string' && !proof?.verifier) return clearCookie(json({message:'This older reset link is tied to the browser that requested it. Request a new reset email to open it on another computer or phone.',code:'recovery_browser_mismatch'},401));
    let session, implicitProof;
    phase = 'session';
    if (body.resume === true && proof?.token && proof?.userId) {
      const user = await supabaseFetch('/auth/v1/user', { token: proof.token });
      if (user.id !== proof.userId) throw new Error('Recovery identity mismatch');
      if (proof.ticket) {
        const tickets = await supabaseFetch(`/rest/v1/password_recovery_tickets?id=eq.${encodeURIComponent(proof.ticket)}&user_id=eq.${encodeURIComponent(user.id)}&used_at=is.null&select=id,expires_at`, {service:true});
        if (!tickets?.some(ticket => Date.parse(ticket.expires_at) > Date.now())) throw new Error('Recovery link already used');
        return json({ ready:true });
      }
      if (!proof.pending) throw new Error('No pending recovery');
      session = {access_token:proof.token, user}; implicitProof = proof.implicitProof;
    } else if (typeof body.token_hash === 'string' && /^[a-zA-Z0-9_-]{20,512}$/.test(body.token_hash) && !body.code) {
      session = await supabaseFetch('/auth/v1/verify', { method: 'POST', body: { token_hash: body.token_hash, type: 'recovery' } });
    } else if (typeof body.code === 'string' && body.code.length <= 512 && !body.token_hash && proof?.verifier) {
      session = await exchangeRecoveryCode(body.code, proof.verifier);
    } else if (typeof body.access_token === 'string' && body.access_token.length <= 16384) {
      // Supabase's implicit email verification uses AMR "otp". Validate the
      // exact JWT with Auth BEFORE reading claims, and require recent email
      // authentication after a recovery request. A password-session JWT plus
      // a forged #type=recovery fragment is never sufficient.
      if (body.refresh_token != null && (typeof body.refresh_token !== 'string' || !body.refresh_token || body.refresh_token.length > 16384)) throw new Error('Invalid recovery tokens');
      const established = body.refresh_token ? await establishRecoveryTokens(body.access_token, body.refresh_token) : null;
      const token = established?.access_token || body.access_token;
      const user = established?.user || await supabaseFetch('/auth/v1/user', { token });
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      const now = Date.now() / 1000, sent = Date.parse(user.recovery_sent_at) / 1000;
      const amr = claims.amr?.find(a => ['otp','recovery'].includes(a.method) && a.timestamp >= sent - 5 && a.timestamp <= now + 5 && now - a.timestamp <= 900);
      if (!user.id || claims.sub !== user.id || !claims.session_id || !amr || !Number.isFinite(sent) || now - sent > 900 || sent > now + 5 || !Number.isFinite(claims.exp) || claims.exp <= now) throw new Error('No recent recovery authentication');
      implicitProof = createHash('sha256').update(`${claims.session_id}:${amr.timestamp}`).digest('hex');
      session = { access_token: token, user };
    } else throw new Error('Invalid recovery proof');
    if (!session.access_token || !session.user?.id) throw new Error('No recovery session');
    // If ticket setup is temporarily unavailable, retain only this already
    // verified recovery proof in the encrypted HttpOnly cookie. Retrying never
    // exchanges a one-use Auth code again or accepts a normal login session.
    pending = { token:session.access_token, userId:session.user.id, pending:true, implicitProof, expires:proof?.pending ? proof.expires : Date.now()+900000 };
    phase = 'ticket';
    const ticket = await supabaseFetch(`/rest/v1/rpc/${implicitProof ? 'ssb_create_implicit_password_recovery' : 'ssb_create_password_recovery'}`, { method: 'POST', service: true, body: { p_user: session.user.id, ...(implicitProof ? { p_proof: implicitProof } : {}) } });
    return setCookie(json({ ready: true }), request, { token: session.access_token, userId: session.user.id, ticket, expires:pending.expires });
  } catch (error) {
    const code = error.data?.code || error.code;
    const unavailable = error.status >= 500 || ['PGRST202','PGRST205','42P01','42883','42501'].includes(code) || error.name === 'AuthRetryableFetchError' || error instanceof TypeError;
    console.error('[password-recovery]', { phase, status:error.status || 0, code:code || (unavailable ? 'service_unavailable' : 'invalid_recovery') });
    if (unavailable) {
      const response = json({ message: 'The password recovery service is temporarily unavailable. Your link has not been marked invalid. Please retry or contact support.', code:'recovery_unavailable' }, 503);
      return pending ? setCookie(response,request,pending) : response;
    }
    return clearCookie(json({ message: 'This recovery link is invalid, expired, or already used. Request a new reset link and open the newest email.', code: 'invalid_recovery' }, 401));
  }
}
