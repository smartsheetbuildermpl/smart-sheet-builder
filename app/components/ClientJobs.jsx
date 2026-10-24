'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ClientJobPreview from './ClientJobPreview';
import PrintLayoutLoading from './PrintLayoutLoading';
import UploadProfiles from './UploadProfiles';
import PortalActionDialog from './PortalActionDialog';
import { machineLabel } from '../lib/client-upload-profiles';
const stamp = (v) => (v ? new Date(v).toLocaleString() : 'Not recorded');
function status(j, now) {
  return new Date(j.expires_at) <= now
    ? 'Expired — files are no longer available.'
    : j.downloaded_png || j.downloaded_tiff
      ? 'Downloaded'
      : j.confirmed_at
        ? 'Confirmed'
        : 'Draft';
}
function countdown(j, now) {
  const seconds = Math.max(0, Math.ceil((new Date(j.expires_at) - now) / 1000));
  return seconds
    ? `Expires in ${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`
    : 'Expired';
}
function statusLabel(j, now) {
  if (new Date(j.expires_at) <= now) return 'Expired';
  if (j.downloaded_png || j.downloaded_tiff) return 'Downloaded';
  return j.confirmed_at ? 'Confirmed' : 'Draft';
}
function statusTone(j, now) {
  return statusLabel(j, now).toLowerCase();
}
export default function ClientJobs({ auth, builderRef, hidden, onSignIn }) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState(null),
    [config, setConfig] = useState(null),
    [profileId, setProfileId] = useState(''),
    [profileName, setProfileName] = useState(null),
    [creatingProfile, setCreatingProfile] = useState(false),
    [selected, setSelected] = useState(''),
    [detail, setDetail] = useState(null),
    [urls, setUrls] = useState({}),
    [busy, setBusy] = useState(false),
    [detailLoading, setDetailLoading] = useState(false),
    [previewBusy, setPreviewBusy] = useState(false),
    [previewReady, setPreviewReady] = useState(false),
    [detailError, setDetailError] = useState(''),
    [detailAttempt, setDetailAttempt] = useState(0),
    [exporting, setExporting] = useState(false),
    [exportProgress, setExportProgress] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [now, setNow] = useState(Date.now()),
    [offset, setOffset] = useState(0),
    [sheet, setSheet] = useState(0),
    [settingsOpen, setSettingsOpen] = useState(false),
    [editorOrigin, setEditorOrigin] = useState(null),
    [saveConfirmOrigin, setSaveConfirmOrigin] = useState(null);
  const dialog = useRef(null),
    frame = useRef(null),
    blobs = useRef({}),
    authRef = useRef(auth),
    exportJob = useRef(null),
    exportController = useRef(null),
    loadEpoch = useRef(0),
    links = useRef([]);
  authRef.current = auth;
  const accountId = auth.session?.user?.id || auth.email || '';
  useEffect(() => {
    exportController.current?.abort();
    setData(null);
    setConfig(null);
    setProfileId(''); setProfileName(null); setCreatingProfile(false);
    setDetail(null);
    setSelected('');
    setOpen(false);
    setSettingsOpen(false);
    setEditorOrigin(null);
    setSaveConfirmOrigin(null);
    setError('');
    setMessage('');
    setUrls({});
    blobs.current = {};
    links.current.forEach(URL.revokeObjectURL);
    links.current = [];
  }, [accountId]);
  const request = useCallback(
    async (path = '', body, signal) => {
      const r = await fetch(`/api/client-jobs${path}`, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
        signal,
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'Content-Type': 'application/json'
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.message);
      if (!path && (!d.portal || !Array.isArray(d.jobs)))
        throw Error('Client Portal is unavailable. Please retry.');
      return d;
    },
    [auth.accessToken]
  );
  const refresh = useCallback(async () => {
    const d = await request();
    if (authRef.current.accessToken !== auth.accessToken) return;
    setData(d);
    setOffset(Date.parse(d.serverTime) - Date.now());
    setConfig((c) => c || d.portal.settings);
  }, [request, auth.accessToken]);
  useEffect(() => {
    if (!auth.accessToken) {
      setOpen(false);
      setData(null);
      setDetail(null);
      setDetailLoading(false);
      setPreviewBusy(false);
      setDetailError('');
      return;
    }
    let live = true;
    const poll = () =>
      request()
        .then((d) => {
          if (live) {
            setData(d);
            setOffset(Date.parse(d.serverTime) - Date.now());
            setConfig((c) => c || d.portal.settings);
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    poll();
    const id = setInterval(poll, 60000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [auth.accessToken, request]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(id);
  }, [offset]);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('clientJob');
    if (!id || !auth.ready) return;
    if (!auth.signedIn) {
      onSignIn();
      return;
    }
    setSelected(id);
    setOpen(true);
    history.replaceState(null, '', '/');
  }, [auth.ready, auth.signedIn, onSignIn]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (detail && new Date(detail.expires_at) <= now) {
      loadEpoch.current++;
      setDetail(null);
      setUrls({});
      blobs.current = {};
      links.current.forEach(URL.revokeObjectURL);
      links.current = [];
    }
  }, [detail, now]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController(),
      epoch = ++loadEpoch.current;
    setDetail(null);
    setUrls({});
    setSheet(0);
    blobs.current = {};
    links.current.forEach(URL.revokeObjectURL);
    links.current = [];
    setDetailLoading(false);
    setPreviewBusy(false);
    setDetailError('');
    if (open && selected) {
      setDetailLoading(true);
      setError('');
      (async () => {
        const d = await request(`?id=${encodeURIComponent(selected)}`, undefined, controller.signal),
          nextBlobs = {},
          nextUrls = {};
        for (const a of d.job.assets.filter((a) => a.ready)) {
          const r = await fetch(`/api/client-jobs/${d.job.id}/files/${a.id}`, {
            headers: { Authorization: `Bearer ${auth.accessToken}` },
            cache: 'no-store',
            signal: controller.signal
          });
          if (!r.ok) {
            const e = await r.json();
            throw Error(e.message);
          }
          const blob = await r.blob();
          if (!live || epoch !== loadEpoch.current) return;
          nextBlobs[a.id] = blob;
          nextUrls[a.id] = URL.createObjectURL(blob);
          links.current.push(nextUrls[a.id]);
        }
        if (live && epoch === loadEpoch.current) {
          blobs.current = nextBlobs;
          setUrls(nextUrls);
          setDetail(d.job);
        }
      })()
        .catch((e) => {
          if (live && epoch === loadEpoch.current) {
            links.current.forEach(URL.revokeObjectURL); links.current = [];
            setDetailError(e.message);
          }
        })
        .finally(() => {
          if (live) setDetailLoading(false);
        });
    }
    return () => {
      live = false;
      controller.abort();
    };
  }, [selected, open, request, auth.accessToken, detailAttempt]);
  useEffect(
    () => () => {
      exportController.current?.abort();
      links.current.forEach(URL.revokeObjectURL);
    },
    []
  );
  useEffect(() => {
    async function handler(event) {
      const p = event.data;
      if (
        event.origin !== location.origin ||
        event.source !== frame.current?.contentWindow ||
        p?.type !== 'SMART_SHEET_EXPORT_REQUEST' ||
        !exportJob.current
      )
        return;
      const result = await authRef.current.recordExport(p.exportKind, {
        ...p.operation,
        jobId: exportJob.current
      });
      if (!result.allowed)
        setError(result.message || 'Export access could not be verified.');
      event.source.postMessage(
        {
          type: 'SMART_SHEET_EXPORT_RESPONSE',
          requestId: p.requestId,
          ...result
        },
        event.origin
      );
    }
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);
  async function mutate(action, target = portal) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const d = await request('', { action: creatingProfile && action === 'save' ? 'create' : action,
        profileId: creatingProfile && action === 'save' ? undefined : target?.id,
        name:profileName ?? portal?.name, settings: config });
      if (authRef.current.accessToken !== auth.accessToken) return;
      setData(d);
      const next = d.profiles.find(p => p.id === d.selectedProfileId) || d.portal;
      setProfileId(next.id); setProfileName(next.name); setCreatingProfile(false); setConfig(next.settings);
      const successMessage =
        action === 'disable'
          ? 'Upload link disabled. Existing confirmed submissions remain available.'
          : action === 'rotate'
            ? 'New upload link ready. The previous link can no longer accept submissions.'
            : action === 'duplicate' ? 'Profile duplicated with its own disabled link. Review settings before enabling.' : 'Profile and settings saved.';
      setMessage(successMessage);
      return { profile:next, message:successMessage };
    } catch (e) {
      if (authRef.current.accessToken === auth.accessToken) setError(e.message);
      return { error:e.message };
    } finally {
      if (authRef.current.accessToken === auth.accessToken) setBusy(false);
    }
  }
  async function download(kind) {
    if (!detail || exporting) return;
    setError('');
    setExporting(true);
    setExportProgress('Checking export access…');
    exportJob.current = detail.id;
    exportController.current = new AbortController();
    try {
      await request(`?id=${detail.id}&exportSheet=${sheet}`);
      if (detail.manifest.mediaMode === 'continuous') {
        await frame.current.contentWindow.smartSheetClientJob.exportRollJob(detail, kind, body => fetch(`/api/client-jobs/${detail.id}/render`, {
          method:'POST', cache:'no-store', signal:exportController.current.signal, headers:{Authorization:`Bearer ${authRef.current.accessToken}`,'Content-Type':'application/json'}, body:JSON.stringify(body)
        }), setExportProgress);
      } else await frame.current.contentWindow.smartSheetClientJob.exportJob(
        detail,
        blobs.current,
        sheet,
        kind
      );
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      exportJob.current = null;
      exportController.current = null;
      setExporting(false);
    }
  }
  const count =
    data?.jobs.filter((j) => status(j, now) === 'Confirmed').length || 0;
  const portal = creatingProfile ? null : data?.profiles?.find(p => p.id === profileId) || data?.portal;
  function editProfile(p, event) { setCreatingProfile(false); setProfileId(p.id); setProfileName(p.name); setConfig(p.settings); setMessage(''); setError(''); setEditorOrigin(event.currentTarget); }
  if (!auth.signedIn || !auth.accessToken) return null;
  return (
    <>
      <button
        className="access-button client-portal-trigger"
        type="button"
        aria-haspopup="dialog"
        hidden={hidden}
        onClick={() => {
          setOpen(true);
          refresh().catch((e) => setError(e.message));
        }}
      >
        Client Portal{count > 0 && <span className="client-submission-badge" aria-label={`${count} new client submissions`}>{count}</span>}
      </button>
      {typeof document !== 'undefined' && createPortal(<dialog
        className="client-jobs-dialog"
        ref={dialog}
        aria-labelledby="client-jobs-title"
        onCancel={(e) => {
          e.preventDefault();
          if (!exporting) setOpen(false);
        }}
      >
        <header>
          <div>
            <h1 id="client-jobs-title">Client Portal</h1>
            <p>Collect client artwork through your private upload link.</p>
          </div>
          <div className="client-dialog-header-actions">
            <button
              type="button"
              className="secondary client-icon-button"
              aria-label="Shop portal settings"
              title="Shop portal settings"
              aria-expanded={settingsOpen}
              disabled={exporting}
              onClick={() => setSettingsOpen((value) => !value)}
            >
              ⚙
            </button>
            <button aria-label="Close Client Portal" disabled={exporting} onClick={() => setOpen(false)}>×</button>
          </div>
        </header>
        {error && (
          <p role="alert" className="client-error">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
        {settingsOpen && <section className="client-card client-settings-panel" aria-label="Shop portal settings">
          <div className="client-settings-panel-heading"><div><h2>Shop portal settings</h2><p>Manage the private upload link and print layout defaults.</p></div><button type="button" className="secondary" onClick={() => setSettingsOpen(false)}>Done</button></div>
          {!!data?.serviceWarnings?.length && (
            <div className="client-notice" role="status">
              <ul>{data.serviceWarnings.map(issue => <li key={issue}>{issue}</li>)}</ul>
              <p>Localhost uses its own environment settings. Restart the local server after updating them; Vercel changes require a redeploy.</p>
            </div>
          )}
          <UploadProfiles profiles={data?.profiles || []} selectedId={portal?.id} busy={busy || exporting}
            onEdit={editProfile} onAction={mutate} setupIssues={data?.setupIssues}
            onCreate={event => { setCreatingProfile(true); setProfileName(''); setConfig({ ...config, gapIn:0.3, edgeIn:0.5 }); setError(''); setMessage(''); setEditorOrigin(event.currentTarget); }} />
          {editorOrigin && open && config && <PortalActionDialog title={creatingProfile ? 'New upload profile' : `Edit ${portal?.name || 'upload profile'}`} origin={editorOrigin} wide busy={busy || exporting} onClose={() => setEditorOrigin(null)}>
          {error && <p role="alert" className="client-error">{error}</p>}
          {message && <p role="status">{message}</p>}
          <form onSubmit={(e) => { e.preventDefault(); if (!creatingProfile && !portal?.active) setSaveConfirmOrigin(e.nativeEvent.submitter || document.activeElement); else mutate('save'); }}>
                    <label>Profile name<input data-initial-focus required maxLength={120} value={profileName ?? portal?.name ?? ''} onChange={e => setProfileName(e.target.value)} /></label>
                    <label>
                      Shop display name
                      <input
                        required
                        maxLength={120}
                        value={config.shopName}
                        onChange={(e) =>
                          setConfig({ ...config, shopName: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Notification email
                      <input
                        type="email"
                        required
                        value={config.email}
                        onChange={(e) =>
                          setConfig({ ...config, email: e.target.value })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        const s =
                          builderRef.current?.contentWindow?.smartSheetClientJob?.settings();
                        if (s) setConfig({ ...config, ...s });
                      }}
                    >
                      Use current Builder sheet settings
                    </button>
                    <button type="button" className="secondary" onClick={() => setConfig({ ...config, gapIn: 0.3, edgeIn: 0.5 })}>Reset portal layout defaults</button>
                    <p className="client-muted">New portal defaults: 0.30 in spacing · 0.50 in edge allowance. Changes apply after saving; confirmed layouts stay locked.</p>
                    <label>
                      Printing machine
                      <select
                        aria-label="Printing machine"
                        value={config.machine}
                        onChange={(e) =>
                          setConfig({ ...config, machine: e.target.value })
                        }
                      >
                        <option value="dtf">DTF</option>
                        <option value="uvdtf24">UV-DTF 24″</option>
                        <option value="uvdtf12">UV-DTF 12″</option>
                        <option value="tarpaulin">Tarpaulin</option>
                      </select>
                    </label>
                    <label>
                      Media mode
                      <select aria-label="Media mode" value={config.mediaMode || (config.machine === 'dtf' && !config.autoExtend ? 'continuous' : 'fixed')}
                        onChange={e => setConfig({ ...config, mediaMode: e.target.value, leadIn: config.leadIn ?? config.edgeIn, trailIn: config.trailIn ?? config.edgeIn })}>
                        <option value="fixed">Fixed sheet</option>
                        <option value="continuous">Continuous roll</option>
                      </select>
                    </label>
                    <p className="client-muted">Media mode changes apply only after saving and generating a new preview. Confirmed submissions stay locked.</p>
                    <div className="client-settings-grid">
                      {[
                        ['widthIn', config.mediaMode === 'continuous' ? 'Printable roll width (in)' : 'Sheet width (in)'],
                        ...(config.mediaMode === 'continuous' ? [['leadIn', 'Lead allowance (in)'], ['trailIn', 'Trail allowance (in)']] : [['lengthIn', 'Sheet length (in)']]),
                        ['dpi', 'Output DPI'],
                        ['gapIn', 'Spacing (in)'],
                        ['edgeIn', config.mediaMode === 'continuous' ? 'Left/right allowance per side (in)' : 'Auto-layout edge allowance (in)']
                      ].map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <input
                            type="number"
                            step="any"
                            required
                            value={config[key] ?? config.edgeIn}
                            onChange={(e) =>
                              setConfig({
                                ...config,
                                [key]: Number(e.target.value)
                              })
                            }
                          />
                        </label>
                      ))}
                      {[
                        ['maxFileMiB', 'Per-file upload limit (MiB)'],
                        ['maxTotalMiB', 'Submission upload limit (MiB)']
                      ].map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <input type="number" min="1" max={key === 'maxFileMiB' ? 100 : 300} step="1" required value={config[key] ?? (key === 'maxFileMiB' ? 50 : 150)} onChange={(e) => setConfig({ ...config, [key]: Number(e.target.value) })} />
                        </label>
                      ))}
                    </div>
                    {config.mediaMode === 'continuous' && <p className="client-muted">Meter segment: 39.37007874 in = 1 m. Length extends as needed. Meter lines are preview/accounting markers; artwork can cross them. Lead/trail allowance applies once to the entire job.</p>}
                    <label>
                      <input
                        type="checkbox"
                        checked={config.rotate}
                        onChange={(e) =>
                          setConfig({ ...config, rotate: e.target.checked })
                        }
                      />{' '}
                      Allow auto-rotate to fill gaps
                    </label>
                    {config.mediaMode !== 'continuous' && <label>
                      <input
                        type="checkbox"
                        checked={config.autoExtend}
                        onChange={(e) =>
                          setConfig({ ...config, autoExtend: e.target.checked })
                        }
                      />{' '}
                      {config.mediaMode === 'fixed' ? 'Create another sheet when full' : 'Create another sheet when full (legacy DTF unchecked: continuous roll)'}
                    </label>}
                    <p>
                      Artwork sizing: use uploaded artwork at 300 PPI, after
                      transparent-margin trimming.
                    </p>
                    <p className="client-muted">Upload limits are enforced by the portal server and private storage. New profiles default to 50 MiB per PNG and 150 MiB per submission.</p>
                    {!!data?.setupIssues?.length && (
                      <div className="client-error">
                        <p>Complete these server settings before enabling this link:</p>
                        <ul>{data.setupIssues.map(issue => <li key={issue}>{issue}</li>)}</ul>
                      </div>
                    )}
                    <button disabled={busy || exporting}>
                      {creatingProfile ? 'Create profile' : portal?.active ? 'Save portal settings' : 'Create/Enable link'}
                    </button>
          </form>
          {saveConfirmOrigin && <PortalActionDialog title="Save settings and enable link?" origin={saveConfirmOrigin} busy={busy} onClose={() => setSaveConfirmOrigin(null)}>
            <p>Save these settings and enable the upload link for {portal?.name}. Clients can submit new artwork using these settings. Confirmed submissions remain unchanged.</p>
            {error && <p role="alert" className="client-error">{error}</p>}
            <div className="client-action-buttons"><button type="button" className="secondary" data-initial-focus disabled={busy} onClick={() => setSaveConfirmOrigin(null)}>Cancel</button>
            <button type="button" disabled={busy} onClick={async () => { const result = await mutate('save'); if (result?.profile) setSaveConfirmOrigin(null); }}>{busy ? 'Saving…' : 'Save and enable'}</button></div>
          </PortalActionDialog>}
          </PortalActionDialog>}
        </section>}
        <div className="client-columns client-owner-grid">
          <section>
            <div className="client-section-heading">
              <div>
                <h2>Client submissions</h2>
                <p>
                  Review confirmed layouts and monitor temporary file access.
                </p>
              </div>
              <small>{data?.jobs.length || 0} total · newest first</small>
            </div>
            {!data?.jobs.length && (
              <p className="client-empty-state">
                No client submissions yet. Share your upload link to get
                started.
              </p>
            )}
            <div className="client-submission-list">
              {data?.jobs.map((j) => {
                const expired = new Date(j.expires_at) <= now;
                return (
                  <article
                    className={`client-submission-row ${selected === j.id ? 'selected' : ''}`}
                    key={j.id}
                  >
                    <div className="client-submission-identity">
                      <h3 title={j.reference || 'Client submission'}>
                        {j.reference || 'Client submission'}
                      </h3>
                      <small>
                        Submitted {stamp(j.confirmed_at || j.created_at)}
                      </small>
                      <span className="client-profile-badge">{j.profile_name || 'Legacy / Default Profile'} · {machineLabel(j.machine)}</span>
                    </div>
                    <dl className="client-submission-metrics">
                      <div>
                        <dt>Designs</dt>
                        <dd>{j.design_count}</dd>
                      </div>
                      <div>
                        <dt>Quantity</dt>
                        <dd>{j.quantity}</dd>
                      </div>
                      <div>
                        <dt>Estimated</dt>
                        <dd>{Number(j.meters).toFixed(3)} m</dd>
                      </div>
                    </dl>
                    <div className="client-submission-status">
                      <span className={`client-status-badge ${statusTone(j, now)}`}>
                        {statusLabel(j, now)}
                      </span>
                      <small>
                        {expired
                          ? 'Expired — files are no longer available.'
                          : countdown(j, now)}
                      </small>
                    </div>
                    <div className="client-submission-actions">
                      <button
                        className="secondary"
                        disabled={busy || detailLoading || previewBusy || exporting || !j.confirmed_at || expired}
                        onClick={() => setSelected(j.id)}
                      >
                        View details
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
          <section className="client-card client-detail-panel" aria-busy={detailLoading || previewBusy || exporting}>
            <h2>{detail?.reference || 'Print layout'}</h2>
            {detailLoading && <PrintLayoutLoading stage="Preparing artwork…" />}
            {detailError && <div role="alert" className="client-error">We couldn’t load this print layout. {detailError} <button type="button" className="secondary" onClick={() => setDetailAttempt(value => value + 1)}>Retry layout</button></div>}
            {detail ? (
              <>
                <p>
                  {countdown(detail, now)} · exact expiry{' '}
                  {stamp(detail.expires_at)}
                </p>
                <p>
                  {detail.quantity} pieces · {Number(detail.meters).toFixed(3)}{' '}
                  m · {detail.manifest.dpi} DPI
                </p>
                <p className="client-profile-badge">{detail.profile_name || 'Legacy / Default Profile'} · {machineLabel(detail.machine || detail.manifest.config?.machine)}</p>
                <p>
                  Locked at confirmation. Final files use original PNG sources,
                  never this scaled preview.
                </p>
                <ClientJobPreview
                  manifest={detail.manifest}
                  assets={detail.assets}
                  urls={urls}
                  onBusyChange={setPreviewBusy}
                  onReadyChange={setPreviewReady}
                />
                <label>
                  {detail.manifest.mediaMode === 'continuous' ? 'Export roll job' : 'Export sheet'}
                  <select
                    aria-label={detail.manifest.mediaMode === 'continuous' ? 'Export roll job' : 'Export sheet'}
                    disabled={exporting}
                    value={sheet}
                    onChange={(e) => setSheet(Number(e.target.value))}
                  >
                    {detail.manifest.sheets.map((s, i) => (
                      <option key={i} value={i}>
                        {detail.manifest.mediaMode === 'continuous' ? 'Roll job' : `Sheet ${i + 1}`} · {s.widthPx} × {s.heightPx} px
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={exporting || !previewReady || new Date(detail.expires_at) <= now}
                  onClick={() => download('png')}
                >
                  Download layout PNG
                </button>
                <button
                  disabled={exporting || !previewReady || new Date(detail.expires_at) <= now}
                  onClick={() => download('tiff')}
                >
                  Convert layout to TIFF
                </button>
                <p className="client-muted">
                  Each final file uses your normal export access / credit
                  allowance. Previewing is free.
                </p>
                {exporting && <p role="status" aria-live="polite" className="client-render-progress">{exportProgress}</p>}
              </>
            ) : !detailLoading && !detailError && (
              <p>Select a confirmed client submission to view its locked print layout.</p>
            )}
          </section>
        </div>
        {open && (
          <iframe
            ref={frame}
            src="/builder.html?clientJob=1"
            title="Client submission production export"
            className={exporting && (detail?.manifest.mediaMode !== 'continuous' || ['Review TIFF settings…','Saving full-resolution print file…'].includes(exportProgress)) ? 'client-export-frame' : 'client-export-idle'}
          />
        )}
      </dialog>, document.body)}
    </>
  );
}
