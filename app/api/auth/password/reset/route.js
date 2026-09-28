import { supabaseFetch } from '../../../_lib/supabase';
import { json, ready, sameOrigin, bodyFields, readCookie, clearCookie, passwordFailure, updateUserPassword, recordPasswordChange, revokeTemporarySession } from '../../../_lib/password-auth';
import { passwordError } from '../../../../lib/password-rules';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  let claimed = false;
  try {
    ready(); sameOrigin(request);
    const body = await bodyFields(request, ['password', 'confirmation']);
    const validation = passwordError(body.password, body.confirmation);
    if (validation) return json({ message: validation }, 400);
    const recovery = readCookie(request);
    if (!recovery?.token || !recovery.ticket) return clearCookie(json({ message: 'This recovery session has expired. Request a new reset link.', code: 'invalid_recovery' }, 401));
    const user = await supabaseFetch('/auth/v1/user', { token: recovery.token });
    if (user.id !== recovery.userId) throw new Error('Recovery identity mismatch');
    const valid = await supabaseFetch('/rest/v1/rpc/ssb_claim_password_recovery', { method: 'POST', service: true, body: { p_user: user.id, p_ticket: recovery.ticket } });
    if (!valid) return clearCookie(json({ message: 'This recovery link is expired or already used. Request a new reset link.', code: 'invalid_recovery' }, 401));
    claimed = true;
    await updateUserPassword(recovery.token, body.password);
    const warning = await recordPasswordChange(user.id);
    await revokeTemporarySession(recovery.token);
    return clearCookie(json({ message: 'Password changed successfully', warning }));
  } catch (error) {
    if (claimed) return clearCookie(json({ message: 'The password update could not be confirmed. Request a new reset link before trying again.', code: 'invalid_recovery' }, 400));
    if (error.status === 401 || error.status === 403) return clearCookie(json({ message: 'This recovery session is invalid or expired. Request a new reset link.', code: 'invalid_recovery' }, 401));
    return passwordFailure(error);
  }
}
