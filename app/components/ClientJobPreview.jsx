'use client';
import { useEffect, useRef, useState } from 'react';
import PrintLayoutLoading from './PrintLayoutLoading';
export default function ClientJobPreview({ manifest, assets, urls, onBusyChange, onReadyChange }) {
  const box = useRef(null),
    [error, setError] = useState(''),
    [stage, setStage] = useState('Preparing artwork…'),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const images = [];
    setError('');
    setStage('Preparing artwork…');
    onBusyChange?.(true);
    onReadyChange?.(false);
    box.current.replaceChildren();
    (async () => {
      const sources = {};
      for (const a of assets.filter((a) =>
        manifest.sheets.some((s) =>
          s.placements.some((p) => p.assetId === a.id)
        )
      )) {
        if (!urls[a.id])
          throw Error('An original image is unavailable. Reopen this job.');
        const img = new Image();
        img.src = urls[a.id];
        await img.decode();
        sources[a.id] = img;
        images.push(img);
        if (cancelled) return;
      }
      setStage('Creating your preview…');
      // Yield a frame before painting so loading feedback can reach the screen.
      await new Promise(resolve => requestAnimationFrame(resolve));
      for (const [i, s] of manifest.sheets.entries()) {
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
          const a = assets.find((a) => a.id === p.assetId),
            c = a.crop;
          ctx.save();
          ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
          ctx.rotate((p.rotation * Math.PI) / 180);
          ctx.drawImage(
            sources[a.id],
            c.x,
            c.y,
            c.w,
            c.h,
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
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      images.forEach((img) => {
        img.src = '';
      });
      images.length = 0;
      if (!cancelled) { setStage(''); onBusyChange?.(false); onReadyChange?.(true); }
    })().catch((e) => {
      if (!cancelled) { setError(e.message); setStage(''); onBusyChange?.(false); onReadyChange?.(false); box.current.replaceChildren(); }
    });
    return () => {
      cancelled = true;
      onBusyChange?.(false);
      onReadyChange?.(false);
      images.forEach((img) => {
        img.src = '';
      });
    };
  }, [manifest, assets, urls, attempt, onBusyChange, onReadyChange]);
  return (
    <>
      {stage && <PrintLayoutLoading stage={stage} />}
      <div className="client-preview" ref={box} hidden={Boolean(stage || error)} aria-busy={Boolean(stage)} />
      {error && <div className="client-error" role="alert">We couldn’t create the print preview. {error} <button type="button" className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry preview</button></div>}
    </>
  );
}
