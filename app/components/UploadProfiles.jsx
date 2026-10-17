'use client';
import { machineLabel } from '../lib/client-upload-profiles';
export default function UploadProfiles({ profiles, selectedId, busy, onEdit, onCreate, onAction, onMessage, onError }) {
  async function share(profile, native) {
    try {
      if (native && navigator.share) await navigator.share({title:profile.name,url:profile.url});
      else { await navigator.clipboard.writeText(profile.url); onMessage('Upload link copied.'); }
    } catch (e) { if (e.name !== 'AbortError') onError('The link could not be shared. Open Edit to copy the displayed link manually.'); }
  }
  return <section aria-label="Upload Profiles" className="client-upload-profiles">
    <div className="client-section-heading"><div><h2>Upload Profiles</h2><p>Each private link uses its own saved machine and layout settings.</p></div><button type="button" disabled={busy} onClick={onCreate}>Create new profile</button></div>
    <div className="client-profile-list">{profiles.map(p => <article className={`client-profile-row ${p.id === selectedId ? 'selected' : ''}`} key={p.id} aria-label={p.name}>
      <div><h3>{p.name}</h3><small>{machineLabel(p.settings.machine)} · {p.settings.widthIn} × {p.settings.lengthIn} in · {p.settings.dpi} DPI</small></div>
      <span className={`client-status-badge ${p.active ? 'confirmed' : 'expired'}`}>{p.enabled ? p.active ? 'Active' : 'Setup required' : 'Disabled'}</span>
      <div className="client-profile-actions">
        <button type="button" className="secondary" disabled={busy || !p.active} onClick={() => share(p,false)}>Copy link</button>
        <button type="button" className="secondary" disabled={busy || !p.active} onClick={() => share(p,true)}>Share</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => onEdit(p)}>Edit</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => onAction('duplicate',p)}>Duplicate profile</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { if (confirm(`Regenerate only the ${p.name} link? Its old link will stop accepting submissions. Confirmed history stays available.`)) onAction('rotate',p); }}>Regenerate link</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { if (p.enabled && !confirm(`Disable ${p.name}? Existing confirmed submissions stay available.`)) return; onAction(p.enabled ? 'disable' : 'enable',p); }}>{p.enabled ? 'Disable' : 'Enable link'}</button>
      </div>
    </article>)}</div>
  </section>;
}
