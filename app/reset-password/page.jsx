'use client';
import { useEffect, useRef, useState } from 'react';
import PasswordRequestForm from '../components/PasswordRequestForm';
import PasswordFields from '../components/PasswordFields';
import { passwordError } from '../lib/password-rules';
import { browserAuth } from '../lib/browser-auth';
export default function ResetPasswordPage() {
  const attempt = useRef(null), retryVerification = useRef(null);
  const [state, setState] = useState('checking'), [message, setMessage] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false), [warning, setWarning] = useState('');
  useEffect(() => {
    let live = true;
    function verify(body, key) {
      setState('checking'); setMessage('');
      // Reattach to the same promise under StrictMode. The SDK exchange runs on
      // the server with the HttpOnly PKCE verifier, never twice in the browser.
      if (attempt.current?.key !== key) attempt.current = {key, promise:fetch('/api/auth/password/verify', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
      }).then(async response => ({ok:response.ok,status:response.status,data:await response.json()}))};
      const current = attempt.current;
      current.promise.then(({ok,status,data}) => {
        if (!live || attempt.current !== current) return;
        if (ok && data.ready === true) {
          // Keep the recovery parameters until Auth and the protected server
          // session are both ready. Do not persist them in local/session storage.
          history.replaceState(null, '', '/reset-password');
          setState('ready'); return;
        }
        console.error('[password-recovery]', {status,code:data.code || 'verification_failed'});
        if (status >= 500 || data.code === 'recovery_unavailable') {
          setState('unavailable'); setMessage(data.message || 'The password recovery service is temporarily unavailable. Please retry.');
        } else {
          setState('invalid'); setMessage(data.message || 'This recovery link is invalid, expired, or already used. Request a new reset link.');
        }
      }).catch(() => {
        if (live && attempt.current === current) { setState('unavailable'); setMessage('Unable to reach the recovery service. Check your connection and retry.'); }
      });
    }
    function verifyLink() {
      const query = new URLSearchParams(location.search), hash = new URLSearchParams(location.hash.slice(1));
      const code = query.get('code'), token_hash = query.get('type') === 'recovery' ? query.get('token_hash') : null;
      const access_token = hash.get('type') === 'recovery' ? hash.get('access_token') : null;
      if (query.has('error') || hash.has('error') || (hash.has('access_token') && !access_token)) {
        setState('invalid'); setMessage('This recovery link is invalid, expired, or already used. Request a new reset link.'); return;
      }
      const body = code ? {code} : token_hash ? {token_hash} : access_token ? {access_token,...(hash.get('refresh_token') ? {refresh_token:hash.get('refresh_token')} : {})} : {resume:true};
      verify(body, location.search + location.hash || 'resume');
    }
    retryVerification.current = () => { attempt.current = null; verify({resume:true},'retry'); };
    verifyLink(); window.addEventListener('hashchange', verifyLink);
    return () => { live = false; retryVerification.current = null; window.removeEventListener('hashchange', verifyLink); };
  }, []);
  return <main className="password-page"><div className="password-card"><p className="access-kicker">Smart Sheet Builder</p><h1>{state === 'request' ? 'Request a password reset' : state === 'ready' ? 'Set new password' : 'Reset password'}</h1>
    {state === 'checking' && <p role="status">Checking your recovery link…</p>}
    {['invalid','unavailable'].includes(state) && <><p role="alert">{message}</p>
      {state === 'unavailable' && <button onClick={() => retryVerification.current?.()}>Retry verification</button>}
      <button onClick={() => { history.replaceState(null, '', '/reset-password'); attempt.current = null; setState('request'); }}>Request a new reset link</button></>}
    {state === 'request' && <PasswordRequestForm />}
    {state === 'success' && <div role="status"><p>Password changed successfully</p>{warning && <p>{warning}</p>}<a className="auth-success-link" href="/?signin=1">Sign in</a></div>}
    {state === 'ready' && <form className="auth-form" noValidate onSubmit={async e => {
      e.preventDefault(); const validation = passwordError(password, confirmation); setMessage(validation); if (validation || busy) return;
      setBusy(true);
      try {
        const r = await fetch('/api/auth/password/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, confirmation }) });
        const data = await r.json();
        if (!r.ok) { if (data.code === 'invalid_recovery') setState('invalid'); const error = new Error('Password update rejected'); error.publicMessage = data.message; throw error; }
        localStorage.removeItem('smart-sheet-builder-v53b-session');
        // A local sign-out failure must not misreport a completed password update.
        try { await browserAuth()?.signOut({ scope: 'local' }); } catch { localStorage.removeItem('ssb-supabase-auth-v1'); }
        setState('success'); setWarning(data.warning || '');
      } catch (e) { setMessage(e.publicMessage || 'Unable to reach the password service. Check your connection before trying again.'); }
      finally { setPassword(''); setConfirmation(''); setBusy(false); }
    }}>
      <PasswordFields password={password} confirmation={confirmation} setPassword={setPassword} setConfirmation={setConfirmation} disabled={busy} confirmationLabel="Confirm password" />
      {message && <p role="alert">{message}</p>}<button disabled={busy} type="submit">{busy ? 'Saving…' : 'Save password'}</button>
    </form>}
  </div></main>;
}
