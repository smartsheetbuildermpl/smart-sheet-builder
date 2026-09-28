'use client';
import { useEffect, useRef, useState } from 'react';
import ClientJobPreview from '../../components/ClientJobPreview';

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
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [errorCode, setErrorCode] = useState(''),
    [message, setMessage] = useState(''),
    [dirty, setDirty] = useState(true);
  const objects = useRef([]),
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
      body: body instanceof File ? body : JSON.stringify(body || {})
    });
    const d = await r.json().catch(() => ({ code: 'portal_configuration_error', message: 'The upload portal could not be reached. Please retry later.' }));
    if (!r.ok) throw Object.assign(Error(d.message), { code: d.code });
    return d;
  }

  async function run(fn) {
    setBusy(true); setError(''); setErrorCode(''); setMessage('');
    try { await fn(); }
    catch (e) { setError(e.message); setErrorCode(e.code || 'portal_request_failed'); }
    finally { setBusy(false); }
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
  const uploadByAsset = Object.values(uploads).reduce((index, entry) => {
    if (entry.assetId) index[entry.assetId] = entry;
    return index;
  }, {});
  const pendingEntries = Object.values(uploads).filter((entry) => !entry.assetId);

  return <main className="client-page">
    <header><strong>Smart Sheet Builder</strong><span>Client Upload Portal</span></header>
    <h1>{shop || 'Client Upload Portal'}</h1>
    <p>Upload your PNG artwork, set quantities, then review and send your print layout to the shop.</p>
    {error && <p role="alert" className="client-error">{error}</p>}
    {message && <p role="status" className="client-message">{message}</p>}
    {['submission_expired', 'submission_invalid'].includes(errorCode) && <button onClick={() => {
      objects.current.forEach(URL.revokeObjectURL); objects.current = [];
      setJob(null); setSession(''); sessionRef.current = ''; setUrls({}); setUploads({}); setQuantities({}); setDirty(true); setError(''); setErrorCode('');
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
          return <div className="client-file" key={id} data-upload-state={state.toLowerCase().replaceAll(' ', '-')}>
            <div className="client-file-info">
              {/* Browser object URLs preserve the exact uploaded PNG bytes. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="client-file-thumbnail" src={urls[asset?.id] || entry?.url} alt="" decoding="async" />
              <div className="client-file-copy"><span className="client-file-name" title={name}>{name}</span><span className={`client-upload-state ${state === 'Failed' ? 'failed' : ready ? 'ready' : 'active'}`} role="status">{state === 'Failed' ? 'Failed — Retry' : state}</span>{entry?.error && <small className="client-file-error">{entry.error}</small>}</div>
            </div>
            {ready ? <><div className="client-quantity" role="group" aria-label={`Quantity for ${name}`}><span>Qty</span><div className="client-stepper"><button type="button" className="secondary" disabled={busy || (quantities[asset.id] ?? 1) <= 1} aria-label={`Decrease quantity for ${name}`} onClick={() => changeQuantity(asset.id, (quantities[asset.id] ?? 1) - 1)}>−</button><input type="number" min="1" max="500" value={quantities[asset.id] ?? 1} disabled={busy} aria-label={`Quantity for ${name}`} onChange={(e) => changeQuantity(asset.id, e.target.value)} /><button type="button" className="secondary" disabled={busy || (quantities[asset.id] ?? 1) >= 500} aria-label={`Increase quantity for ${name}`} onClick={() => changeQuantity(asset.id, (quantities[asset.id] ?? 1) + 1)}>+</button></div></div><button type="button" className="client-file-remove secondary" disabled={busy} aria-label={`Remove ${name}`} onClick={() => run(async () => { const d = await call('remove', { id: asset.id }); setJob(d.job); setDirty(true); setUploads((current) => Object.fromEntries(Object.entries(current).filter(([, item]) => item.assetId !== asset.id))); })}>×</button></> : state === 'Failed' ? <div className="client-file-actions"><button type="button" className="secondary" disabled={busy} onClick={() => retryUpload(entry.id)}>Retry</button><button type="button" className="client-file-remove secondary" disabled={busy} aria-label={`Remove ${name}`} onClick={() => removeLocalUpload(entry.id)}>×</button></div> : <span className="client-upload-indicator" aria-label={`${name}: ${state}`} />}
          </div>;
        })}
        {(job?.assets.length > 0 || pendingEntries.length > 0) && <div className="client-upload-actions"><button type="button" className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>Add more design</button><button disabled={busy || hasUploadsInFlight || !(job?.assets.length)} onClick={() => run(async () => { const d = await call('preview', { reference, quantities: job.assets.map((asset) => ({ id: asset.id, qty: quantities[asset.id] ?? 1 })) }); setJob(d.job); setDirty(false); })}>{hasUploadsInFlight ? 'Waiting for uploads…' : busy ? 'Generating preview…' : 'Generate Print Preview'}</button></div>}
      </section>
      <section className="client-card client-preview-card" aria-busy={busy}>
        <h2>Print layout estimate</h2><p>This preview is read-only. The shop’s printing preset determines the layout.</p>{busy && <div className="client-preview-skeleton" role="status">Preparing your print layout…</div>}
        {job?.manifest && !dirty ? <><p><strong>{job.quantity} pieces · {Number(job.meters).toFixed(3)} m</strong></p><ClientJobPreview manifest={job.manifest} assets={job.assets} urls={urls} /><button disabled={busy || hasUploadsInFlight} onClick={() => run(async () => { const d = await call('confirm', { revision: job.revision }); setJob(d.job); setMessage(d.message); })}>{busy ? 'Submitting…' : 'Confirm & Send to Shop'}</button></> : <p>{hasUploadsInFlight ? 'Your files are being prepared. Preview will be available when they are ready.' : 'Generate a preview after uploading or changing quantities.'}</p>}
      </section>
    </div>}
  </main>;
}
