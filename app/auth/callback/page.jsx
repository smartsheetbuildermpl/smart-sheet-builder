'use client';
import { useEffect, useRef, useState } from 'react';
export default function ConfirmationPage() {
  const started = useRef(false);
  const [state, setState] = useState('checking'), [message, setMessage] = useState(''), [email, setEmail] = useState(''), [busy, setBusy] = useState(false), [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    function verifyLink() {
    if (started.current) return; started.current = true;
    setState('checking');
    const query = new URLSearchParams(location.search), hash = new URLSearchParams(location.hash.slice(1));
    if (query.get('type') === 'recovery' || hash.get('type') === 'recovery') { location.replace('/reset-password' + location.search + location.hash); return; }
    const code = query.get('code'), token_hash = query.get('token_hash'), access_token = hash.get('access_token');
    history.replaceState(null, '', '/auth/callback');
    if (query.has('error') || hash.has('error') || (!code && !token_hash && !access_token)) { setState('invalid'); setMessage('This confirmation link is invalid or expired.'); return; }
    fetch('/api/auth/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(code ? { code } : token_hash ? { token_hash } : { access_token }) })
      .then(async r => { const d = await r.json(); if (!r.ok || d.confirmed !== true) { setState('invalid'); setMessage(d.message || 'This confirmation link is invalid or expired.'); return; } setState('success'); })
      .catch(() => { setState('invalid'); setMessage('Unable to reach the confirmation service. Check your connection and try again, or request a new confirmation email.'); });
    }
    const changed = () => { if (location.hash) { started.current = false; verifyLink(); } };
    verifyLink(); window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(n => n - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  return <main className="password-page"><div className="password-card"><p className="access-kicker">Smart Sheet Builder</p>
    <h1>{state === 'success' ? 'Email confirmed' : state === 'checking' ? 'Confirming your email' : 'Email confirmation'}</h1>
    {state === 'checking' && <p role="status">Checking your confirmation link…</p>}
    {state === 'success' ? <><p>Your Smart Sheet Builder account is ready.</p><a className="auth-success-link" href="/?signin=1">Sign in</a></> : state !== 'checking' && <>
      <p role="alert">{message}</p>
      <form className="auth-form" onSubmit={async e => { e.preventDefault(); if (busy || cooldown) return; setBusy(true); try {
        const r = await fetch('/api/auth/confirmation/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
        const d = await r.json(); setMessage(d.message || 'Confirmation service is temporarily unavailable.'); if (r.ok) setCooldown(d.retryAfter || 60);
      } catch { setMessage('Unable to reach the confirmation service. Check your connection and try again.'); } finally { setBusy(false); } }}>
        <label>Email address<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} /></label>
        <button disabled={busy || cooldown > 0}>{busy ? 'Sending…' : cooldown ? `Resend in ${cooldown}s` : 'Send a new confirmation email'}</button>
      </form><a href="/?signin=1">Back to Sign in</a>
    </>}
  </div></main>;
}
