'use client';
import { useEffect, useState } from 'react';
import RegistrationFields, { emptyRegistration } from './RegistrationFields';
export default function AccountProfile({ token }) {
  const [value, setValue] = useState(emptyRegistration), [message, setMessage] = useState(''), [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/profile', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store' }).then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.message); if (!data.profile) throw new Error('Profile could not be loaded. Close Account and retry.'); if (!controller.signal.aborted) { setValue(data.profile); setReady(true); } }).catch(e => { if (!controller.signal.aborted) setMessage(e.message); });
    return () => controller.abort();
  }, [token]);
  return <form className="auth-form" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setMessage('');
    try { const r = await fetch('/api/auth/profile', { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); const data = await r.json(); if (!r.ok) throw new Error(data.message); setMessage(data.message); } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }}>
    {ready && <><RegistrationFields value={value} onChange={setValue} registration={false} /><button disabled={busy} type="submit">{busy ? 'Saving…' : 'Save profile'}</button></>}
    <p role="status">{message || (!ready ? 'Loading profile…' : '')}</p>
  </form>;
}
