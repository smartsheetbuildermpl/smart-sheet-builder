'use client';
import { useEffect, useRef, useState } from 'react';
import PrintLayoutLoading from './PrintLayoutLoading';
export default function ClientJobPreview({ manifest, assets, urls, onBusyChange, onReadyChange }) {
  const box = useRef(null),
    [error, setError] = useState(''),
    [stage, setStage] = useState('Preparing artwork…'),
    [sheetIndex, setSheetIndex] = useState(0),
    [attempt, setAttempt] = useState(0);
  const selectedSheet = Math.min(sheetIndex, manifest.sheets.length - 1);
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
      const sources = {};
      for (const a of assets.filter((a) =>
        manifest.sheets[selectedSheet].placements.some((p) => p.assetId === a.id)
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
          scale = Math.min(1, 1000 / s.widthPx, 1600 / s.heightPx);
        canvas.width = Math.round(s.widthPx * scale);
        canvas.height = Math.round(s.heightPx * scale);
        canvas.setAttribute(
          'aria-label',
          `Read-only print preview, Sheet ${i + 1}`
        );
        canvas.setAttribute('role', 'img');
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.imageSmoothingQuality = 'high';
        for (const p of s.placements) {
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
        label.textContent = `Sheet ${i + 1} · ${s.widthIn.toFixed(2)} × ${s.heightIn.toFixed(2)} in`;
        box.current.append(label, canvas);
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
  }, [manifest, assets, urls, attempt, selectedSheet, onBusyChange, onReadyChange]);
  return (
    <>
      {manifest.sheets.length > 1 && <label>Preview sheet<select aria-label="Preview sheet" value={selectedSheet} onChange={e => setSheetIndex(Number(e.target.value))}>{manifest.sheets.map((_, i) => <option key={i} value={i}>Sheet {i + 1} of {manifest.sheets.length}</option>)}</select></label>}
      {stage && <PrintLayoutLoading stage={stage} />}
      <div className="client-preview" ref={box} hidden={Boolean(stage || error)} aria-busy={Boolean(stage)} />
      {error && <div className="client-error" role="alert">We couldn’t create the print preview. {error} <button type="button" className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>}
    </>
  );
}
