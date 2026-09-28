'use client';
import { useEffect, useRef, useState } from 'react';
import ClientJobPreview from '../../components/ClientJobPreview';
export default function ClientUpload({ params }) {
  const [shop, setShop] = useState(''),
    [job, setJob] = useState(null),
    [session, setSession] = useState(''),
    [urls, setUrls] = useState({}),
    [reference, setReference] = useState(''),
    [quantities, setQuantities] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [errorCode, setErrorCode] = useState(''),
    [message, setMessage] = useState(''),
    [dirty, setDirty] = useState(true);
  const objects = useRef([]),
    base = `/api/client-upload/${params.token}`;
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
  async function call(action, body, token = session, headers = {}) {
    const r = await fetch(`${base}?action=${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-submission': token,
        ...headers
      },
      body: body instanceof File ? body : JSON.stringify(body || {})
    });
    const d = await r.json().catch(() => ({ code: 'portal_configuration_error', message: 'The upload portal could not be reached. Please retry later.' }));
    if (!r.ok) throw Object.assign(Error(d.message), { code: d.code });
    return d;
  }
  async function run(fn) {
    setBusy(true);
    setError('');
    setErrorCode('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
      setErrorCode(e.code || 'portal_request_failed');
    } finally {
      setBusy(false);
    }
  }
  function upload(files) {
    run(async () => {
      let token = session;
      if (!token) {
        const d = await call('create');
        token = d.submission;
        setSession(token);
        setJob(d.job);
      }
      setDirty(true);
      for (const file of files) {
        if (!/\.png$/i.test(file.name) || file.size > 4194304)
          throw Error('Choose PNG files up to 4 MiB each.');
        const sig = new Uint8Array(await file.slice(0, 33).arrayBuffer());
        if (
          sig.length < 33 ||
          ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => sig[i] === b)
        )
          throw Error('This file is not a PNG.');
        const header = new DataView(sig.buffer),
          w = header.getUint32(16),
          h = header.getUint32(20);
        if (
          !w ||
          !h ||
          w > 8192 ||
          h > 8192 ||
          w * h > 16777216 ||
          sig[24] !== 8
        )
          throw Error(
            'Use an 8-bit PNG up to 16 megapixels and 8192 pixels per side. The source will not be downscaled.'
          );
        const bitmap = await createImageBitmap(file);
        bitmap.close();
        const d = await call('upload', file, token, {
            'Content-Type': 'image/png',
            'x-file-name': encodeURIComponent(file.name)
          }),
          a = d.job.assets.at(-1),
          url = URL.createObjectURL(file);
        objects.current.push(url);
        setUrls((old) => ({ ...old, [a.id]: url }));
        setQuantities((old) => ({ ...old, [a.id]: 1 }));
        setJob(d.job);
      }
    });
  }
  return (
    <main className="client-page">
      <header>
        <strong>Smart Sheet Builder</strong>
        <span>Client Upload Portal</span>
      </header>
      <h1>{shop || 'Client Upload Portal'}</h1>
      <p>
        Upload your PNG artwork, set quantities, then review and send your print
        layout to the shop.
      </p>
      {error && (
        <p role="alert" className="client-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {['submission_expired', 'submission_invalid'].includes(errorCode) && <button onClick={() => {
        objects.current.forEach(URL.revokeObjectURL); objects.current = [];
        setJob(null); setSession(''); setUrls({}); setQuantities({}); setDirty(true); setError(''); setErrorCode('');
      }}>Start a new submission</button>}
      {['portal_configuration_error', 'portal_setup_required'].includes(errorCode) && <button onClick={() => location.reload()}>Retry portal</button>}
      {!shop ? (!error && <p role="status">Checking upload portal…</p>) : job?.confirmed_at ? (
        <section className="client-card">
          <h2>Submission confirmed</h2>
          <p>
            The shop can now open your locked layout. Your files expire at{' '}
            {new Date(job.expires_at).toLocaleString()}.
          </p>
          <p>
            {job.quantity} pieces · {Number(job.meters).toFixed(3)} m
          </p>
        </section>
      ) : (
        <div className="client-columns">
          <section className="client-card">
            <label>
              Client reference / order name (optional)
              <input
                value={reference}
                maxLength={120}
                disabled={busy}
                onChange={(e) => {
                  setReference(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <label className="client-drop">
              Upload designs
              <input
                type="file"
                accept="image/png,.png"
                multiple
                disabled={busy || !shop}
                onChange={(e) => {
                  upload(Array.from(e.target.files));
                  e.target.value = '';
                }}
              />
            </label>
            <p className="client-muted">
              Static 8-bit PNG · up to 4 MiB each · 10 files / 32 MiB total ·
              500 pieces. Unconfirmed uploads expire after 2 hours.
            </p>
            {job?.assets.map((a) => (
              <div className="client-file" key={a.id}>
                <span>{a.name}</span>
                <label>
                  Quantity
                  <input
                    type="number"
                    min="1"
                    max="500"
                    value={quantities[a.id] ?? 1}
                    disabled={busy}
                    onChange={(e) => {
                      setQuantities((q) => ({
                        ...q,
                        [a.id]: Number(e.target.value)
                      }));
                      setDirty(true);
                    }}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    run(async () => {
                      const d = await call('remove', { id: a.id });
                      setJob(d.job);
                      setDirty(true);
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              disabled={busy || !job?.assets.length}
              onClick={() =>
                run(async () => {
                  const d = await call('preview', {
                    reference,
                    quantities: job.assets.map((a) => ({
                      id: a.id,
                      qty: quantities[a.id] ?? 1
                    }))
                  });
                  setJob(d.job);
                  setDirty(false);
                })
              }
            >
              {busy ? 'Processing…' : 'Generate Print Preview'}
            </button>
          </section>
          <section className="client-card">
            <h2>Print layout estimate</h2>
            <p>
              This preview is read-only. The shop’s printing preset determines
              the layout.
            </p>
            {job?.manifest && !dirty ? (
              <>
                <p>
                  <strong>
                    {job.quantity} pieces · {Number(job.meters).toFixed(3)} m
                  </strong>
                </p>
                <ClientJobPreview
                  manifest={job.manifest}
                  assets={job.assets}
                  urls={urls}
                />
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const d = await call('confirm', {
                        revision: job.revision
                      });
                      setJob(d.job);
                      setMessage(d.message);
                    })
                  }
                >
                  Confirm &amp; Send to Shop
                </button>
              </>
            ) : (
              <p>Generate a preview after uploading or changing quantities.</p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
