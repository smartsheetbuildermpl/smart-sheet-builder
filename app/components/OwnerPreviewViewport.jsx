'use client';
import { useEffect, useRef, useState } from 'react';

// Display transforms only. The child remains the existing bounded preview
// bitmap; these dimensions/scroll offsets never enter a manifest or export.
export default function OwnerPreviewViewport({ width, height, children }) {
  const viewport = useRef(null), gesture = useRef(null);
  const [zoom, setZoom] = useState('fit'), [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const node = viewport.current;
    const observer = new ResizeObserver(() => setSize({ width: node.clientWidth, height: node.clientHeight }));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setZoom('fit');
    viewport.current.scrollTo(0, 0);
    gesture.current = null;
  }, [width, height]);
  const fit = Math.max(0.001, Math.min(1, (size.width - 24) / width, (size.height - 24) / height));
  const scale = zoom === 'fit' ? fit : Number(zoom);
  return <div className="owner-preview-viewport">
    <div className="owner-preview-toolbar">
      <span>Preview <small>Display zoom</small></span>
      <div role="group" aria-label="Preview zoom">
        {[['fit', 'Fit'], ['1', '100%'], ['2', '200%']].map(([value, label]) => <button type="button" className="secondary" key={value} aria-pressed={zoom === value} onClick={() => { setZoom(value); viewport.current.scrollTo(0, 0); }}>{label}</button>)}
      </div>
    </div>
    <div ref={viewport} className="owner-preview-stage" role="region" aria-label="Print layout preview stage" tabIndex={0} data-zoom={zoom}
      onPointerDown={e => {
        if (zoom === 'fit' || e.button !== 0 || e.pointerType === 'touch' || e.target.closest('button,select,a')) return;
        gesture.current = { x: e.clientX, y: e.clientY, left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop };
        e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault();
      }}
      onPointerMove={e => { const g = gesture.current; if (g) { e.currentTarget.scrollLeft = g.left + g.x - e.clientX; e.currentTarget.scrollTop = g.top + g.y - e.clientY; } }}
      onPointerUp={() => { gesture.current = null; }} onPointerCancel={() => { gesture.current = null; }} onLostPointerCapture={() => { gesture.current = null; }}>
      <div className="owner-preview-plane" style={{ width: Math.max(size.width, width * scale + 24), height: Math.max(size.height, height * scale + 24) }}>
        <div className="owner-preview-display" style={{ width: width * scale, height: height * scale }}>{children}</div>
      </div>
    </div>
    <small className="owner-preview-hint">{zoom === 'fit' ? 'Complete layout · read-only preview' : 'Scroll or drag to pan · display pixels only'}</small>
  </div>;
}
