'use client';

import { useEffect, useRef, useState } from 'react';

const SESSION_KEY = 'smart-sheet-builder-v53b-session';
const GUEST_ID_KEY = 'smart-sheet-builder-v53b-guest-id';
const LOCAL_TEST_KEY = 'smart-sheet-builder-v53b-local-test';
const LEGACY_LOCAL_KEY = 'smart-sheet-builder-v53-access';
const GUEST_LIMIT = 2;
const REGISTERED_LIMIT = 5;
const OWNER_EMAILS = ['masterprintlabcorp@gmail.com'];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function makeDefaultLocalState() {
  return {
    guestExportsUsed: 0,
    currentEmail: '',
    accounts: {},
  };
}

function makeGuestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `guest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getAdminEmails() {
  const configuredEmails = String(process.env.NEXT_PUBLIC_SMART_SHEET_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
  return [...new Set(OWNER_EMAILS.concat(configuredEmails))];
}

function usageForLocalState(state) {
  const email = normalizeEmail(state.currentEmail);
  const account = email ? state.accounts[email] : null;
  const isAdmin = getAdminEmails().includes(email);

  if (isAdmin || account?.plan === 'admin' || account?.plan === 'subscriber') {
    return {
      email,
      label: isAdmin || account.plan === 'admin' ? 'Admin' : 'Subscribed',
      limit: null,
      used: Number(account.exportsUsed || 0),
      remaining: null,
      signedIn: Boolean(email),
      unlimited: true,
      mode: 'local_test',
    };
  }

  if (account) {
    const used = Number(account.exportsUsed || 0);
    return {
      email,
      label: 'Free account',
      limit: REGISTERED_LIMIT,
      used,
      remaining: Math.max(0, REGISTERED_LIMIT - used),
      signedIn: true,
      unlimited: false,
      mode: 'local_test',
    };
  }

  const used = Number(state.guestExportsUsed || 0);
  return {
    email: '',
    label: 'Guest trial',
    limit: GUEST_LIMIT,
    used,
    remaining: Math.max(0, GUEST_LIMIT - used),
    signedIn: false,
    unlimited: false,
    mode: 'local_test',
  };
}

function normalizeUsage(usage, fallback) {
  if (!usage) return fallback;
  return {
    email: usage.email || '',
    label: usage.label || fallback.label,
    limit: usage.limit ?? fallback.limit,
    used: Number(usage.used || 0),
    remaining: usage.unlimited ? null : Number(usage.remaining ?? fallback.remaining ?? 0),
    signedIn: Boolean(usage.signedIn),
    unlimited: Boolean(usage.unlimited),
    mode: usage.mode || 'server',
    plan: usage.plan || 'free',
  };
}

async function parseApiResponse(response) {
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(data.message || 'Request failed.');
    error.data = data;
    throw error;
  }
  return data;
}

export default function HomePage() {
  const [ready, setReady] = useState(false);
  const [serverConfigured, setServerConfigured] = useState(true);
  const [session, setSession] = useState(null);
  const [guestId, setGuestId] = useState('');
  const [localState, setLocalState] = useState(makeDefaultLocalState);
  const [usage, setUsage] = useState(() => usageForLocalState(makeDefaultLocalState()));
  const [authMode, setAuthMode] = useState('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const sessionRef = useRef(session);
  const guestIdRef = useRef(guestId);
  const localStateRef = useRef(localState);
  const serverConfiguredRef = useRef(serverConfigured);

  useEffect(() => {
    let savedGuestId = window.localStorage.getItem(GUEST_ID_KEY);
    if (!savedGuestId) {
      savedGuestId = makeGuestId();
      window.localStorage.setItem(GUEST_ID_KEY, savedGuestId);
    }
    setGuestId(savedGuestId);
    guestIdRef.current = savedGuestId;

    try {
      const savedSession = window.localStorage.getItem(SESSION_KEY);
      if (savedSession) {
        const parsedSession = JSON.parse(savedSession);
        setSession(parsedSession);
        sessionRef.current = parsedSession;
      }
    } catch {
      window.localStorage.removeItem(SESSION_KEY);
    }

    try {
      const savedLocal = window.localStorage.getItem(LOCAL_TEST_KEY) || window.localStorage.getItem(LEGACY_LOCAL_KEY);
      if (savedLocal) {
        const parsedLocal = JSON.parse(savedLocal);
        const nextLocal = {
          ...makeDefaultLocalState(),
          ...parsedLocal,
          accounts: parsedLocal.accounts || {},
        };
        setLocalState(nextLocal);
        localStateRef.current = nextLocal;
        setUsage(usageForLocalState(nextLocal));
      }
    } catch {
      setLocalState(makeDefaultLocalState());
    }

    setReady(true);
  }, []);

  useEffect(() => {
    sessionRef.current = session;
    if (!ready) return;
    if (session?.accessToken) {
      window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } else {
      window.localStorage.removeItem(SESSION_KEY);
    }
  }, [session, ready]);

  useEffect(() => {
    localStateRef.current = localState;
    if (ready) {
      window.localStorage.setItem(LOCAL_TEST_KEY, JSON.stringify(localState));
    }
  }, [localState, ready]);

  useEffect(() => {
    serverConfiguredRef.current = serverConfigured;
  }, [serverConfigured]);

  async function apiFetch(path, options = {}) {
    const currentSession = sessionRef.current;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    };

    if (currentSession?.accessToken && !headers.Authorization) {
      headers.Authorization = `Bearer ${currentSession.accessToken}`;
    }

    const response = await fetch(path, {
      ...options,
      headers,
    });
    return parseApiResponse(response);
  }

  async function refreshUsage(nextSession = sessionRef.current, nextGuestId = guestIdRef.current) {
    if (!nextGuestId) return;
    setBusy(true);
    try {
      const data = nextSession?.accessToken
        ? await apiFetch('/api/auth/me', {
            headers: { Authorization: `Bearer ${nextSession.accessToken}` },
          })
        : await apiFetch(`/api/export/status?guestId=${encodeURIComponent(nextGuestId)}`);

      if (data.configured === false) {
        setServerConfigured(false);
        setUsage(usageForLocalState(localStateRef.current));
        return;
      }

      setServerConfigured(true);
      setUsage((current) => normalizeUsage(data.usage, current));
    } catch (error) {
      if (error.data?.configured === false) {
        setServerConfigured(false);
        setUsage(usageForLocalState(localStateRef.current));
      } else if (nextSession?.accessToken && error.data?.code === 'invalid_session') {
        setSession(null);
        setUsage(usageForLocalState(localStateRef.current));
        setAuthMessage('Session expired. Please sign in again.');
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (ready && guestId) {
      refreshUsage(sessionRef.current, guestId);
    }
  }, [ready, guestId]);

  function handleLocalAuth(cleanEmail, cleanPassword) {
    const adminEmails = getAdminEmails();
    const current = localStateRef.current;
    const existing = current.accounts[cleanEmail];

    if (authMode === 'login') {
      if (!existing || existing.password !== cleanPassword) {
        setAuthMessage('Account not found yet. Create a free account first.');
        return;
      }
      const nextState = { ...current, currentEmail: cleanEmail };
      setLocalState(nextState);
      setUsage(usageForLocalState(nextState));
      setAuthMessage('Signed in using local test mode. Add Supabase env vars for real accounts.');
      setPaywallOpen(false);
      return;
    }

    if (existing) {
      setAuthMessage('This email already exists. Switch to Sign in.');
      return;
    }

    const plan = adminEmails.includes(cleanEmail) ? 'admin' : 'free';
    const importedGuestUses = Math.min(Number(current.guestExportsUsed || 0), REGISTERED_LIMIT);
    const nextState = {
      ...current,
      currentEmail: cleanEmail,
      accounts: {
        ...current.accounts,
        [cleanEmail]: {
          email: cleanEmail,
          password: cleanPassword,
          plan,
          exportsUsed: plan === 'admin' ? 0 : importedGuestUses,
          createdAt: new Date().toISOString(),
        },
      },
    };

    setLocalState(nextState);
    setUsage(usageForLocalState(nextState));
    setAuthMessage(
      plan === 'admin'
        ? 'Admin account ready in local test mode.'
        : 'Free account created in local test mode. Add Supabase env vars for real accounts.'
    );
    setPaywallOpen(false);
  }

  async function handleAuth(event) {
    event.preventDefault();
    const cleanEmail = normalizeEmail(email);
    const cleanPassword = String(password || '');

    if (!cleanEmail || !cleanPassword) {
      setAuthMessage('Enter your email and password.');
      return;
    }

    if (cleanPassword.length < 6) {
      setAuthMessage('Password must be at least 6 characters.');
      return;
    }

    if (!serverConfiguredRef.current) {
      handleLocalAuth(cleanEmail, cleanPassword);
      return;
    }

    setBusy(true);
    setAuthMessage('');
    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const data = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          email: cleanEmail,
          password: cleanPassword,
          guestId: guestIdRef.current,
        }),
      });

      if (data.configured === false) {
        setServerConfigured(false);
        handleLocalAuth(cleanEmail, cleanPassword);
        return;
      }

      if (data.session?.accessToken) {
        const nextSession = data.session;
        setSession(nextSession);
        sessionRef.current = nextSession;
        setUsage((current) => normalizeUsage(data.usage, current));
        setPaywallOpen(false);
      }

      setAuthMessage(data.message || (authMode === 'login' ? 'Signed in.' : 'Free account created.'));
    } catch (error) {
      setAuthMessage(error.data?.message || error.message || 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    setSession(null);
    sessionRef.current = null;
    setAuthMessage('');
    refreshUsage(null, guestIdRef.current);
  }

  function recordLocalExport(kind) {
    const current = localStateRef.current;
    const currentUsage = usageForLocalState(current);

    if (!currentUsage.unlimited && currentUsage.remaining <= 0) {
      setPaywallOpen(true);
      return {
        allowed: false,
        reason: 'limit_reached',
        message: currentUsage.signedIn
          ? 'Your free account has used all 5 trial exports.'
          : 'Guest trial used up. Create a free account for 5 total exports.',
      };
    }

    const emailKey = normalizeEmail(current.currentEmail);
    const nextState = { ...current, accounts: { ...current.accounts } };

    if (emailKey && nextState.accounts[emailKey]) {
      nextState.accounts[emailKey] = {
        ...nextState.accounts[emailKey],
        exportsUsed: Number(nextState.accounts[emailKey].exportsUsed || 0) + 1,
        lastExportType: kind,
        lastExportAt: new Date().toISOString(),
      };
    } else {
      nextState.guestExportsUsed = Number(nextState.guestExportsUsed || 0) + 1;
    }

    localStateRef.current = nextState;
    setLocalState(nextState);
    setUsage(usageForLocalState(nextState));
    return { allowed: true };
  }

  async function recordExport(kind) {
    if (!serverConfiguredRef.current) {
      return recordLocalExport(kind);
    }

    try {
      const data = await apiFetch('/api/export/consume', {
        method: 'POST',
        body: JSON.stringify({
          exportKind: kind || 'download',
          guestId: guestIdRef.current,
        }),
      });

      if (data.configured === false) {
        setServerConfigured(false);
        return recordLocalExport(kind);
      }

      setUsage((current) => normalizeUsage(data.usage, current));
      if (!data.allowed) setPaywallOpen(true);
      return {
        allowed: Boolean(data.allowed),
        reason: data.reason,
        message: data.message,
      };
    } catch (error) {
      if (error.data?.configured === false) {
        setServerConfigured(false);
        return recordLocalExport(kind);
      }
      const message = error.data?.message || error.message || 'Export access check failed.';
      setAuthMessage(message);
      setPaywallOpen(true);
      return {
        allowed: false,
        reason: 'access_check_failed',
        message,
      };
    }
  }

  useEffect(() => {
    function handleBuilderMessage(event) {
      const payload = event.data || {};
      if (payload.type !== 'SMART_SHEET_EXPORT_REQUEST') return;

      recordExport(payload.exportKind || 'download').then((result) => {
        event.source?.postMessage(
          {
            type: 'SMART_SHEET_EXPORT_RESPONSE',
            requestId: payload.requestId,
            ...result,
          },
          event.origin
        );
      });
    }

    window.addEventListener('message', handleBuilderMessage);
    return () => window.removeEventListener('message', handleBuilderMessage);
  }, []);

  const remainingText = usage.unlimited ? 'Unlimited' : `${usage.remaining} left`;
  const modeText = serverConfigured ? 'Server protected' : 'Local test mode';
  const modalTitle = usage.remaining <= 0 && !usage.unlimited ? 'Trial limit reached' : 'Account access';

  return (
    <main className="app-shell">
      <section className="access-bar">
        <div>
          <p className="access-kicker">Smart Sheet Builder V5.3B</p>
          <h1>Export access</h1>
          <p>
            Guest users get 2 free exports. Free registered accounts get 5 total exports.
            PNG/TIFF download is counted as usage.
          </p>
        </div>
        <div className="usage-card">
          <span>{usage.label}</span>
          <strong>{remainingText}</strong>
          <small>{usage.signedIn ? usage.email : 'Not signed in'}</small>
          <small>{busy ? 'Checking...' : modeText}</small>
        </div>
        <button className="access-button" type="button" onClick={() => setPaywallOpen(true)}>
          {usage.signedIn ? 'Account' : 'Sign in / Register'}
        </button>
        {usage.signedIn && (
          <button className="access-button ghost" type="button" onClick={signOut}>
            Sign out
          </button>
        )}
      </section>

      <iframe
        className="builder-frame"
        src="/builder.html"
        title="Smart Sheet Builder by Master PrintLab"
      />

      {paywallOpen && (
        <section className="access-modal" role="dialog" aria-modal="true">
          <div className="access-modal-card">
            <button className="modal-close" type="button" onClick={() => setPaywallOpen(false)}>
              x
            </button>
            <p className="access-kicker">Master PrintLab access</p>
            <h2>{modalTitle}</h2>
            <p className="modal-copy">
              Register free to unlock 5 total trial exports. Supabase mode keeps the account
              and export counter on the server.
            </p>

            {!serverConfigured && (
              <div className="setup-warning">
                Supabase env vars are not configured yet, so this preview is using local test mode.
              </div>
            )}

            <form className="auth-form" onSubmit={handleAuth}>
              <div className="auth-tabs">
                <button
                  type="button"
                  className={authMode === 'register' ? 'active' : ''}
                  onClick={() => setAuthMode('register')}
                >
                  Register
                </button>
                <button
                  type="button"
                  className={authMode === 'login' ? 'active' : ''}
                  onClick={() => setAuthMode('login')}
                >
                  Sign in
                </button>
              </div>
              <label>
                Email
                <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
              </label>
              <label>
                Password
                <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
              </label>
              <button type="submit" disabled={busy}>
                {busy ? 'Please wait...' : authMode === 'register' ? 'Create free account' : 'Sign in'}
              </button>
            </form>

            {authMessage && <p className="auth-message">{authMessage}</p>}

            <div className="coming-soon-box">
              <strong>Prepared next:</strong> subscriptions, credits, admin controls, and
              subscriber-only free design library tables.
            </div>
          </div>
        </section>
      )}

      <noscript>
        <div className="noscript-message">
          Smart Sheet Builder needs JavaScript enabled to arrange and export sheets.
        </div>
      </noscript>
    </main>
  );
}
