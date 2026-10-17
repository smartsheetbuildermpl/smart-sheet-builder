'use client';
import { useEffect, useState } from 'react';

export default function PrintLayoutLoading({ stage = 'Preparing artwork…' }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 15000);
    return () => clearTimeout(timer);
  }, []);
  return <div className="client-layout-loading" role="status" aria-live="polite" aria-atomic="true" aria-busy="true">
    <div className="client-layout-animation" aria-hidden="true"><span className="client-layout-page"><i /><i /><i /></span><span className="client-layout-scan" /></div>
    <div><strong>Preparing your print layout</strong><p>{slow ? 'Still preparing your layout — larger artwork can take longer.' : stage}</p><small>This may take a moment for larger artwork. Please keep this page open.</small></div>
  </div>;
}
