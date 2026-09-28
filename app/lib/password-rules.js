export const RESET_REQUEST_MESSAGE = 'If an account exists for this email, we sent a password reset link. Please check your inbox and spam folder.';
export function passwordError(password, confirmation) {
  if (typeof password !== 'string' || password.length < 8) return 'Use at least 8 characters for your new password.';
  if (password.length > 1024) return 'Use no more than 1024 characters.';
  if (password !== confirmation) return 'The new passwords do not match.';
  return '';
}
