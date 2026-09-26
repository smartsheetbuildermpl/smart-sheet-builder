import { supabaseFetch } from '../../../_lib/supabase';
import { json, ready, sameOrigin, resetUrl, pkce, readCookie, setCookie, bodyFields, passwordFailure } from '../../../_lib/password-auth';
import { RESET_REQUEST_MESSAGE } from '../../../../lib/password-rules';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  try {
    ready(); sameOrigin(request);
    const body = await bodyFields(request, ['email']);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ message: 'Enter a valid email address.' }, 400);
    const redirect = resetUrl(request), previous = readCookie(request);
    if (new URL(redirect).origin !== new URL(request.url).origin) return json({ message: `Open ${new URL(redirect).origin} to request a reset link. The recovery link and this browser must use the same app address.` }, 409);
    if (previous?.resendAfter > Date.now()) return json({ message: RESET_REQUEST_MESSAGE, retryAfter: Math.ceil((previous.resendAfter - Date.now()) / 1000) });
    const proof = pkce();
    try {
      await supabaseFetch(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirect)}`, { method: 'POST', body: { email, code_challenge: proof.challenge, code_challenge_method: 's256' } });
    } catch (error) {
      // Supabase may return account-dependent SMTP/rate-limit errors. Mask all
      // HTTP outcomes identically; only a network outage is a public error.
      if (!error.status) throw error;
    }
    return setCookie(json({ message: RESET_REQUEST_MESSAGE, retryAfter: 60 }), request, { verifier: proof.verifier, resendAfter: Date.now() + 60000, expires: Date.now() + 900000 });
  } catch (error) { return passwordFailure(error); }
}
