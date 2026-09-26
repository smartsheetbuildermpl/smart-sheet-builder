'use client';
import { useEffect, useState } from 'react';
import { RESET_REQUEST_MESSAGE } from '../lib/password-rules';
const COOLDOWN_KEY = 'ssb-password-resend-after';
export default function PasswordRequestForm({ onBack }) {
  const [email, setEmail] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [remaining, setRemaining] = useState(0);
  useEffect(() => {
    const tick = () => { try { setRemaining(Math.max(0, Math.ceil((Number(sessionStorage.getItem(COOLDOWN_KEY)) - Date.now()) / 1000))); } catch {} };
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, []);
  return <form className="auth-form" onSubmit={async e => {
    e.preventDefault(); if (busy || remaining) return; setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/auth/password/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message);
      const delay = Math.max(1, Number(data.retryAfter) || 60); setRemaining(delay);
      try { sessionStorage.setItem(COOLDOWN_KEY, String(Date.now() + delay * 1000)); } catch {}
      setMessage(RESET_REQUEST_MESSAGE);
    } catch (e) { setError(e.message || 'Unable to send the request. Check your connection and try again.'); } finally { setBusy(false); }
  }}>
    <p>We’ll email you a link to reset your password. Open it in this browser.</p>
    <label>Email address<input type="email" autoComplete="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} required /></label>
    <button type="submit" disabled={busy || remaining > 0}>{busy ? 'Sending…' : remaining ? `Resend in ${remaining}s` : 'Send reset link'}</button>
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
    {onBack ? <button type="button" className="password-link" onClick={onBack}>Back to Sign In</button> : <a href="/?signin=1">Back to Sign In</a>}
  </form>;
}
