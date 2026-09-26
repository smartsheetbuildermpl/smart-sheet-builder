'use client';
import { useEffect, useRef, useState } from 'react';

const date = value => value ? new Date(value).toLocaleString() : 'Not recorded';
const eventLabel = event => ({ export: 'Export access consumed', registration: 'Registration', password_changed_by_user: 'Password changed by user', admin_access_change: 'Admin access change' }[event] || 'Account activity');
const statusLabel = value => ({ active: 'Active', suspended: 'Suspended', pending_email_verification: 'Pending verification' }[value] || value);
const historyValue = value => Object.entries(value).map(([key, item]) => `${({ role: 'Role', export_access: 'Export access', account_status: 'Account status', status: 'Status', format: 'Format' })[key] || key}: ${item === 'blocked' ? 'Suspended' : item === 'pending_email_verification' ? 'Pending verification' : item}`).join(' · ');
export default function UsersDialog({ token, onClose }) {
  const dialog = useRef(null);
  const [search, setSearch] = useState(''), [status, setStatus] = useState(''), [access, setAccess] = useState('');
  const [page, setPage] = useState(0), [historyPage, setHistoryPage] = useState(0), [revision, setRevision] = useState(0);
  const [list, setList] = useState(null), [selected, setSelected] = useState(''), [detail, setDetail] = useState(null);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => { const el = dialog.current; el.showModal(); return () => el.close(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setList(null);
    const timeout = setTimeout(() => {
      fetch(`/api/admin/users?${new URLSearchParams({ search, status, access, offset: page * 30 })}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store' })
        .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.message); if (!controller.signal.aborted) setList(data); })
        .catch(e => { if (!controller.signal.aborted) { setError(e.message); setDetail(null); } });
    }, 200);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [token, search, status, access, page, revision]);
  useEffect(() => {
    setDetail(null);
    if (!selected) return;
    const controller = new AbortController();
    fetch(`/api/admin/users/${selected}?offset=${historyPage * 30}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store' })
      .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.message); if (!controller.signal.aborted) setDetail(data); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [token, selected, historyPage, revision]);
  async function change(field, value) {
    const u = detail.user;
    const action = field === 'status' ? (value === 'blocked' ? 'Suspend' : 'Reactivate') : `Set ${value} export access for`;
    if (!window.confirm(`${action} ${u.full_name || u.email} (${u.email})?\nThis change will be recorded in access history. It does not change admin or Design Library permissions.`)) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const r = await fetch(`/api/admin/users/${u.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ field, value, expectedUpdatedAt: u.updated_at }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.message); setMessage(data.message); setHistoryPage(0);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); setRevision(r => r + 1); }
  }
  const u = detail?.user;
  return <dialog ref={dialog} className="users-dialog" aria-labelledby="users-title" onCancel={e => { e.preventDefault(); if (!saving) onClose(); }} onKeyDown={e => {
    if (e.key !== 'Tab') return;
    const controls = Array.from(dialog.current.querySelectorAll('button,input,select,a[href]')).filter(el => !el.disabled && el.getClientRects().length);
    if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
    if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
  }}>
    <header><div><p className="access-kicker">Super Admin</p><h2 id="users-title">Users & Registrations</h2></div><button disabled={saving} type="button" onClick={onClose} aria-label="Close Users & Registrations">×</button></header>
    <div className="users-messages" aria-live="polite">{error && <p role="alert">{error}</p>}{message && <p>{message}</p>}</div>
    <div className="users-workspace">
      <section className="users-list" aria-label="User list">
        <label>Search name or email<input type="search" maxLength={200} value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} /></label>
        <div className="registration-columns"><label>Status<select value={status} onChange={e => { setStatus(e.target.value); setPage(0); }}><option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="pending_email_verification">Pending verification</option></select></label>
          <label>Access<select value={access} onChange={e => { setAccess(e.target.value); setPage(0); }}><option value="">All access</option><option value="standard">Standard</option><option value="unlimited">Unlimited</option></select></label></div>
        <button type="button" disabled={saving} onClick={() => setRevision(r => r + 1)}>Refresh users</button>
        <p role="status">{list ? `${list.total} matching users` : error ? 'Unable to load users.' : 'Loading users…'}</p>
        {list?.users.map(user => <button className="user-list-item" type="button" key={user.id} disabled={saving} aria-pressed={user.id === selected} onClick={() => { setSelected(user.id); setHistoryPage(0); setMessage(''); }}>
          <strong>{user.full_name || 'Name not provided'}</strong><span>{user.email}</span>
          <small>{statusLabel(user.account_status)} · {user.export_access === 'unlimited' ? 'Unlimited' : 'Standard'}</small>
          <small>{user.email_confirmed_at ? 'Email verified' : 'Email unverified'} · Registered {date(user.created_at)}</small>
        </button>)}
        {list?.total === 0 && <p>No users match these filters.</p>}
        <nav aria-label="User list pages"><button disabled={!page || saving} onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {page + 1}</span><button disabled={!list || (page + 1) * 30 >= list.total || saving} onClick={() => setPage(p => p + 1)}>Next</button></nav>
      </section>
      <section className="user-details" aria-label="Selected user details" aria-busy={Boolean(selected && !detail && !error)}>
        {!u ? <p>{selected ? error ? 'Refresh to retry loading this account.' : 'Loading account…' : 'Select a user to review their profile, access, and history.'}</p> : <>
          <h3>{u.full_name || u.email}</h3><p>{u.email}</p>
          <dl>{[
            ['Role', u.is_super_admin ? 'Super Admin / Executive Admin' : u.role === 'customer' || u.role === 'user' ? 'User (Basic)' : 'Legacy admin (not Super Admin)'],
            ['Account status', statusLabel(u.account_status)], ['Email', u.email_confirmed_at ? `Verified ${date(u.email_confirmed_at)}` : 'Unverified'],
            ['Export access', u.export_access === 'unlimited' ? 'Unlimited' : 'Standard'], ['Allowance used', `${u.exports_used} counted exports`], ['Remaining allowance', u.remaining === null ? 'Unlimited' : `${u.remaining} of 5`], ['Total recorded exports', u.recorded_exports],
            ['Design Library management', u.can_manage_design_library ? 'Owner only · Allowed' : 'Not permitted'], ['Registered', date(u.registered_at)], ['Last sign-in', date(u.last_sign_in_at)],
            ['Business / shop', u.business_name], ['Mobile', u.mobile], ['City', u.city], ['Country', u.country], ['Printing use', u.machine_type], ['Estimated monthly usage', u.monthly_usage], ['Notice acknowledged', date(u.terms_accepted_at)],
          ].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value === '' || value == null ? 'Not provided' : value}</dd></div>)}</dl>
          <p className="users-hint">Recorded exports reflect stored export events. Older unlogged exports and carried-over guest usage may not appear in history.</p>
          {u.is_super_admin ? <p>Owner critical access is protected. No access or status changes are available.</p> : <div className="user-actions">
            <button disabled={saving} onClick={() => change('export_access', u.export_access === 'unlimited' ? 'standard' : 'unlimited')}>Set {u.export_access === 'unlimited' ? 'Standard' : 'Unlimited'} access</button>
            <button disabled={saving} onClick={() => change('status', u.status === 'blocked' ? 'active' : 'blocked')}>{u.status === 'blocked' ? 'Reactivate account' : 'Suspend account'}</button>
          </div>}
          <h3>View History</h3>
          {!detail.history.length && <p>No activity recorded {historyPage ? 'on this page' : 'yet'}. Historical events have not been reconstructed.</p>}
          <ol className="user-history">{detail.history.map(event => <li key={event.sort_key}><strong>{eventLabel(event.event)}</strong><small>{date(event.created_at)}{event.actor_id && ` · ${event.actor_email || event.actor_id}`}</small>{event.old_value && <p>Before: {historyValue(event.old_value)}</p>}{event.new_value && <p>{event.old_value ? 'After' : 'Details'}: {historyValue(event.new_value)}</p>}</li>)}</ol>
          <nav aria-label="History pages"><button disabled={!historyPage || saving} onClick={() => setHistoryPage(p => p - 1)}>Newer</button><span>Page {historyPage + 1}</span><button disabled={detail.history.length < 30 || saving} onClick={() => setHistoryPage(p => p + 1)}>Older</button></nav>
        </>}
      </section>
    </div>
  </dialog>;
}
