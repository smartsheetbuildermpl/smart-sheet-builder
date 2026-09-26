'use client';
import { useState } from 'react';
import PasswordFields from './PasswordFields';
import { passwordError } from '../lib/password-rules';
export default function ChangePassword({ token, onChanged }) {
  const [current, setCurrent] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <section className="account-security" aria-label="Security"><h3>Security</h3><details><summary>Change password</summary>
    <form className="auth-form" noValidate onSubmit={async e => {
      e.preventDefault(); const validation = passwordError(password, confirmation); setError(validation); if (validation || busy) return;
      setBusy(true);
      try {
        const response = await fetch('/api/auth/password/change', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: current, password, confirmation }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.message);
        onChanged(data.warning || '');
      } catch (e) { setError(e.message || 'Unable to change your password. Try again.'); }
      finally { setCurrent(''); setPassword(''); setConfirmation(''); setBusy(false); }
    }}>
      <label>Current password<input type="password" autoComplete="current-password" maxLength={1024} value={current} onChange={e => setCurrent(e.target.value)} disabled={busy} required /></label>
      <PasswordFields password={password} confirmation={confirmation} setPassword={setPassword} setConfirmation={setConfirmation} disabled={busy} />
      {error && <p role="alert">{error}</p>}<button type="submit" disabled={busy}>{busy ? 'Changing password…' : 'Change password'}</button>
    </form>
  </details></section>;
}
