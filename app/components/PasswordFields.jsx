'use client';
export default function PasswordFields({ password, confirmation, setPassword, setConfirmation, disabled }) {
  return <>
    <p id="password-rules" className="users-hint">Use at least 8 characters. A long, unique password is recommended. Your account’s additional password rules also apply.</p>
    <label>New password<input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} aria-describedby="password-rules" disabled={disabled} required /></label>
    <label>Confirm new password<input type="password" autoComplete="new-password" minLength={8} maxLength={1024} value={confirmation} onChange={e => setConfirmation(e.target.value)} disabled={disabled} required /></label>
  </>;
}
