'use client';
import { useEffect, useRef, useState } from 'react';

export function CreditCountdown({ usage, onDue, exhausted = false }) {
  const [seconds, setSeconds] = useState(null);
  const callback = useRef(onDue); callback.current = onDue;
  useEffect(() => {
    if (!usage.nextCreditAt || !usage.serverTime) { setSeconds(null); return; }
    const duration = Math.max(0, Date.parse(usage.nextCreditAt) - Date.parse(usage.serverTime));
    const start = performance.now(); let refreshed = false;
    const tick = () => {
      const left = Math.max(0, Math.ceil((duration - (performance.now() - start)) / 1000));
      setSeconds(left);
      if (!left && !refreshed) { refreshed = true; callback.current?.(); }
    };
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [usage.nextCreditAt, usage.serverTime]);
  if (usage.remaining >= 2) return null;
  const time = seconds === null ? 'Checking server…' : seconds === 0 ? 'Checking for your next credit…' : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`;
  return <small>{exhausted ? 'Your next free export credit arrives in ' : 'Next free credit in '}{time}</small>;
}

export default function ExportCredits({ usage, onDue, onWait, compact = false }) {
  if (!usage.creditMode) return null;
  return <div className="export-credits">
    {!compact && <strong>Free Export Credits: {usage.remaining} / 2</strong>}
    {onWait && usage.remaining === 0 && <p>You’ve used your available free export credits.</p>}
    <CreditCountdown usage={usage} onDue={onDue} exhausted={Boolean(onWait && usage.remaining === 0)} />
    {!compact && <p>One free export credit refreshes every 3 hours, up to 2 saved credits.</p>}
    {onWait && usage.remaining === 0 && <button type="button" onClick={onWait}>Wait for free credit</button>}
    <button type="button" className="credits-coming-soon" disabled title="Purchasing export credits is not available yet.">Buy Export Credits — Coming Soon</button>
  </div>;
}

export function CreditHistory({ token }) {
  const [page, setPage] = useState(0), [data, setData] = useState(null), [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError('');
    fetch(`/api/export/credits?offset=${page * 30}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: controller.signal })
      .then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.message); if (!controller.signal.aborted) setData(d); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [token, page]);
  return <section aria-label="Credit history"><h3>Credit history</h3>{error ? <p role="alert">{error}</p> : !data ? <p>Loading history…</p> : <>
    <CreditEvents events={data.history || []} />
    <button disabled={!page} onClick={() => setPage(n => n - 1)}>Newer credits</button><button disabled={(data.history || []).length < 30} onClick={() => setPage(n => n + 1)}>Older credits</button>
  </>}</section>;
}
export function CreditEvents({ events }) {
  const labels = { free_refill: 'Free credit refill', export_consumed: 'Export credit used', export_refunded: 'Credit returned after save failure', admin_adjustment: 'Admin adjustment', purchased_credit: 'Purchased credit' };
  return events.length ? <ol className="user-history">{events.map(e => <li key={e.id}><strong>{labels[e.reason] || e.reason}: {e.delta > 0 ? '+' : ''}{e.delta}</strong><small>{new Date(e.created_at).toLocaleString()}{e.metadata?.format && ` · ${e.metadata.format.toUpperCase()}`}{e.metadata?.source === 'initial_balance' && ' · Initial free balance'}</small></li>)}</ol> : <p>No credit activity recorded yet.</p>;
}
