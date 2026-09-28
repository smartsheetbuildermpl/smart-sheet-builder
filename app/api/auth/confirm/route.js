import { supabaseFetch } from '../../_lib/supabase';
import { json, ready, sameOrigin, bodyFields, readCookie, revokeTemporarySession } from '../../_lib/password-auth';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  try {
    ready(); sameOrigin(request);
    const body = await bodyFields(request, ['code', 'token_hash', 'access_token']);
    if (Object.keys(body).length !== 1) throw new Error('Invalid proof');
    let token, user;
    if (typeof body.token_hash === 'string' && /^[a-zA-Z0-9_-]{20,512}$/.test(body.token_hash)) {
      const session = await supabaseFetch('/auth/v1/verify', { method: 'POST', body: { token_hash: body.token_hash, type: 'signup' } });
      token = session.access_token; user = session.user;
    } else if (typeof body.code === 'string' && body.code.length <= 512 && readCookie(request, 'ssb-email-confirmation')?.verifier) {
      const session = await supabaseFetch('/auth/v1/token?grant_type=pkce', { method: 'POST', body: { auth_code: body.code, code_verifier: readCookie(request, 'ssb-email-confirmation').verifier } });
      token = session.access_token; user = session.user;
    } else if (typeof body.access_token === 'string' && body.access_token.length <= 16384) {
      // Legacy implicit callbacks: verify with Auth, never trust URL claims.
      user = await supabaseFetch('/auth/v1/user', { token: body.access_token });
    }
    if (!user?.id || !user.email_confirmed_at) throw new Error('Email not confirmed');
    if (token) await revokeTemporarySession(token);
    return json({ confirmed: true });
  } catch (error) {
    return json({ message: error.status >= 500 ? 'Confirmation service is temporarily unavailable. Please try again or request a new email.' : 'This confirmation link is invalid or expired.' }, error.status >= 500 ? 503 : 400);
  }
}
