// Only localhost's existing offline test mode uses this. Real accounts and
// password recovery always use Supabase Auth, never a local password database.
export async function localPasswordVerifier(password, salt) {
  const bytes = salt ? Uint8Array.from(salt.match(/../g), byte => parseInt(byte, 16)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const digest = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: bytes, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hex = value => Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
  return { salt: hex(bytes), hash: hex(digest) };
}
export async function sanitizeLocalAccounts(accounts) {
  const result = {};
  for (const [email, account] of Object.entries(accounts || {})) {
    const { password, ...safe } = account;
    if (typeof password === 'string') safe.passwordVerifier = await localPasswordVerifier(password);
    result[email] = safe;
  }
  return result;
}
