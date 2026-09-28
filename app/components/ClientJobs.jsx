'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ClientJobPreview from './ClientJobPreview';
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
    [selected, setSelected] = useState(''),
    [detail, setDetail] = useState(null),
    [urls, setUrls] = useState({}),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [now, setNow] = useState(Date.now()),
    [offset, setOffset] = useState(0),
    [sheet, setSheet] = useState(0),
    [settingsOpen, setSettingsOpen] = useState(false);
  const dialog = useRef(null),
    frame = useRef(null),
    blobs = useRef({}),
    authRef = useRef(auth),
    exportJob = useRef(null),
    loadEpoch = useRef(0),
    links = useRef([]);
  authRef.current = auth;
  const accountId = auth.session?.user?.id || auth.email || '';
  useEffect(() => {
    setData(null);
    setConfig(null);
    setDetail(null);
    setSelected('');
    setOpen(false);
    setSettingsOpen(false);
    setError('');
    setMessage('');
    setUrls({});
    blobs.current = {};
    links.current.forEach(URL.revokeObjectURL);
    links.current = [];
  }, [accountId]);
  const request = useCallback(
    async (path = '', body) => {
      const r = await fetch(`/api/client-jobs${path}`, {
        method: body ? 'POST' : 'GET',
        cache: 'no-store',
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
    if (open && selected) {
      setBusy(true);
      setError('');
      (async () => {
        const d = await request(`?id=${encodeURIComponent(selected)}`),
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
          if (!live) return;
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
          if (live) setError(e.message);
        })
        .finally(() => {
          if (live) setBusy(false);
        });
    }
    return () => {
      live = false;
      controller.abort();
    };
  }, [selected, open, request, auth.accessToken]);
  useEffect(
    () => () => {
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
  async function mutate(action) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const d = await request('', { action, settings: config });
      if (authRef.current.accessToken !== auth.accessToken) return;
      setData(d);
      setConfig(d.portal.settings);
      setMessage(
        action === 'disable'
          ? 'Upload link disabled. Existing confirmed submissions remain available.'
          : action === 'rotate'
            ? 'New upload link ready. The previous link can no longer accept submissions.'
            : 'Upload link and settings saved.'
      );
    } catch (e) {
      if (authRef.current.accessToken === auth.accessToken) setError(e.message);
    } finally {
      if (authRef.current.accessToken === auth.accessToken) setBusy(false);
    }
  }
  async function download(kind) {
    if (!detail || exporting) return;
    setError('');
    setExporting(true);
    exportJob.current = detail.id;
    try {
      await request(`?id=${detail.id}`);
      await frame.current.contentWindow.smartSheetClientJob.exportJob(
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
      setExporting(false);
    }
  }
  const count =
    data?.jobs.filter((j) => status(j, now) === 'Confirmed').length || 0;
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
          <section className="client-link-card">
            <h3>Share Client Upload Link</h3>
            <p role="status"><strong>{data?.portal.active ? 'Portal link active' : 'Portal link setup required'}</strong></p>
            {data?.portal.enabled === false && <p>This upload portal is currently disabled. Complete settings, then click Create/Enable link.</p>}
            {data?.setupIssues?.length > 0 && <ul>{data.setupIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
            {data?.portal.url && <><input aria-label="Client upload link" readOnly value={data.portal.url} /><div className="client-link-actions"><button disabled={!data.portal.active} onClick={async () => { try { await navigator.clipboard.writeText(data.portal.url); setMessage('Upload link copied.'); } catch { setError('Copy the displayed link manually.'); } }}>Copy upload link</button>{typeof navigator !== 'undefined' && typeof navigator.share === 'function' && <button type="button" className="secondary" disabled={!data.portal.active} onClick={async () => { try { await navigator.share({ title: 'Client Upload Portal', url: data.portal.url }); setMessage('Upload link shared.'); } catch (e) { if (e?.name !== 'AbortError') setError('The upload link could not be shared.'); } }}>Share</button>}<button className="secondary" disabled={busy || exporting} onClick={() => { if (confirm('Replace this link? Customers using the old link will need the new one. Existing client submissions are preserved.')) mutate('rotate'); }}>Regenerate link</button><button className="secondary" disabled={busy || exporting || !data.portal.enabled} onClick={() => { if (confirm('Disable new client submissions? Existing confirmed submissions remain available.')) mutate('disable'); }}>Disable link</button></div></>}
          </section>
          {config && <form onSubmit={(e) => { e.preventDefault(); mutate('save'); }}>
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
                    <label>
                      Printing machine
                      <select
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
                    <div className="client-settings-grid">
                      {[
                        ['widthIn', 'Sheet width (in)'],
                        ['lengthIn', 'Sheet length (in)'],
                        ['dpi', 'Output DPI'],
                        ['gapIn', 'Spacing (in)'],
                        ['edgeIn', 'Auto-layout edge allowance (in)']
                      ].map(([key, label]) => (
                        <label key={key}>
                          {label}
                          <input
                            type="number"
                            step="any"
                            required
                            value={config[key]}
                            onChange={(e) =>
                              setConfig({
                                ...config,
                                [key]: Number(e.target.value)
                              })
                            }
                          />
                        </label>
                      ))}
                    </div>
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
                    <label>
                      <input
                        type="checkbox"
                        checked={config.autoExtend}
                        onChange={(e) =>
                          setConfig({ ...config, autoExtend: e.target.checked })
                        }
                      />{' '}
                      Create another sheet when full (DTF unchecked: continuous
                      roll)
                    </label>
                    <p>
                      Artwork sizing: use uploaded artwork at 300 PPI, after
                      transparent-margin trimming.
                    </p>
                    {!data?.emailConfigured && (
                      <p className="client-error">
                        An administrator must configure the email provider and
                        production site URL before this link can be enabled.
                      </p>
                    )}
                    <button disabled={busy || exporting}>
                      {data?.portal.active ? 'Save portal settings' : 'Create/Enable link'}
                    </button>
          </form>}
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
                        disabled={busy || exporting || !j.confirmed_at || expired}
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
          <section className="client-card client-detail-panel">
            <h2>{detail?.reference || 'Print layout'}</h2>
            {busy && <p role="status">Loading private original sources…</p>}
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
                <p>
                  Locked at confirmation. Final files use original PNG sources,
                  never this scaled preview.
                </p>
                <ClientJobPreview
                  manifest={detail.manifest}
                  assets={detail.assets}
                  urls={urls}
                />
                <label>
                  Export sheet
                  <select
                    disabled={exporting}
                    value={sheet}
                    onChange={(e) => setSheet(Number(e.target.value))}
                  >
                    {detail.manifest.sheets.map((s, i) => (
                      <option key={i} value={i}>
                        Sheet {i + 1} · {s.widthPx} × {s.heightPx} px
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={exporting || new Date(detail.expires_at) <= now}
                  onClick={() => download('png')}
                >
                  Download layout PNG
                </button>
                <button
                  disabled={exporting || new Date(detail.expires_at) <= now}
                  onClick={() => download('tiff')}
                >
                  Convert layout to TIFF
                </button>
                <p className="client-muted">
                  Each final file uses your normal export access / credit
                  allowance. Previewing is free.
                </p>
              </>
            ) : (
              <p>Select a confirmed client submission to view its locked print layout.</p>
            )}
          </section>
        </div>
        {open && (
          <iframe
            ref={frame}
            src="/builder.html?clientJob=1"
            title="Client submission production export"
            className={exporting ? 'client-export-frame' : 'client-export-idle'}
          />
        )}
      </dialog>, document.body)}
    </>
  );
}
