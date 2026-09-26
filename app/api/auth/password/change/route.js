import { getUserFromRequest, supabaseFetch } from '../../../_lib/supabase';
import { json, ready, sameOrigin, bodyFields, passwordFailure, updateUserPassword, recordPasswordChange, revokeTemporarySession } from '../../../_lib/password-auth';
import { passwordError } from '../../../../lib/password-rules';
export const dynamic = 'force-dynamic';
export async function POST(request) {
  let freshToken;
  try {
    ready(); sameOrigin(request);
    const body = await bodyFields(request, ['currentPassword', 'password', 'confirmation']);
    const validation = passwordError(body.password, body.confirmation);
    if (validation) return json({ message: validation }, 400);
    if (typeof body.currentPassword !== 'string' || !body.currentPassword || body.currentPassword.length > 1024) return json({ message: 'Enter your current password.' }, 400);
    const user = await getUserFromRequest(request);
    if (!user) return json({ message: 'Please sign in again before changing your password.' }, 401);
    let fresh;
    try {
      fresh = await supabaseFetch('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: user.email, password: body.currentPassword } });
    } catch (error) {
      if (error.status === 400 || error.status === 401 || error.status === 422) return json({ message: 'Current password could not be verified. Check it and try again.' }, 400);
      throw error;
    }
    freshToken = fresh.access_token;
    if (!freshToken || fresh.user?.id !== user.id) return json({ message: 'Your session could not be re-authenticated. Please sign in again.' }, 401);
    await updateUserPassword(freshToken, body.password);
    const warning = await recordPasswordChange(user.id);
    return json({ message: 'Password changed successfully', warning });
  } catch (error) { return passwordFailure(error); }
  finally { if (freshToken) await revokeTemporarySession(freshToken); }
}
