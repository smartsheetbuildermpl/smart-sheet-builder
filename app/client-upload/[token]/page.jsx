'use client';
import { useEffect, useRef, useState } from 'react';
import ClientJobPreview from '../../components/ClientJobPreview';
import PrintLayoutLoading from '../../components/PrintLayoutLoading';
import { defaultDesignSize, validDesignSize, MAX_REQUESTED_SIZE_IN } from '../../lib/client-design-size';

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
const activeUploadStates = new Set(['Preparing upload', 'Uploading', 'Processing']);

export default function ClientUpload({ params }) {
  const [shop, setShop] = useState(''),
    [job, setJob] = useState(null),
    [session, setSession] = useState(''),
    [urls, setUrls] = useState({}),
    [uploads, setUploads] = useState({}),
    [reference, setReference] = useState(''),
    [quantities, setQuantities] = useState({}),
    [sizes, setSizes] = useState({}),
    [busy, setBusy] = useState(false),
    [operation, setOperation] = useState(''),
    [previewBusy, setPreviewBusy] = useState(false),
    [previewReady, setPreviewReady] = useState(false),
    [retryPreview, setRetryPreview] = useState(false),
    [error, setError] = useState(''),
    [errorCode, setErrorCode] = useState(''),
    [message, setMessage] = useState(''),
    [dirty, setDirty] = useState(true);
  const objects = useRef([]),
    actionController = useRef(null),
    fileInput = useRef(null),
    uploadQueue = useRef(Promise.resolve()),
    sessionRef = useRef(session),
    uploadsRef = useRef(uploads),
    uploadSerial = useRef(0),
    allReadyNotice = useRef(''),
    base = `/api/client-upload/${params.token}`;
  sessionRef.current = session;
  uploadsRef.current = uploads;

  useEffect(() => {
    let live = true;
    const allocated = objects.current;
    fetch(base, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({ code: 'portal_configuration_error', message: 'The upload portal is not deployed or could not be reached. Please contact the shop.' }));
        if (!r.ok) throw Object.assign(Error(d.message), { code: d.code });
        if (live) setShop(d.shopName);
      })
      .catch((e) => {
        if (live) { setError(e.message); setErrorCode(e.code || 'portal_configuration_error'); }
      });
    return () => {
      live = false;
      actionController.current?.abort();
      allocated.forEach(URL.revokeObjectURL);
    };
  }, [base]);

  useEffect(() => {
    const entries = Object.values(uploads);
    if (!entries.length || entries.some((entry) => activeUploadStates.has(entry.state)) || entries.some((entry) => entry.state === 'Failed')) return;
    const ready = entries.map((entry) => entry.id).sort().join('|');
    if (ready !== allReadyNotice.current) {
      allReadyNotice.current = ready;
      setMessage('All designs are ready for preview.');
    }
  }, [uploads]);

  async function call(action, body, token = sessionRef.current, headers = {}) {
    const r = await fetch(`${base}?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-submission': token, ...headers },
      body: body instanceof File ? body : JSON.stringify(body || {}),
      ...(actionController.current ? { signal: actionController.current.signal } : {})
    });
    const d = await r.json().catch(() => ({ code: 'portal_configuration_error', message: 'The upload portal could not be reached. Please retry later.' }));
    if (!r.ok) throw Object.assign(Error(d.message), { code: d.code });
    return d;
  }

  async function run(fn, kind = '') {
    if (actionController.current) return;
    const controller = new AbortController();
    actionController.current = controller;
    setBusy(true); setOperation(kind); setRetryPreview(false); setError(''); setErrorCode(''); setMessage('');
    try { await fn(); }
    catch (e) { if (!controller.signal.aborted) { setError(e.message); setErrorCode(e.code || 'portal_request_failed'); setRetryPreview(kind === 'preview'); } }
    finally { actionController.current = null; if (!controller.signal.aborted) { setBusy(false); setOperation(''); } }
  }

  function generatePreview() {
    if (previewBusy || hasUploadsInFlight || invalidSizes || !job?.assets.length) return;
    run(async () => {
      const d = await call('preview', { reference, quantities: job.assets.map(asset => ({ id: asset.id, qty: quantities[asset.id] ?? 1, widthIn: Number(designSize(asset).widthIn), heightIn: Number(designSize(asset).heightIn) })) });
      setPreviewBusy(true); setJob(d.job); setDirty(false);
    }, 'preview');
  }

  function patchUpload(id, patch) {
    setUploads((current) => current[id] ? { ...current, [id]: { ...current[id], ...patch } } : current);
  }

  async function validatePng(file) {
    if (!/\.png$/i.test(file.name) || file.size > 4194304) throw Error('Choose PNG files up to 4 MiB each.');
    const sig = new Uint8Array(await file.slice(0, 33).arrayBuffer());
    if (sig.length < 33 || !pngSignature.every((byte, index) => sig[index] === byte)) throw Error('This file is not a PNG.');
    const header = new DataView(sig.buffer), w = header.getUint32(16), h = header.getUint32(20);
    if (!w || !h || w > 8192 || h > 8192 || w * h > 16777216 || sig[24] !== 8) {
      throw Error('Use an 8-bit PNG up to 16 megapixels and 8192 pixels per side. The source will not be downscaled.');
    }
    const bitmap = await createImageBitmap(file);
    bitmap.close();
  }

  async function uploadOne(id) {
    const entry = uploadsRef.current[id];
    if (!entry) return;
    patchUpload(id, { state: 'Preparing upload', error: '' });
    try {
      await validatePng(entry.file);
      let token = sessionRef.current;
      if (!token) {
        const created = await call('create');
        token = created.submission;
        sessionRef.current = token;
        setSession(token);
        setJob(created.job);
      }
      patchUpload(id, { state: 'Uploading' });
      const d = await call('upload', entry.file, token, {
        'Content-Type': 'image/png',
        'x-file-name': encodeURIComponent(entry.name)
      });
      const asset = d.job.assets.at(-1);
      patchUpload(id, { state: 'Processing', assetId: asset.id });
      // The server has completed validation and private storage before it responds.
      await Promise.resolve();
      setUrls((current) => ({ ...current, [asset.id]: entry.url }));
      setQuantities((current) => ({ ...current, [asset.id]: current[asset.id] ?? 1 }));
      setSizes((current) => ({ ...current, [asset.id]: { ...defaultDesignSize(asset), lockAspect: true } }));
      setJob(d.job);
      setDirty(true);
      patchUpload(id, { state: 'Ready', assetId: asset.id });
    } catch (e) {
      patchUpload(id, { state: 'Failed', error: e.message || 'Upload failed. Check your connection and retry.' });
    }
  }

  function enqueueUpload(id) {
    uploadQueue.current = uploadQueue.current.then(() => uploadOne(id)).catch(() => undefined);
  }

  function upload(files) {
    if (!files.length) return;
    setError(''); setErrorCode(''); setMessage('Preparing your designs for upload…');
    const entries = files.map((file) => {
      const id = `upload-${++uploadSerial.current}`, url = URL.createObjectURL(file);
      objects.current.push(url);
      return [id, { id, name: file.name, file, url, state: 'Preparing upload', error: '' }];
    });
    uploadsRef.current = { ...uploadsRef.current, ...Object.fromEntries(entries) };
    setUploads((current) => ({ ...current, ...Object.fromEntries(entries) }));
    entries.forEach(([id]) => enqueueUpload(id));
  }

  function retryUpload(id) { setMessage('Retrying upload…'); enqueueUpload(id); }
  function removeLocalUpload(id) { setUploads((current) => { const next = { ...current }; delete next[id]; return next; }); }
  function changeQuantity(id, value) {
    const next = Math.max(1, Math.min(500, Number.parseInt(value, 10) || 1));
    setQuantities((current) => ({ ...current, [id]: next })); setDirty(true);
  }

  const hasUploadsInFlight = Object.values(uploads).some((entry) => activeUploadStates.has(entry.state));
  function designSize(asset) { return sizes[asset.id] || { ...defaultDesignSize(asset), lockAspect: true }; }
  function changeSize(asset, field, value) {
    setSizes(current => {
      const next = { ...(current[asset.id] || { ...defaultDesignSize(asset), lockAspect: true }), [field]: value };
      const aspect = asset.crop.w / asset.crop.h;
      if (field === 'lockAspect' && value && Number(next.widthIn) > 0) next.heightIn = Number((Number(next.widthIn) / aspect).toFixed(6));
      else if (next.lockAspect && field !== 'lockAspect' && Number(value) > 0) {
        next[field === 'widthIn' ? 'heightIn' : 'widthIn'] = Number((field === 'widthIn' ? Number(value) / aspect : Number(value) * aspect).toFixed(6));
      }
      return { ...current, [asset.id]: next };
    });
    setDirty(true);
  }
  const invalidSizes = (job?.assets || []).some(a => !validDesignSize({ widthIn: Number(designSize(a).widthIn), heightIn: Number(designSize(a).heightIn) }));
  const uploadByAsset = Object.values(uploads).reduce((index, entry) => {
    if (entry.assetId) index[entry.assetId] = entry;
    return index;
  }, {});
  const pendingEntries = Object.values(uploads).filter((entry) => !entry.assetId);

  return <main className="client-page">
    <header><strong>Smart Sheet Builder</strong><span>Client Upload Portal</span></header>
    <h1>{shop || 'Client Upload Portal'}</h1>
    <p>Upload your PNG artwork, request sizes and quantities, then review and send your print layout to the shop.</p>
    {error && <p role="alert" className="client-error">{error}</p>}
    {retryPreview && <button type="button" className="secondary" disabled={busy || previewBusy} onClick={generatePreview}>Retry preview</button>}
    {message && <p role="status" className="client-message">{message}</p>}
    {['submission_expired', 'submission_invalid'].includes(errorCode) && <button onClick={() => {
      objects.current.forEach(URL.revokeObjectURL); objects.current = [];
      setJob(null); setSession(''); sessionRef.current = ''; setUrls({}); setUploads({}); setQuantities({}); setSizes({}); setDirty(true); setError(''); setErrorCode('');
    }}>Start a new submission</button>}
    {['portal_configuration_error', 'portal_setup_required'].includes(errorCode) && <button onClick={() => location.reload()}>Retry portal</button>}
    {!shop ? (!error && <p role="status">Checking upload portal…</p>) : job?.confirmed_at ? <section className="client-card">
      <h2>Submission confirmed</h2><p>The shop can now open your locked layout. Your files expire at {new Date(job.expires_at).toLocaleString()}.</p><p>{job.quantity} pieces · {Number(job.meters).toFixed(3)} m</p>
    </section> : <div className="client-columns">
      <section className="client-card">
        <label>Client reference / order name (optional)<input value={reference} maxLength={120} disabled={busy} onChange={(e) => { setReference(e.target.value); setDirty(true); }} /></label>
        <label className="client-drop">Upload designs<input ref={fileInput} type="file" accept="image/png,.png" multiple disabled={busy || !shop} onChange={(e) => { upload(Array.from(e.target.files)); e.target.value = ''; }} /></label>
        <p className="client-muted">Static 8-bit PNG · up to 4 MiB each · 10 files / 32 MiB total · 500 pieces. Unconfirmed uploads expire after 2 hours.</p>
        {[...(job?.assets || []).map((asset) => ({ asset, entry: uploadByAsset[asset.id] })), ...pendingEntries.map((entry) => ({ entry }))].map(({ asset, entry }) => {
          const id = asset?.id || entry.id, name = asset?.name || entry.name, state = entry?.state || 'Ready', ready = Boolean(asset) && state === 'Ready';
          const size = asset ? designSize(asset) : null;
          return <div className="client-file" key={id} data-upload-state={state.toLowerCase().replaceAll(' ', '-')}>
            <div className="client-file-info">
              {/* Browser object URLs preserve the exact uploaded PNG bytes. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="client-file-thumbnail" src={urls[asset?.id] || entry?.url} alt="" decoding="async" />
              <div className="client-file-copy"><span className="client-file-name" title={name}>{name}</span><span className={`client-upload-state ${state === 'Failed' ? 'failed' : ready ? 'ready' : 'active'}`} role="status">{state === 'Failed' ? 'Failed — Retry' : state}</span>{entry?.error && <small className="client-file-error">{entry.error}</small>}</div>
            </div>
            {ready ? <><div className="client-design-controls"><div className="client-size-controls">
              <label>Width (in)<input type="number" min="0.001" max={MAX_REQUESTED_SIZE_IN} step="any" value={size.widthIn} disabled={busy} aria-label={`Width (in) for ${name}`} onChange={e => changeSize(asset, 'widthIn', e.target.value)} /></label>
              <label>Height (in)<input type="number" min="0.001" max={MAX_REQUESTED_SIZE_IN} step="any" value={size.heightIn} disabled={busy} aria-label={`Height (in) for ${name}`} onChange={e => changeSize(asset, 'heightIn', e.target.value)} /></label>
              <label className="client-aspect-lock"><input type="checkbox" checked={size.lockAspect} disabled={busy} aria-label={`Lock aspect ratio for ${name}`} onChange={e => changeSize(asset, 'lockAspect', e.target.checked)} />Lock aspect ratio</label>
            </div><div className="client-quantity" role="group" aria-label={`Quantity for ${name}`}><span>Qty</span><div className="client-stepper"><button type="button" className="secondary" disabled={busy || (quantities[asset.id] ?? 1) <= 1} aria-label={`Decrease quantity for ${name}`} onClick={() => changeQuantity(asset.id, (quantities[asset.id] ?? 1) - 1)}>−</button><input type="number" min="1" max="500" value={quantities[asset.id] ?? 1} disabled={busy} aria-label={`Quantity for ${name}`} onChange={(e) => changeQuantity(asset.id, e.target.value)} /><button type="button" className="secondary" disabled={busy || (quantities[asset.id] ?? 1) >= 500} aria-label={`Increase quantity for ${name}`} onClick={() => changeQuantity(asset.id, (quantities[asset.id] ?? 1) + 1)}>+</button></div></div></div><button type="button" className="client-file-remove secondary" disabled={busy} aria-label={`Remove ${name}`} onClick={() => run(async () => { const d = await call('remove', { id: asset.id }); setJob(d.job); setDirty(true); setUploads((current) => Object.fromEntries(Object.entries(current).filter(([, item]) => item.assetId !== asset.id))); })}>×</button></> : state === 'Failed' ? <div className="client-file-actions"><button type="button" className="secondary" disabled={busy} onClick={() => retryUpload(entry.id)}>Retry</button><button type="button" className="client-file-remove secondary" disabled={busy} aria-label={`Remove ${name}`} onClick={() => removeLocalUpload(entry.id)}>×</button></div> : <span className="client-upload-indicator" aria-label={`${name}: ${state}`} />}
          </div>;
        })}
        {invalidSizes && <p role="alert" className="client-error">Enter a positive width and height up to 120 inches for each design.</p>}
        {(job?.assets.length > 0 || pendingEntries.length > 0) && <div className="client-upload-actions"><button type="button" className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>Add more design</button><button disabled={busy || previewBusy || hasUploadsInFlight || invalidSizes || !(job?.assets.length)} onClick={generatePreview}>{hasUploadsInFlight ? 'Waiting for uploads…' : operation === 'preview' || previewBusy ? 'Preparing print layout…' : 'Generate Print Preview'}</button></div>}
      </section>
      <section className="client-card client-preview-card" aria-busy={busy || previewBusy}>
        <h2>Print layout estimate</h2><p>This preview is read-only. The shop’s printing preset determines the layout.</p>{operation === 'preview' && <PrintLayoutLoading stage="Calculating print layout…" />}{busy && operation !== 'preview' && <div className="client-preview-skeleton" role="status">{operation === 'confirm' ? 'Sending your submission…' : 'Updating designs…'}</div>}
        {job?.manifest && !dirty && operation !== 'preview' ? <><p><strong>{job.quantity} pieces · {Number(job.meters).toFixed(3)} m</strong></p><ClientJobPreview manifest={job.manifest} assets={job.assets} urls={urls} onBusyChange={setPreviewBusy} onReadyChange={setPreviewReady} /><button disabled={busy || !previewReady || hasUploadsInFlight} onClick={() => run(async () => { const d = await call('confirm', { revision: job.revision }); setJob(d.job); setMessage(d.message); }, 'confirm')}>{busy ? 'Submitting…' : 'Confirm & Send to Shop'}</button></> : operation !== 'preview' && <p>{hasUploadsInFlight ? 'Your files are being prepared. Preview will be available when they are ready.' : 'Generate a preview after uploading or changing sizes or quantities.'}</p>}
      </section>
    </div>}
  </main>;
}
