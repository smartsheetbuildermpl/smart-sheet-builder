import { supabaseFetch } from '../../../_lib/supabase';
import { json, ready, sameOrigin, bodyFields, appAuthUrl, readCookie, setCookie } from '../../../_lib/password-auth';
export const dynamic = 'force-dynamic';
const message = 'If this email has an account awaiting confirmation, we sent a new confirmation email. Check your inbox and spam folder.';
export async function POST(request) {
  try {
    ready(); sameOrigin(request);
    const body = await bodyFields(request, ['email']);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ message: 'Enter a valid email address.' }, 400);
    const previous = readCookie(request, 'ssb-email-confirmation');
    if (previous?.resendAfter > Date.now()) return json({ message, retryAfter: Math.ceil((previous.resendAfter - Date.now()) / 1000) });
    try { await supabaseFetch(`/auth/v1/resend?redirect_to=${encodeURIComponent(appAuthUrl(request))}`, { method: 'POST', body: { email, type: 'signup' } }); }
    catch (error) { if (!error.status || error.code === 'supabase_unreachable') throw error; }
    return setCookie(json({ message, retryAfter: 60 }), request, { ...previous, resendAfter: Date.now() + 60000, expires: Date.now() + 900000 }, 'ssb-email-confirmation');
  } catch { return json({ message: 'Confirmation service is temporarily unavailable. Please try again.' }, 503); }
}
