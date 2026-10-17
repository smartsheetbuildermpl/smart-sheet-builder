'use client';
import { useState } from 'react';
import { machineLabel } from '../lib/client-upload-profiles';
import PortalActionDialog from './PortalActionDialog';
export default function UploadProfiles({ profiles, selectedId, busy, onEdit, onCreate, onAction, setupIssues = [] }) {
  const [action, setAction] = useState(null), [pending, setPending] = useState(false),
    [feedback, setFeedback] = useState(''), [error, setError] = useState('');
  const profile = profiles.find(p => p.id === action?.id);
  function open(kind, p, event) {
    setFeedback(''); setError('');
    setAction({kind, id:p.id, origin:event.currentTarget});
  }
  function choose(kind) { setFeedback(''); setError(''); setAction(a => ({...a, kind})); }
  async function share(native) {
    setPending(true); setError(''); setFeedback('');
    try {
      if (native && navigator.share) { await navigator.share({title:profile.name,url:profile.url}); setFeedback('Upload link shared.'); }
      else { await navigator.clipboard.writeText(profile.url); setFeedback('Upload link copied.'); }
    } catch (e) { if (e.name !== 'AbortError') setError('The link could not be shared. Copy the displayed link manually or retry.'); }
    finally { setPending(false); }
  }
  async function confirmAction() {
    if (pending) return;
    setPending(true); setError('');
    try {
      const result = await onAction(action.kind, profile);
      if (!result?.profile) { setError(result?.error || 'The link could not be updated. Please retry.'); return; }
      setFeedback(result.message);
      setAction(a => ({...a, kind:result.profile.active ? 'share' : 'setup'}));
    } catch (e) { setError(e.message || 'The link could not be updated. Please retry.'); }
    finally { setPending(false); }
  }
  const kind = action?.kind;
  const title = kind === 'share' ? 'Share Client Upload Link' : kind === 'setup' ? 'Portal link setup required' : kind === 'rotate' ? 'Regenerate upload link?' : kind === 'disable' ? 'Disable upload link?' : 'Enable upload link?';
  return <section aria-label="Upload Profiles" className="client-upload-profiles">
    <div className="client-section-heading"><div><h2>Upload Profiles</h2><p>Each private link uses its own saved machine and layout settings.</p></div><button type="button" disabled={busy} onClick={onCreate}>Create new profile</button></div>
    <div className="client-profile-list">{profiles.map(p => <article className={`client-profile-row ${p.id === selectedId ? 'selected' : ''}`} key={p.id} aria-label={p.name}>
      <div><h3>{p.name}</h3><small>{machineLabel(p.settings.machine)} · {p.settings.widthIn} × {p.settings.lengthIn} in · {p.settings.dpi} DPI</small></div>
      <span className={`client-status-badge ${p.active ? 'confirmed' : 'expired'}`}>{p.enabled ? p.active ? 'Active' : 'Setup required' : 'Disabled'}</span>
      <div className="client-profile-actions">
        <button type="button" className="secondary" aria-haspopup="dialog" disabled={busy} onClick={e => open(p.active && p.url ? 'share' : 'setup',p,e)}>Copy link</button>
        <button type="button" className="secondary" aria-haspopup="dialog" disabled={busy} onClick={e => open(p.active && p.url ? 'share' : 'setup',p,e)}>Share</button>
        <button type="button" className="secondary" aria-haspopup="dialog" disabled={busy} onClick={e => onEdit(p,e)}>Edit</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => onAction('duplicate',p)}>Duplicate profile</button>
        <button type="button" className="secondary" aria-haspopup="dialog" disabled={busy} onClick={e => open('rotate',p,e)}>Regenerate link</button>
        <button type="button" className="secondary" aria-haspopup="dialog" disabled={busy} onClick={e => open(p.enabled ? 'disable' : 'enable',p,e)}>{p.enabled ? 'Disable' : 'Enable link'}</button>
      </div>
    </article>)}</div>
    {action && profile && <PortalActionDialog title={title} origin={action.origin} busy={pending || busy} onClose={() => setAction(null)}>
      <p className="client-action-profile">{profile.name}</p>
      {kind === 'share' ? <>
        <p>Portal link active. Share this private upload link with your client.</p>
        <label>Client upload link<input readOnly value={profile.url} onFocus={e => e.target.select()} /></label>
        <div className="client-action-buttons"><button type="button" data-initial-focus disabled={pending || busy} onClick={() => share(false)}>Copy link</button>
          {typeof navigator.share === 'function' && <button type="button" className="secondary" disabled={pending || busy} onClick={() => share(true)}>Share</button>}</div>
      </> : kind === 'setup' ? <>
        <p>{!profile.enabled ? 'This upload portal is currently disabled. Enable this profile before sharing its link.' : !profile.url ? 'Generate a valid upload link for this profile before sharing it.' : 'This profile needs its portal configuration completed before its link can accept uploads.'}</p>
        {!!setupIssues.length && <ul>{setupIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
        <div className="client-action-buttons">
          {!profile.enabled ? <button type="button" data-initial-focus disabled={busy || pending} onClick={() => choose('enable')}>Enable link</button>
            : !profile.url ? <button type="button" data-initial-focus disabled={busy || pending} onClick={() => choose('rotate')}>Generate link</button> : null}
          <button type="button" className="secondary" disabled={busy || pending} onClick={() => { const origin = action.origin; setAction(null); onEdit(profile,{currentTarget:origin}); }}>Edit profile settings</button>
        </div>
      </> : <>
        <p>{kind === 'rotate' ? 'The old link for this profile will stop accepting submissions. A new private link will be generated. Other profile links and confirmed submission history stay unchanged.' : kind === 'disable' ? 'Clients will no longer be able to submit through this profile’s link. Existing confirmed submissions stay available until their original expiry.' : 'Clients will be able to upload through this profile’s link using its saved settings. Other profiles and confirmed submissions stay unchanged.'}</p>
        <div className="client-action-buttons"><button type="button" className="secondary" data-initial-focus disabled={pending || busy} onClick={() => setAction(null)}>Cancel</button>
          <button type="button" disabled={pending || busy} onClick={confirmAction}>{pending ? 'Updating…' : kind === 'rotate' ? 'Regenerate' : kind === 'disable' ? 'Disable link' : 'Enable link'}</button></div>
      </>}
      {feedback && <p role="status">{feedback}</p>}{error && <p role="alert" className="client-error">{error}</p>}
    </PortalActionDialog>}
  </section>;
}
