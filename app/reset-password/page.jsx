'use client';
import { useEffect, useRef, useState } from 'react';
import PasswordRequestForm from '../components/PasswordRequestForm';
import PasswordFields from '../components/PasswordFields';
import { passwordError } from '../lib/password-rules';
export default function ResetPasswordPage() {
  const started = useRef(false);
  const [state, setState] = useState('checking'), [message, setMessage] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false), [warning, setWarning] = useState('');
  useEffect(() => {
    if (started.current) return; started.current = true;
    const query = new URLSearchParams(location.search), hash = new URLSearchParams(location.hash.slice(1));
    const code = query.get('code'), token_hash = query.get('token_hash');
    // Scrub credentials immediately. They are never copied to persistent storage,
    // logged, or sent as a referrer. React StrictMode must not exchange twice.
    history.replaceState(null, '', '/reset-password');
    if (query.has('error') || hash.has('error') || (!code && !(token_hash && query.get('type') === 'recovery'))) {
      setState('invalid'); setMessage('This recovery link is invalid, expired, or already used. Request a new reset link.'); return;
    }
    fetch('/api/auth/password/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(code ? { code } : { token_hash }) })
      .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.message); setState('ready'); })
      .catch(e => { setState('invalid'); setMessage(e.message || 'Unable to verify this recovery link. Request a new reset link.'); });
  }, []);
  useEffect(() => {
    if (state !== 'success' || warning) return;
    const timer = setTimeout(() => location.replace('/?signin=1&passwordChanged=1'), 3000);
    return () => clearTimeout(timer);
  }, [state, warning]);
  return <main className="password-page"><div className="password-card"><p className="access-kicker">Smart Sheet Builder</p><h1>{state === 'request' ? 'Request a password reset' : 'Reset password'}</h1>
    {state === 'checking' && <p role="status">Checking your recovery link…</p>}
    {state === 'invalid' && <><p role="alert">{message}</p><button onClick={() => setState('request')}>Request a new reset link</button></>}
    {state === 'request' && <PasswordRequestForm />}
    {state === 'success' && <div role="status"><p>Password changed successfully</p>{warning && <p>{warning}</p>}<a href="/?signin=1">Continue to Sign In</a></div>}
    {state === 'ready' && <form className="auth-form" noValidate onSubmit={async e => {
      e.preventDefault(); const validation = passwordError(password, confirmation); setMessage(validation); if (validation || busy) return;
      setBusy(true);
      try {
        const r = await fetch('/api/auth/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, confirmation }) });
        const data = await r.json();
        if (!r.ok) { if (data.code === 'invalid_recovery') setState('invalid'); throw new Error(data.message); }
        localStorage.removeItem('smart-sheet-builder-v53b-session');
        setState('success'); setWarning(data.warning || '');
      } catch (e) { setMessage(e.message || 'Unable to complete the password update.'); }
      finally { setPassword(''); setConfirmation(''); setBusy(false); }
    }}>
      <PasswordFields password={password} confirmation={confirmation} setPassword={setPassword} setConfirmation={setConfirmation} disabled={busy} />
      {message && <p role="alert">{message}</p>}<button disabled={busy} type="submit">{busy ? 'Updating…' : 'Set new password'}</button>
    </form>}
  </div></main>;
}
