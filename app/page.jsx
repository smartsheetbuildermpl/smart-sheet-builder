'use client';

import { useEffect, useRef, useState } from 'react';
import DesignLibraryDialog from './components/DesignLibraryDialog';
import useSmartSheetAuth from './hooks/useSmartSheetAuth';
import RegistrationFields, { emptyRegistration } from './components/RegistrationFields';
import UsersDialog from './components/UsersDialog';
import AccountProfile from './components/AccountProfile';
import PasswordRequestForm from './components/PasswordRequestForm';
import ChangePassword from './components/ChangePassword';
import ExportCredits, { CreditHistory, CreditCountdown } from './components/ExportCredits';

export default function HomePage() {
  const auth = useSmartSheetAuth();
  const { usage, busy } = auth;
  const authRef = useRef(auth);
  authRef.current = auth;
  const [authMode, setAuthMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [registration, setRegistration] = useState(emptyRegistration);
  const [usersOpen, setUsersOpen] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [exportBlock, setExportBlock] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [backgroundEditorOpen, setBackgroundEditorOpen] = useState(false);
  const [accessBarOpen, setAccessBarOpen] = useState(false);
  const pendingAction = useRef(null);
  const accountRef = useRef(null);
  const accessBarRef = useRef(null);
  const accessHideTimerRef = useRef(null);
  const accessHandlePointerTypeRef = useRef('');
  const builderRef = useRef(null);
  const workspaceRef = useRef(null);
  const closeLibraryRef = useRef(null);
  const libraryOpenRef = useRef(false);
  const draggedDesignRef = useRef(null);
  const importRef = useRef(null);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryMessage, setLibraryMessage] = useState('');
  const [workspaceTab, setWorkspaceTab] = useState('library');

  function clearAccessHideTimer() {
    if (accessHideTimerRef.current) window.clearTimeout(accessHideTimerRef.current);
    accessHideTimerRef.current = null;
  }
  function revealAccessBar() {
    clearAccessHideTimer();
    setAccessBarOpen(true);
  }
  function hideAccessBarSoon() {
    clearAccessHideTimer();
    accessHideTimerRef.current = window.setTimeout(() => {
      if (!accessBarRef.current?.contains(document.activeElement)) setAccessBarOpen(false);
    }, 600);
  }
  function toggleAccessBar(event) {
    clearAccessHideTimer();
    const wasOpen = event.currentTarget.getAttribute('aria-expanded') === 'true';
    // Desktop hover is the primary interaction, so a mouse click keeps the
    // revealed bar available. A touch tap (and keyboard activation) toggles it.
    setAccessBarOpen(accessHandlePointerTypeRef.current === 'mouse' ? true : !wasOpen);
    accessHandlePointerTypeRef.current = '';
  }

  function showAccount() {
    setExportBlock('');
    setRegistration(emptyRegistration);
    setEmail(''); setPassword(''); setAuthMessage(''); setAuthMode('login'); setPaywallOpen(true);
  }
  function dismissAccount() {
    pendingAction.current = null; setPaywallOpen(false); setEmail(''); setPassword(''); setAuthMessage('');
  }
  async function handleAuth(event) {
    event.preventDefault(); setAuthMessage('');
    try {
      const result = await authRef.current.authenticate(authMode, email, password, registration);
      setPassword('');
      if (result.signedIn) {
        setEmail(''); setPaywallOpen(false);
        if (pendingAction.current === 'library') { pendingAction.current = null; openLibrary(); }
      } else setAuthMessage(result.message || 'Please sign in to continue.');
    } catch (error) { setPassword(''); setAuthMessage(error.message); }
  }
  function signOut() {
    setUsersOpen(false);
    pendingAction.current = null; closeLibrary(); dismissAccount(); setLibraryMessage('');
    authRef.current.signOut();
  }
  useEffect(() => {
    if (paywallOpen) accountRef.current?.querySelector('input,button')?.focus();
  }, [paywallOpen]);
  useEffect(() => {
    // Older email templates may redirect to Site URL instead of a callback.
    const hash = new URLSearchParams(location.hash.slice(1)), query = new URLSearchParams(location.search);
    if (hash.has('access_token') || hash.has('error') || query.has('token_hash') || query.has('code')) {
      location.replace((hash.get('type') === 'recovery' || query.get('type') === 'recovery' ? '/reset-password' : '/auth/callback') + location.search + location.hash); return;
    }
    if (new URLSearchParams(location.search).get('signin') === '1') {
      const changed = new URLSearchParams(location.search).get('passwordChanged') === '1';
      history.replaceState(null, '', '/'); showAccount();
      if (changed) setAuthMessage('Password changed successfully. Sign in with your new password.');
    }
  }, []);
  useEffect(() => () => clearAccessHideTimer(), []); // Do not leave a delayed update behind after navigation.
  useEffect(() => { if (backgroundEditorOpen) { clearAccessHideTimer(); setAccessBarOpen(false); } }, [backgroundEditorOpen]);
  useEffect(() => {
    if (!auth.ready) return;
    if (!auth.signedIn) closeLibrary();
    if (pendingAction.current === 'library') {
      if (auth.signedIn) { pendingAction.current = null; openLibrary(); }
      else showAccount();
    }
  }, [auth.ready, auth.signedIn]); // Auth changes immediately revoke workspace access.

  function openLibrary() {
    const current = authRef.current.current();
    if (!current.ready) { pendingAction.current = 'library'; return; }
    if (!current.signedIn) {
      pendingAction.current = 'library';
      showAccount();
      setAuthMessage('Sign in to browse the Design Library.');
      return;
    }
    setLibraryOpen(true);
    libraryOpenRef.current = true;
    setWorkspaceTab('library');
  }

  function closeLibrary() {
    libraryOpenRef.current = false;
    importRef.current?.abort();
    setLibraryOpen(false);
    setBackgroundEditorOpen(false);
    builderRef.current?.contentWindow?.smartSheetWorkspace?.setOpen(false);
  }

  async function importLibraryDesign(design, point) {
    if (importRef.current || !libraryOpenRef.current || !authRef.current.current().signedIn) return;
    const controller = new AbortController();
    importRef.current = controller;
    setLibraryBusy(true);
    setLibraryMessage(`Loading ${design.name} at full resolution…`);
    try {
      const response = await fetch(design.imageUrl, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('The library PNG could not be downloaded. Reopen the library to refresh its link.');
      const blob = await response.blob();
      if (blob.type !== 'image/png') throw new Error('The library item is not a PNG.');
      const target = builderRef.current?.contentWindow?.smartSheetWorkspace;
      if (!target) throw new Error('The builder is not ready yet.');
      if (controller.signal.aborted || !libraryOpenRef.current) return;
      await target.addFile(new File([blob], `${design.name || 'library-design'}.png`, { type: 'image/png' }), point);
      setLibraryMessage(`Added ${design.name}. Your other pieces stayed in place.`);
      setWorkspaceTab('sheet');
    } catch (error) {
      if (!controller.signal.aborted) setLibraryMessage(error.message || 'Unable to add this design.');
    } finally {
      importRef.current = null;
      setLibraryBusy(false);
    }
  }

  useEffect(() => {
    builderRef.current?.contentWindow?.smartSheetWorkspace?.setOpen(libraryOpen);
    if (libraryOpen) closeLibraryRef.current?.focus();
  }, [libraryOpen]);

  useEffect(() => {
    function handleWorkspaceMessage(event) {
      if (event.origin !== window.location.origin || event.source !== builderRef.current?.contentWindow) return;
      const data = event.data || {};
      if (data.type === 'SMART_SHEET_BACKGROUND_EDITOR_OPEN') { setBackgroundEditorOpen(true); return; }
      if (data.type === 'SMART_SHEET_BACKGROUND_EDITOR_CLOSE') { setBackgroundEditorOpen(false); return; }
      if (data.type === 'SMART_SHEET_LIBRARY_OPEN') openLibrary();
      if (!libraryOpenRef.current) return;
      if (data.type === 'SMART_SHEET_WORKSPACE_ESCAPE') closeLibrary();
      if (data.type === 'SMART_SHEET_LIBRARY_DROP' && data.libraryId === draggedDesignRef.current?.id) importLibraryDesign(draggedDesignRef.current, data.point);
      if (data.type === 'SMART_SHEET_WORKSPACE_FOCUS') {
        const controls = Array.from(workspaceRef.current.querySelectorAll('button,input,select,summary')).filter(el => !el.disabled && el.getClientRects().length);
        (data.backwards ? controls.at(-1) : controls[0])?.focus();
      }
    }
    window.addEventListener('message', handleWorkspaceMessage);
    return () => window.removeEventListener('message', handleWorkspaceMessage);
  }, []); // The handlers use refs for current session, drag and import state.

  function trapWorkspaceFocus(event) {
    if (!libraryOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); closeLibrary(); }
    if (event.key !== 'Tab') return;
    const controls = Array.from(workspaceRef.current.querySelectorAll('button,input,select,summary,iframe')).filter(el => !el.disabled && el.getClientRects().length);
    if (event.shiftKey && event.target === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    if (!event.shiftKey && event.target === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
  }

  useEffect(() => {
    function handleBuilderMessage(event) {
      const payload = event.data || {};
      if (event.origin !== window.location.origin || event.source !== builderRef.current?.contentWindow || payload.type !== 'SMART_SHEET_EXPORT_REQUEST') return;
      authRef.current.recordExport(payload.exportKind || 'download', payload.operation || {}).then(result => {
        if (result.allowed !== true) {
          closeLibrary(); showAccount();
          const current = authRef.current.current();
          if (['credits_empty','guest_limit_reached','limit_reached'].includes(result.reason)) setExportBlock(current.signedIn ? 'standard' : 'guest');
          else { setExportBlock('unavailable'); setAuthMessage(['access_check_failed','transport_error'].includes(result.reason) ? 'Export access is temporarily unavailable. Please refresh and try again.' : result.message || 'Export access is temporarily unavailable. Please refresh and try again.'); }
        }
        event.source?.postMessage({ type: 'SMART_SHEET_EXPORT_RESPONSE', requestId: payload.requestId, ...result }, event.origin);
      });
    }
    window.addEventListener('message', handleBuilderMessage);
    return () => window.removeEventListener('message', handleBuilderMessage);
  }, []);

  const remainingText = !auth.ready ? 'Checking access…' : auth.mode === 'local' ? 'Preview only' : auth.statusError ? 'Access check unavailable' : usage.unlimited ? 'Unlimited' : usage.creditMode ? `Free Export Credits: ${usage.remaining} / 2` : `${usage.remaining} left`;
  const modeText = !auth.ready ? 'Checking account…' : auth.mode === 'server' ? 'Server protected' : 'Local test mode';
  const modalTitle = auth.signedIn ? 'Your account' : authMode === 'forgot' ? 'Reset your password' : authMode === 'login' ? 'Welcome back' : 'Create your account';

  return (
    <main className="app-shell">
      <section ref={accessBarRef} className={`access-bar${accessBarOpen ? ' is-open' : ''}`} hidden={backgroundEditorOpen} inert={libraryOpen || paywallOpen ? '' : undefined} onPointerEnter={event => { if (event.pointerType !== 'touch') revealAccessBar(); }} onPointerLeave={event => { if (event.pointerType !== 'touch') hideAccessBarSoon(); }} onFocusCapture={() => { if (!accessHandlePointerTypeRef.current) revealAccessBar(); }} onBlurCapture={event => { if (!accessBarRef.current?.contains(event.relatedTarget)) hideAccessBarSoon(); }}>
        <button className="access-reveal-handle" type="button" aria-expanded={accessBarOpen} aria-controls="builder-access-bar" aria-label={accessBarOpen ? 'Hide account and export access' : 'Show account and export access'} onPointerDown={event => { accessHandlePointerTypeRef.current = event.pointerType; }} onPointerCancel={() => { accessHandlePointerTypeRef.current = ''; }} onFocus={() => { if (!accessHandlePointerTypeRef.current) revealAccessBar(); }} onClick={toggleAccessBar}>
          <span>Account &amp; exports</span><span aria-hidden="true">⌃</span>
        </button>
        <div id="builder-access-bar" className="access-bar-content" inert={accessBarOpen ? undefined : ''}>
          <div>
            <p className="access-kicker">Smart Sheet Builder V5.3B</p>
            <h1>Export access</h1>
            <p>
              Guest users get 2 free exports. Verified free accounts get Free Export Credits.
              PNG/TIFF download is counted as usage.
            </p>
          </div>
          <div className="usage-card">
            <span>{usage.label}</span>
            <strong>{remainingText}</strong>
            <small>{!auth.ready ? 'Checking session…' : auth.signedIn ? usage.email : auth.statusError || 'Not signed in'}</small>
            <small>{busy ? 'Checking...' : modeText}</small>
            <ExportCredits usage={usage} onDue={auth.refreshCredits} compact />
          </div>
          <button className="access-button" type="button" onClick={showAccount}>
            {auth.signedIn ? 'Account' : 'Sign in'}
          </button>
          {auth.signedIn && (
            <button className="access-button ghost" type="button" onClick={signOut}>
              Sign out
            </button>
          )}
          {auth.isSuperAdmin && <button className="access-button ghost" type="button" onClick={() => setUsersOpen(true)}>Users & Registrations</button>}
        </div>
      </section>

      <div className={`workspace-backdrop${libraryOpen ? ' is-open' : ''}`} aria-hidden="true" />
      <section ref={workspaceRef} inert={paywallOpen ? '' : undefined} className={`builder-workspace${libraryOpen ? ' is-open' : ''} tab-${workspaceTab}`} role={libraryOpen ? 'dialog' : undefined} aria-modal={libraryOpen ? 'true' : undefined} aria-labelledby={libraryOpen ? 'workspace-title' : undefined} onKeyDown={trapWorkspaceFocus}>
        <header className="workspace-header" hidden={!libraryOpen}>
          <div className="workspace-brand"><span aria-hidden="true">✦</span><div><p>MASTER PRINTLAB / CREATIVE WORKSPACE</p><h2 id="workspace-title">Design Library <em>+ your sheet</em></h2></div></div>
          <div className="workspace-tabs" role="tablist" aria-label="Workspace panel">
            <button type="button" role="tab" aria-selected={workspaceTab === 'library'} aria-controls="workspace-library" onClick={() => setWorkspaceTab('library')}>Library</button>
            <button type="button" role="tab" aria-selected={workspaceTab === 'sheet'} aria-controls="workspace-sheet" onClick={() => setWorkspaceTab('sheet')}>Sheet</button>
          </div>
          <button ref={closeLibraryRef} className="workspace-close" type="button" onClick={closeLibrary} aria-label="Close Design Library">Close <span aria-hidden="true">×</span></button>
        </header>
        <DesignLibraryDialog open={libraryOpen} auth={auth} onImport={importLibraryDesign} busy={libraryBusy} importMessage={libraryMessage}
          onDragStart={(event, design) => {
            if (importRef.current) { event.preventDefault(); return; }
            draggedDesignRef.current = design;
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('text/plain', design.id);
            builderRef.current?.contentWindow?.smartSheetWorkspace?.beginDrag(design);
          }}
          onDragEnd={() => builderRef.current?.contentWindow?.smartSheetWorkspace?.endDrag()}
        />
      <iframe
        id="workspace-sheet"
        ref={builderRef}
        className="builder-frame"
        src="/builder.html"
        title="Smart Sheet Builder by Master PrintLab"
      />
      </section>

      {paywallOpen && (
        <section ref={accountRef} className="access-modal" role="dialog" aria-modal="true" aria-labelledby="account-title" onKeyDown={event => {
          if (event.key === 'Escape') dismissAccount();
          if (event.key !== 'Tab') return;
          const controls = Array.from(accountRef.current.querySelectorAll('button,input,select,summary,a[href]')).filter(el => !el.disabled && el.getClientRects().length);
          if (event.shiftKey && event.target === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
          if (!event.shiftKey && event.target === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
        }}>
          <div className="access-modal-card">
            <button className="modal-close" type="button" onClick={dismissAccount} aria-label="Close account">
              x
            </button>
            <p className="access-kicker">Master PrintLab access</p>
            {exportBlock ? <>
              <h2 id="account-title">{exportBlock === 'guest' ? 'Your guest trial is complete' : exportBlock === 'standard' ? 'No Free Export Credits available' : 'Export unavailable'}</h2>
              {exportBlock === 'guest' ? <><p>Create a free account to receive 2 Free Export Credits and continue exporting your sheets.</p><div className="auth-form"><button onClick={() => { setExportBlock(''); setAuthMode('register'); }}>Create free account</button><button onClick={() => { setExportBlock(''); setAuthMode('login'); }}>Sign in</button></div></> : exportBlock === 'standard' ? <>
                {usage.remaining > 0 ? <p role="status">Your free credit is available. Continue editing and retry your export.</p> : <CreditCountdown usage={usage} onDue={auth.refreshCredits} exhausted />}
                <div className="auth-form"><button onClick={dismissAccount}>Wait for free credit</button><button className="credits-coming-soon" disabled>Buy Export Credits — Coming Soon</button></div>
              </> : <p role="alert">{authMessage}</p>}
              <button className="password-link" onClick={dismissAccount}>Continue editing</button>
            </> : <>
            <h2 id="account-title">{modalTitle}</h2>
            <p className="modal-copy">{auth.signedIn ? `${auth.email} · ${usage.label} · ${remainingText}` : authMode === 'forgot' ? 'Recover access to your existing account.' : authMode === 'register' ? 'Create a free account to save your access and receive Free Export Credits.' : 'Sign in to your workspace. Verified free accounts start with 2 Free Export Credits.'}</p>
            {auth.signedIn && <ExportCredits usage={usage} onDue={auth.refreshCredits} onWait={dismissAccount} />}
            {auth.signedIn && auth.accessToken && <AccountProfile key={auth.accessToken} token={auth.accessToken} />}
            {auth.signedIn && auth.accessToken && <ChangePassword key={`security-${auth.accessToken}`} token={auth.accessToken} onChanged={warning => { signOut(); showAccount(); setAuthMessage(`Password changed successfully. Sign in with your new password.${warning ? ` ${warning}` : ''}`); }} />}
            {auth.signedIn && auth.accessToken && usage.creditMode && <details><summary>View credit history</summary><CreditHistory token={auth.accessToken} /></details>}
            {!auth.signedIn && authMode === 'forgot' && <PasswordRequestForm onBack={() => { setAuthMode('login'); setAuthMessage(''); }} />}
            {!auth.signedIn && authMode !== 'forgot' && (
            <form className="auth-form" onSubmit={handleAuth}>
              <div className="auth-tabs" role="tablist" aria-label="Account mode">
                <button
                  type="button"
                  role="tab" aria-selected={authMode === 'register'} className={authMode === 'register' ? 'active' : ''}
                  onClick={() => { setAuthMode('register'); setAuthMessage(''); setPassword(''); }}
                >
                  Create account
                </button>
                <button
                  type="button"
                  role="tab" aria-selected={authMode === 'login'} className={authMode === 'login' ? 'active' : ''}
                  onClick={() => { setAuthMode('login'); setAuthMessage(''); setPassword(''); }}
                >
                  Sign in
                </button>
              </div>
              {authMode === 'register' && <RegistrationFields value={registration} onChange={setRegistration} />}
              <label>
                Email
                <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" maxLength={254} required />
              </label>
              <label>
                Password
                <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={6} maxLength={1024} autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} required />
              </label>
              <button type="submit" disabled={busy || !auth.ready}>
                {busy ? 'Please wait...' : authMode === 'register' ? 'Create account' : 'Sign in'}
              </button>
              {authMode === 'login' && <button className="password-link" type="button" onClick={() => { setPassword(''); setAuthMessage(''); setAuthMode('forgot'); }}>Forgot password?</button>}
            </form>
            )}

            {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
            </>}

          </div>
        </section>
      )}

      {usersOpen && auth.isSuperAdmin && <UsersDialog token={auth.accessToken} onClose={() => setUsersOpen(false)} />}
      <noscript>
        <div className="noscript-message">
          Smart Sheet Builder needs JavaScript enabled to arrange and export sheets.
        </div>
      </noscript>
    </main>
  );
}
