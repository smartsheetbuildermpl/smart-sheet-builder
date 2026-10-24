'use client';
import { useEffect, useRef, useState } from 'react';
import PrintLayoutLoading from './PrintLayoutLoading';
import { METER_LENGTH_IN } from '../lib/client-roll-layout';
import OwnerPreviewViewport from './OwnerPreviewViewport';
export default function ClientJobPreview({ manifest, assets, urls, onBusyChange, onReadyChange, ownerWorkspace = false }) {
  const box = useRef(null),
    [error, setError] = useState(''),
    [stage, setStage] = useState('Preparing artwork…'),
    [sheetIndex, setSheetIndex] = useState(0),
    [attempt, setAttempt] = useState(0),
    [rollView, setRollView] = useState(0);
  const selectedSheet = Math.min(sheetIndex, manifest.sheets.length - 1);
  const roll = manifest.mediaMode === 'continuous' ? manifest.roll : null;
  // At most two meters per display window. This never slices the manifest or
  // original artwork; exports still receive the one continuous locked roll.
  const windowLengthIn = 2 * METER_LENGTH_IN;
  const viewCount = roll && !ownerWorkspace ? Math.ceil(roll.lengthIn / windowLengthIn) : 1;
  const selectedView = Math.min(rollView, viewCount - 1);
  useEffect(() => {
    let cancelled = false;
    const images = [];
    const controller = new AbortController();
    const timer = setTimeout(() => {
      cancelled = true; controller.abort();
      images.forEach(image => image.close());
      setError('Preparing this preview took too long. Your designs are preserved; retry the preview.');
      setStage(''); onBusyChange?.(false); onReadyChange?.(false);
    }, 60000);
    setError('');
    setStage('Preparing artwork…');
    onBusyChange?.(true);
    onReadyChange?.(false);
    box.current.replaceChildren();
    (async () => {
      const sheet = manifest.sheets[selectedSheet];
      const startY = roll && !ownerWorkspace ? selectedView * windowLengthIn * manifest.dpi : 0;
      const viewHeight = roll && !ownerWorkspace ? Math.min(sheet.heightPx - startY, windowLengthIn * manifest.dpi) : sheet.heightPx;
      const visiblePlacements = sheet.placements.filter(p => p.y < startY + viewHeight && p.y + p.h > startY);
      const sources = {};
      for (const a of assets.filter((a) =>
        visiblePlacements.some((p) => p.assetId === a.id)
      )) {
        if (!urls[a.id])
          throw Error('An original image is unavailable. Reopen this job.');
        const response = await fetch(urls[a.id], { signal: controller.signal });
        if (!response.ok) throw Error('An original image could not be loaded. Retry the preview.');
        const blob = await response.blob(), c = a.crop;
        const scale = Math.min(1, 1600 / Math.max(c.w, c.h));
        // This crop/proxy is display-only. Original blobs, manifests and the
        // owner's full-resolution export sources are never rewritten.
        const img = await createImageBitmap(blob, c.x, c.y, c.w, c.h, {
          resizeWidth: Math.max(1, Math.round(c.w * scale)),
          resizeHeight: Math.max(1, Math.round(c.h * scale)), resizeQuality: 'high'
        });
        if (cancelled) { img.close(); return; }
        sources[a.id] = img;
        images.push(img);
        if (cancelled) return;
      }
      setStage('Creating your preview…');
      // Yield a frame before painting so loading feedback can reach the screen.
      await new Promise(resolve => setTimeout(resolve, 0));
      // Render one sheet at a time so a large job cannot retain hundreds of
      // preview canvases. All geometry still comes from the locked manifest.
      for (const [i, s] of [[selectedSheet, manifest.sheets[selectedSheet]]]) {
        if (cancelled) return;
        const canvas = document.createElement('canvas'),
          scale = Math.min(1, 1000 / s.widthPx, 1600 / viewHeight);
        canvas.width = Math.max(1, Math.round(s.widthPx * scale));
        canvas.height = Math.max(1, Math.round(viewHeight * scale));
        canvas.setAttribute(
          'aria-label',
          roll ? `Read-only continuous roll preview, view ${selectedView + 1}` : `Read-only print preview, Sheet ${i + 1}`
        );
        canvas.setAttribute('role', 'img');
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.translate(0, -startY);
        ctx.imageSmoothingQuality = 'high';
        for (const p of visiblePlacements) {
          const a = assets.find((a) => a.id === p.assetId);
          ctx.save();
          ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
          ctx.rotate((p.rotation * Math.PI) / 180);
          ctx.drawImage(
            sources[a.id],
            0,
            0,
            sources[a.id].width,
            sources[a.id].height,
            -p.baseW / 2,
            -p.baseH / 2,
            p.baseW,
            p.baseH
          );
          ctx.restore();
        }
        const label = document.createElement('p');
        label.textContent = roll ? `Continuous roll · view ${(startY / manifest.dpi).toFixed(2)}–${((startY + viewHeight) / manifest.dpi).toFixed(2)} in (display window only)` : `Sheet ${i + 1} · ${s.widthIn.toFixed(2)} × ${s.heightIn.toFixed(2)} in`;
        if (roll) {
          const frame = document.createElement('div');
          frame.className = 'client-roll-window';
          frame.append(canvas);
          const meterPx = METER_LENGTH_IN * manifest.dpi;
          for (let meter = Math.max(1, Math.ceil(startY / meterPx)); meter * meterPx <= startY + viewHeight; meter++) {
            const marker = document.createElement('div');
            marker.className = 'client-meter-marker';
            marker.style.top = `${(meter * meterPx - startY) / viewHeight * 100}%`;
            const text = document.createElement('span');
            text.textContent = `Meter ${meter}`;
            marker.append(text); frame.append(marker);
          }
          box.current.append(label, frame);
        } else box.current.append(label, canvas);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      images.forEach((img) => {
        img.close();
      });
      images.length = 0;
      clearTimeout(timer);
      if (!cancelled) { setStage(''); onBusyChange?.(false); onReadyChange?.(true); }
    })().catch((e) => {
      clearTimeout(timer); images.forEach(image => image.close());
      if (!cancelled) { setError(e.message); setStage(''); onBusyChange?.(false); onReadyChange?.(false); box.current.replaceChildren(); }
    });
    return () => {
      cancelled = true;
      clearTimeout(timer); controller.abort();
      onBusyChange?.(false);
      onReadyChange?.(false);
      images.forEach((img) => {
        img.close();
      });
    };
  }, [manifest, assets, urls, attempt, selectedSheet, selectedView, roll, windowLengthIn, onBusyChange, onReadyChange, ownerWorkspace]);
  if (ownerWorkspace) {
    const s = manifest.sheets[selectedSheet], scale = Math.min(1, 1000 / s.widthPx, 1600 / s.heightPx);
    return <div className="owner-preview-workspace">
      <section className="owner-layout-summary" aria-label={roll ? 'Roll usage estimate' : 'Sheet summary'}>
        {roll ? <><strong>Roll job · {roll.meters.toFixed(6)} m</strong><span>{roll.widthIn.toFixed(2)} × {roll.lengthIn.toFixed(2)} in · {roll.efficiency.toFixed(1)}% efficiency</span><small>{roll.fullMeters} full {roll.fullMeters === 1 ? 'meter' : 'meters'} + {roll.nextMeterPercent.toFixed(3)}% of the next meter. Meter lines are informational only.</small></>
          : <><strong>Sheet {selectedSheet + 1} of {manifest.sheets.length}</strong><span>{s.widthIn.toFixed(2)} × {s.heightIn.toFixed(2)} in</span></>}
        {manifest.sheets.length > 1 && <label>Preview sheet<select aria-label="Preview sheet" value={selectedSheet} onChange={e => setSheetIndex(Number(e.target.value))}>{manifest.sheets.map((_, i) => <option key={i} value={i}>Sheet {i + 1} of {manifest.sheets.length}</option>)}</select></label>}
      </section>
      <OwnerPreviewViewport key={`${selectedSheet}:${manifest.mediaMode}:${s.widthPx}:${s.heightPx}`} width={Math.max(1, Math.round(s.widthPx * scale))} height={Math.max(1, Math.round(s.heightPx * scale))}>
        <div className="client-preview" ref={box} hidden={Boolean(stage || error)} aria-busy={Boolean(stage)} />
      </OwnerPreviewViewport>
      {stage && <div className="owner-preview-feedback"><PrintLayoutLoading stage={stage} /></div>}
      {error && <div className="client-error owner-preview-feedback" role="alert">We couldn’t create the print preview. {error} <button type="button" className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>}
    </div>;
  }
  return (
    <>
      {roll && <section className="client-roll-summary" aria-label="Roll usage estimate">
        <p><strong>Estimated roll usage: {roll.meters.toFixed(6)} m</strong></p>
        <p>{roll.fullMeters} full {roll.fullMeters === 1 ? 'meter' : 'meters'} + {roll.nextMeterPercent.toFixed(3)}% of the next meter ({roll.nextMeterLengthIn.toFixed(4)} in).</p>
        <p>{roll.widthIn.toFixed(4)} in printable roll width · {roll.usableWidthIn.toFixed(4)} in usable artwork width · {roll.lengthIn.toFixed(4)} in actual used length · {roll.efficiency.toFixed(1)}% layout efficiency.</p>
        <small>Actual physical usage only. Meter lines do not split artwork or add margins.</small>
      </section>}
      {roll && viewCount > 1 && <label>Roll preview view<select aria-label="Roll preview view" value={selectedView} onChange={e => setRollView(Number(e.target.value))}>{Array.from({ length: viewCount }, (_, i) => <option key={i} value={i}>View {i + 1} · {(i * 2).toFixed(0)}–{Math.min((i + 1) * 2, roll.meters).toFixed(3)} m</option>)}</select></label>}
      {manifest.sheets.length > 1 && <label>Preview sheet<select aria-label="Preview sheet" value={selectedSheet} onChange={e => setSheetIndex(Number(e.target.value))}>{manifest.sheets.map((_, i) => <option key={i} value={i}>Sheet {i + 1} of {manifest.sheets.length}</option>)}</select></label>}
      {stage && <PrintLayoutLoading stage={stage} />}
      <div className="client-preview" ref={box} hidden={Boolean(stage || error)} aria-busy={Boolean(stage)} />
      {error && <div className="client-error" role="alert">We couldn’t create the print preview. {error} <button type="button" className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>}
    </>
  );
}
