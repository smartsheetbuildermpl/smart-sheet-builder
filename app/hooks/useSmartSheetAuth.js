'use client';

import { useEffect, useRef, useState } from 'react';
import { localPasswordVerifier, sanitizeLocalAccounts } from '../lib/local-test-credentials';

const SESSION_KEY = 'smart-sheet-builder-v53b-session';
const GUEST_KEY = 'smart-sheet-builder-v53b-guest-id';
const LOCAL_KEY = 'smart-sheet-builder-v53b-local-test';
const LEGACY_KEY = 'smart-sheet-builder-v53-access';
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
  const limit = unlimited ? null : signedIn ? 5 : 2;
  return { email: signedIn ? email : '', signedIn, unlimited, used, limit, remaining: unlimited ? null : Math.max(0, limit - used), label: admin ? 'Admin' : unlimited ? 'Subscribed' : signedIn ? 'Free account' : 'Guest trial', plan: admin ? 'admin' : signedIn ? account.plan || 'free' : 'guest', mode: 'local_test' };
}

function view(state) {
  const usage = state.mode === 'local' ? localUsage(state.local) : state.usage;
  const signedIn = state.ready && (state.mode === 'local' ? usage.signedIn : Boolean(state.session?.accessToken && usage.signedIn));
  return { ...state, usage, signedIn, email: signedIn ? usage.email : '', isSuperAdmin: signedIn && state.mode === 'server' && usage.isSuperAdmin === true, isAdmin: signedIn && (usage.isAdmin ?? (usage.plan === 'admin' || usage.label === 'Admin')), canManageLibrary: signedIn && (state.mode === 'local' ? usage.email === 'masterprintlabcorp@gmail.com' : usage.canManageLibrary === true), accessToken: state.mode === 'server' && signedIn ? state.session.accessToken : '' };
}

async function request(path, options = {}, session) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.message || 'Unable to complete the request. Please try again.'); error.data = data; throw error; }
  return data;
}

// Session, local account, identity and usage are published together. All UI and
// action handlers read this store; asynchronous responses cannot revive a sign-out.
export default function useSmartSheetAuth() {
  const initial = { ready: false, mode: 'loading', session: null, local: emptyLocal(), guestId: '', usage: localUsage(emptyLocal()), busy: false };
  const [state, setState] = useState(initial);
  const stateRef = useRef(initial);
  const epoch = useRef(0);
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
      const data = await request(session?.accessToken ? '/api/auth/me' : `/api/export/status?guestId=${encodeURIComponent(stateRef.current.guestId)}`, {}, session);
      if (operation !== epoch.current) return;
      if (data.configured === false) return activateLocalTest();
      publish({ ready: true, mode: 'server', session, usage: serverUsage(data, session), busy: false });
    } catch (error) {
      if (operation !== epoch.current) return;
      if (error.data?.configured === false) return activateLocalTest();
      publish({ ready: true, mode: 'server', session: null, usage: serverUsage({}, null), busy: false });
    }
  }
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
    const guestId = localStorage.getItem(GUEST_KEY) || crypto.randomUUID();
    localStorage.setItem(GUEST_KEY, guestId);
    publish({ guestId, local, session });
    refresh(session);
    })();
    return () => { cancelled = true; epoch.current++; };
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
        publish({ ready: true, mode: 'server', session: data.session, usage: serverUsage(data, data.session), busy: false });
        return { signedIn: view(stateRef.current).signedIn };
      }
      return { signedIn: false, message: data.message || 'Check your email to confirm your account, then sign in.' };
    } catch (error) {
      if (operation !== epoch.current) return { signedIn: false };
      if (error.data?.configured === false) { activateLocalTest(); return authenticateLocal(mode, email, password); }
      throw new Error(error.data?.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message) ? 'Email or password is incorrect. Please try again.' : error.message);
    } finally { if (operation === epoch.current) publish({ busy: false }); }
  }
  function signOut() {
    epoch.current++;
    const local = { ...stateRef.current.local, currentEmail: '' };
    publish({ session: null, local, usage: localUsage({ ...local, currentEmail: '' }), busy: false });
    if (stateRef.current.mode === 'server') refresh(null);
  }
  function recordLocalExport(kind) {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return { allowed: false, message: 'Account service is not configured. Contact support.' };
    const current = view(stateRef.current), local = current.local, usage = current.usage;
    if (!usage.unlimited && usage.remaining <= 0) return { allowed: false, reason: 'limit_reached', message: usage.signedIn ? 'Your free account has used all 5 trial exports.' : 'Guest trial used up. Create a free account for 5 total exports.' };
    const next = { ...local, accounts: { ...local.accounts } };
    if (current.signedIn) next.accounts[current.email] = { ...next.accounts[current.email], exportsUsed: Number(next.accounts[current.email].exportsUsed || 0) + 1, lastExportType: kind, lastExportAt: new Date().toISOString() };
    else next.guestExportsUsed = Number(next.guestExportsUsed || 0) + 1;
    publish({ local: next });
    return { allowed: true };
  }
  async function recordExport(kind) {
    const current = view(stateRef.current), operation = epoch.current;
    if (!current.ready) return { allowed: false, message: 'Your account is still loading. Please try again.' };
    if (current.mode === 'local') return recordLocalExport(kind);
    try {
      const data = await request('/api/export/consume', { method: 'POST', body: JSON.stringify({ exportKind: kind || 'download', guestId: current.guestId }) }, current.session);
      if (operation !== epoch.current) return { allowed: false, message: 'Your account changed. Please try again.' };
      if (data.configured === false) { activateLocalTest(); return recordLocalExport(kind); }
      publish({ usage: serverUsage(data, current.session) });
      return { allowed: Boolean(data.allowed), reason: data.reason, message: data.message };
    } catch (error) {
      if (operation !== epoch.current) return { allowed: false, message: 'Your account changed. Please try again.' };
      if (error.data?.configured === false) { activateLocalTest(); return recordLocalExport(kind); }
      if (error.data?.code === 'invalid_session') signOut();
      return { allowed: false, reason: 'access_check_failed', message: error.message || 'Export access check failed.' };
    }
  }
  return { ...view(state), current: () => view(stateRef.current), authenticate, signOut, recordExport };
}
