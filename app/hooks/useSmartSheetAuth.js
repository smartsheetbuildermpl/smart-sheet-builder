'use client';

import { useEffect, useRef, useState } from 'react';
import { localPasswordVerifier, sanitizeLocalAccounts } from '../lib/local-test-credentials';
import { browserAuth, restoreSession, adoptSession, appSession, terminalAuthError } from '../lib/browser-auth';

const SESSION_KEY = 'smart-sheet-builder-v53b-session';
const LOCAL_KEY = 'smart-sheet-builder-v53b-local-test';
const LEGACY_KEY = 'smart-sheet-builder-v53-access';
const DELIVERY_KEY = 'ssb-export-delivery-outbox-v1';
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const emptyLocal = () => ({ guestExportsUsed: 0, currentEmail: '', accounts: {} });
const adminEmails = () => ['masterprintlabcorp@gmail.com', ...String(process.env.NEXT_PUBLIC_SMART_SHEET_ADMIN_EMAILS || '').split(',').map(normalizeEmail)];

function localUsage(local) {
  const email = normalizeEmail(local.currentEmail);
  const account = local.accounts[email];
  const signedIn = Boolean(account && email);
  const admin = signedIn && (account.plan === 'admin' || adminEmails().includes(email));
  const unlimited = signedIn && (admin || account.plan === 'subscriber');
  const used = Number(signedIn ? account.exportsUsed || 0 : local.guestExportsUsed || 0);
  // Offline test accounts cannot mint server-backed credits.
  const limit = unlimited ? null : signedIn ? 0 : 2;
  return { email: signedIn ? email : '', signedIn, unlimited, used, limit, remaining: unlimited ? null : Math.max(0, limit - used), label: admin ? 'Admin' : unlimited ? 'Subscribed' : signedIn ? 'Free account' : 'Guest trial', plan: admin ? 'admin' : signedIn ? account.plan || 'free' : 'guest', mode: 'local_test' };
}

function view(state) {
  const usage = state.mode === 'local' ? localUsage(state.local) : state.usage;
  const signedIn = state.ready && (state.mode === 'local' ? usage.signedIn : Boolean(state.session?.accessToken));
  return { ...state, usage, signedIn, email: signedIn ? usage.email : '', isSuperAdmin: signedIn && state.mode === 'server' && usage.isSuperAdmin === true, isAdmin: signedIn && (usage.isAdmin ?? (usage.plan === 'admin' || usage.label === 'Admin')), canManageLibrary: signedIn && (state.mode === 'local' ? usage.email === 'masterprintlabcorp@gmail.com' : usage.canManageLibrary === true), accessToken: state.mode === 'server' && signedIn ? state.session.accessToken : '' };
}

async function request(path, options = {}, session) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || 'Unable to complete the request. Please try again.'); error.data = data; error.status = response.status; throw error; }
  return data;
}

// Session, local account, identity and usage are published together. All UI and
// action handlers read this store; asynchronous responses cannot revive a sign-out.
export default function useSmartSheetAuth() {
  const initial = { ready: false, mode: 'loading', session: null, local: emptyLocal(), guestId: '', usage: localUsage(emptyLocal()), busy: false };
  const [state, setState] = useState(initial);
  const stateRef = useRef(initial);
  const epoch = useRef(0);
  const usageRevision = useRef(0);
  const deliveryOutbox = useRef([]);
  const flushingDelivery = useRef(null);
  function pendingDeliveries() {
    try { const saved = JSON.parse(localStorage.getItem(DELIVERY_KEY) || '[]'); if (Array.isArray(saved)) deliveryOutbox.current = saved; } catch {}
    return deliveryOutbox.current;
  }
  function storeDeliveries(items) {
    deliveryOutbox.current = items;
    try { localStorage.setItem(DELIVERY_KEY, JSON.stringify(items)); } catch {}
  }
  function queueDelivery(current, kind, operation) {
    const item = { owner: current.session?.user?.id || current.email || 'guest-cookie', kind, operation };
    const list = pendingDeliveries().filter(i => !(i.owner === item.owner && i.operation?.receipt === operation.receipt && i.operation?.action === operation.action));
    storeDeliveries([...list, item]);
  }
  function clearDelivery(owner, operation) {
    storeDeliveries(pendingDeliveries().filter(i => !(i.owner === owner && i.operation?.receipt === operation.receipt && i.operation?.action === operation.action)));
  }
  async function flushDeliveries() {
    if (flushingDelivery.current) return flushingDelivery.current;
    const current = view(stateRef.current), actor = current.session?.user?.id || current.email || 'guest-cookie';
    if (current.mode !== 'server') return true;
    flushingDelivery.current = (async () => {
      for (const item of [...pendingDeliveries()].filter(i => i.owner === actor)) {
        try {
          const data = await request('/api/export/consume', { method: 'POST', body: JSON.stringify({ exportKind: item.kind, ...item.operation }) }, current.session);
          if (!data.allowed) return false;
          clearDelivery(actor, item.operation);
        } catch { return false; }
      }
      return true;
    })();
    try { return await flushingDelivery.current; } finally { flushingDelivery.current = null; }
  }
  function publish(patch) {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
    if (next.ready) {
      if (next.session?.accessToken) localStorage.setItem(SESSION_KEY, JSON.stringify(next.session));
      else localStorage.removeItem(SESSION_KEY);
      localStorage.setItem(LOCAL_KEY, JSON.stringify(next.local));
    }
    return view(next);
  }
  function activateLocalTest() {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return publish({ mode: 'server', session: null, ready: true, busy: false, usage: serverUsage({}, null) });
    if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) console.warn('Supabase env vars are not configured. Smart Sheet Builder is using local test mode.');
    return publish({ mode: 'local', session: null, ready: true, busy: false });
  }
  function serverUsage(data, session) {
    const usage = data.usage || {};
    return { ...localUsage(emptyLocal()), ...usage, email: usage.email || session?.user?.email || '', signedIn: Boolean(session?.accessToken && usage.signedIn), mode: 'server' };
  }
  async function refresh(session = stateRef.current.session) {
    const operation = ++epoch.current;
    publish({ busy: true });
    try {
      if (session?.refreshToken) session = await restoreSession(session);
      let data;
      try { data = await request(session?.accessToken ? '/api/auth/me' : `/api/export/status?legacyGuestId=${encodeURIComponent(localStorage.getItem('smart-sheet-builder-v53b-guest-id') || '')}`, {}, session); }
      catch (error) {
        if (error.data?.code !== 'invalid_session' || !session?.refreshToken) throw error;
        session = await restoreSession(session, { force: true });
        data = await request(session?.accessToken ? '/api/auth/me' : '/api/export/status', {}, session);
      }
      if (operation !== epoch.current) return;
      if (data.configured === false) return activateLocalTest();
      publish({ ready: true, mode: 'server', session, usage: serverUsage(data, session), busy: false, statusError: '' });
    } catch (error) {
      if (operation !== epoch.current) return;
      if (error.data?.configured === false) return activateLocalTest();
      if (terminalAuthError(error) || error.data?.code === 'invalid_session') {
        browserAuth()?.signOut({ scope: 'local' }).catch(() => {});
        publish({ ready: true, mode: 'server', session: null, usage: serverUsage({}, null), busy: false, statusError: 'Session expired. Please sign in again.' });
      } else {
        publish({ ready: true, mode: 'server', session, busy: false, statusError: 'Account status unavailable. Reconnect to verify export access.', usage: stateRef.current.usage.signedIn ? stateRef.current.usage : { ...serverUsage({}, session), signedIn: Boolean(session), remaining: null } });
      }
    }
  }
  async function refreshCredits() {
    const current = view(stateRef.current), operation = epoch.current, revision = ++usageRevision.current;
    if (current.mode !== 'server') return;
    try {
      await flushDeliveries();
      const session = current.session?.refreshToken ? await restoreSession(current.session) : current.session;
      const data = await request('/api/export/status', {}, session);
      if (operation === epoch.current && revision === usageRevision.current) publish({ session, usage: serverUsage(data, session), statusError: '' });
    } catch (error) { if (terminalAuthError(error) || error.data?.code === 'invalid_session') await refresh(current.session); }
  }
  useEffect(() => {
    if (!state.ready || state.mode !== 'server') return;
    const tick = () => { if (document.visibilityState === 'visible') refreshCredits(); };
    tick(); const timer = setInterval(tick, 30000);
    window.addEventListener('focus', tick); document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick); };
  }, [state.ready, state.mode, state.session?.accessToken]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    (async () => {
    let local = emptyLocal(), session = null;
    try { const saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || localStorage.getItem(LEGACY_KEY) || 'null'); if (saved) local = { ...local, ...saved, accounts: saved.accounts || {} }; } catch {}
    try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch {}
    local.accounts = await sanitizeLocalAccounts(local.accounts);
    if (cancelled) return;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
    localStorage.removeItem(LEGACY_KEY);
    publish({ local, session });
    try {
      session = await restoreSession(session);
      if (!cancelled) await refresh(session);
    } catch (error) {
      if (!cancelled) {
        if (terminalAuthError(error)) { localStorage.removeItem(SESSION_KEY); await refresh(null); }
        else publish({ ready: true, mode: 'server', session, statusError: 'Reconnect to check your account.', usage: { ...serverUsage({}, session), signedIn: Boolean(session), remaining: null } });
      }
    }
    })();
    return () => { cancelled = true; epoch.current++; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const auth = browserAuth();
    if (!auth) return;
    const { data } = auth.onAuthStateChange((event, session) => {
      if (!stateRef.current.ready || event === 'INITIAL_SESSION') return;
      // No awaited SDK calls inside its auth lock callback.
      if (event === 'TOKEN_REFRESHED') publish({ session: appSession(session) });
      if (event === 'SIGNED_IN' && session && session.user?.id !== stateRef.current.session?.user?.id) publish({ session: appSession(session), usage: serverUsage({}, appSession(session)), statusError: 'Checking account access…' });
      if (event === 'SIGNED_OUT') {
        const operation = ++epoch.current;
        publish({ session: null, usage: serverUsage({}, null), statusError: '', busy: false });
        setTimeout(() => { if (operation === epoch.current && !stateRef.current.session) refresh(null); }, 0);
      }
    });
    return () => data.subscription.unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function authenticateLocal(mode, email, password) {
    const operation = epoch.current;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) throw new Error('Local test accounts are only available on localhost.');
    const local = stateRef.current.local;
    const existing = local.accounts[email];
    if (mode === 'login' && (!existing?.passwordVerifier || (await localPasswordVerifier(password, existing.passwordVerifier.salt)).hash !== existing.passwordVerifier.hash)) throw new Error('Email or password is incorrect. New here? Choose Create account.');
    if (mode === 'register' && existing) throw new Error('An account with this email already exists. Choose Sign in.');
    const account = existing || { email, passwordVerifier: await localPasswordVerifier(password), plan: adminEmails().includes(email) ? 'admin' : 'free', exportsUsed: adminEmails().includes(email) ? 0 : Math.min(Number(local.guestExportsUsed || 0), 5), createdAt: new Date().toISOString() };
    if (operation !== epoch.current) return { signedIn: false };
    publish({ ready: true, mode: 'local', session: null, local: { ...local, currentEmail: email, accounts: { ...local.accounts, [email]: account } }, busy: false });
    return { signedIn: true };
  }
  async function authenticate(mode, rawEmail, password, profile = {}) {
    const email = normalizeEmail(rawEmail);
    if (!email || !password) throw new Error('Enter your email and password.');
    if (password.length < 6) throw new Error('Use a password with at least 6 characters.');
    if (!stateRef.current.ready) throw new Error('Your account is still loading. Please try again in a moment.');
    const operation = ++epoch.current;
    if (stateRef.current.mode === 'local') return authenticateLocal(mode, email, password);
    publish({ busy: true });
    try {
      const data = await request(`/api/auth/${mode === 'login' ? 'login' : 'register'}`, { method: 'POST', body: JSON.stringify({ email, password, guestId: stateRef.current.guestId, ...(mode === 'register' ? { profile } : {}) }) });
      if (operation !== epoch.current) return { signedIn: false };
      if (data.configured === false) { activateLocalTest(); return authenticateLocal(mode, email, password); }
      if (data.session?.accessToken) {
        const session = await adoptSession(data.session);
        if (operation !== epoch.current) return { signedIn: false };
        publish({ ready: true, mode: 'server', session, usage: serverUsage(data, session), busy: false, statusError: '' });
        return { signedIn: view(stateRef.current).signedIn };
      }
      return { signedIn: false, message: data.message || 'Check your email to confirm your account, then sign in.' };
    } catch (error) {
      if (operation !== epoch.current) return { signedIn: false };
      if (error.data?.configured === false) { activateLocalTest(); return authenticateLocal(mode, email, password); }
      throw new Error(error.data?.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message) ? 'Email or password is incorrect. Please try again.' : /failed to fetch|fetch failed|networkerror|load failed/i.test(error.message) ? 'Could not reach the sign-in service. Check your connection and try again. If this continues, contact support to check the Supabase URL configuration.' : error.message);
    } finally { if (operation === epoch.current) publish({ busy: false }); }
  }
  function signOut() {
    epoch.current++;
    browserAuth()?.signOut({ scope: 'local' }).catch(() => {});
    const local = { ...stateRef.current.local, currentEmail: '' };
    publish({ session: null, local, usage: localUsage({ ...local, currentEmail: '' }), busy: false });
    if (stateRef.current.mode === 'server') refresh(null);
  }
  async function recordExport(kind, exportOperation = {}) {
    let current = view(stateRef.current); const operation = epoch.current;
    const revision = ++usageRevision.current;
    if (!current.ready) return { allowed: false, message: 'Your account is still loading. Please try again.' };
    if (current.mode === 'local') return { allowed: false, message: 'Connect Supabase to authorize official exports. Offline preview remains available.' };
    try {
      if (current.session?.refreshToken) {
        const session = await restoreSession(current.session);
        if (operation !== epoch.current) return { allowed: false, message: 'Your account changed. Retry the export.' };
        current = publish({ session });
      }
      const finalizing = ['saved','refund'].includes(exportOperation.action) && exportOperation.receipt;
      if (finalizing) queueDelivery(current, kind, exportOperation);
      else if (!(await flushDeliveries())) return { allowed: false, reason: 'delivery_pending', message: 'A previous export needs its delivery status confirmed. Reconnect and retry; no new credit was used.' };
      const data = await request('/api/export/consume', { method: 'POST', body: JSON.stringify({ exportKind: kind || 'download', guestId: current.guestId, ...exportOperation }) }, current.session);
      if (finalizing && data.allowed) clearDelivery(current.session?.user?.id || current.email || 'guest-cookie', exportOperation);
      if (operation !== epoch.current) return { allowed: false, message: 'Your account changed. Please try again.' };
      if (data.configured === false) return { allowed: false, message: 'Server authorization is unavailable.' };
      if (data.usage && revision === usageRevision.current) publish({ usage: serverUsage(data, current.session) });
      return { allowed: data.allowed === true, reason: data.reason, message: data.message, receipt: data.receipt, duplicate: data.duplicate, authorization: data.authorization };
    } catch (error) {
      if (operation !== epoch.current) return { allowed: false, message: 'Your account changed. Please try again.' };
      if (error.data?.code === 'invalid_session' || terminalAuthError(error)) await refresh(current.session);
      return { allowed: false, reason: 'access_check_failed', message: 'Export access is temporarily unavailable. Please refresh and try again.' };
    }
  }
  return { ...view(state), current: () => view(stateRef.current), authenticate, signOut, recordExport, refreshCredits };
}
