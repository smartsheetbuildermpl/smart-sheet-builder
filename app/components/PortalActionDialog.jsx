'use client';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function PortalActionDialog({ title, busy = false, onClose, origin, wide = false, children }) {
  const ref = useRef(null), titleId = useId();
  useEffect(() => {
    const element = ref.current, returnTo = origin || document.activeElement;
    element.showModal();
    // Native modal focus trapping also keeps the underlying portal inert.
    element.querySelector('[data-initial-focus]')?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, [origin]);
  return createPortal(<dialog ref={ref} className={`client-jobs-dialog client-action-dialog${wide ? ' client-profile-editor' : ''}`}
    aria-labelledby={titleId} aria-busy={busy}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" className="secondary" aria-label={`Close ${title}`} disabled={busy} onClick={onClose}>×</button></header>
    <div className="client-action-body">{children}</div>
  </dialog>, document.body);
}
