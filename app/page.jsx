'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const STORAGE_KEY = 'smart-sheet-builder-v53-access';
const GUEST_LIMIT = 2;
const REGISTERED_LIMIT = 5;

function makeDefaultState() {
  return {
    guestExportsUsed: 0,
    currentEmail: '',
    accounts: {},
  };
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getAdminEmails() {
  return String(process.env.NEXT_PUBLIC_SMART_SHEET_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
}

function usageForState(state) {
  const email = normalizeEmail(state.currentEmail);
  const account = email ? state.accounts[email] : null;

  if (account?.plan === 'admin' || account?.plan === 'subscriber') {
    return {
      email,
      label: account.plan === 'admin' ? 'Admin' : 'Subscribed',
      limit: Infinity,
      used: Number(account.exportsUsed || 0),
      remaining: Infinity,
      signedIn: Boolean(email),
      unlimited: true,
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
  };
}

export default function HomePage() {
  const [accessState, setAccessState] = useState(makeDefaultState);
  const [ready, setReady] = useState(false);
  const [authMode, setAuthMode] = useState('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [paywallOpen, setPaywallOpen] = useState(false);
  const accessStateRef = useRef(accessState);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        setAccessState({
          ...makeDefaultState(),
          ...parsed,
          accounts: parsed.accounts || {},
        });
      }
    } catch {
      setAccessState(makeDefaultState());
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    accessStateRef.current = accessState;
    if (ready) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(accessState));
    }
  }, [accessState, ready]);

  const usage = useMemo(() => usageForState(accessState), [accessState]);

  function saveAccount(nextEmail, nextAccount) {
    setAccessState((current) => ({
      ...current,
      currentEmail: nextEmail,
      accounts: {
        ...current.accounts,
        [nextEmail]: nextAccount,
      },
    }));
  }

  function handleAuth(event) {
    event.preventDefault();
    const cleanEmail = normalizeEmail(email);
    const cleanPassword = String(password || '');
    const adminEmails = getAdminEmails();

    if (!cleanEmail || !cleanPassword) {
      setAuthMessage('Enter your email and password.');
      return;
    }

    const current = accessStateRef.current;
    const existing = current.accounts[cleanEmail];

    if (authMode === 'login') {
      if (!existing || existing.password !== cleanPassword) {
        setAuthMessage('Account not found yet. Create a free account first.');
        return;
      }
      setAccessState((state) => ({ ...state, currentEmail: cleanEmail }));
      setAuthMessage('Signed in. Your free account can export up to 5 total files.');
      setPaywallOpen(false);
      return;
    }

    if (existing) {
      setAuthMessage('This email already exists. Switch to Sign in.');
      return;
    }

    const plan = adminEmails.includes(cleanEmail) ? 'admin' : 'free';
    const importedGuestUses = Math.min(Number(current.guestExportsUsed || 0), REGISTERED_LIMIT);

    saveAccount(cleanEmail, {
      email: cleanEmail,
      password: cleanPassword,
      plan,
      exportsUsed: plan === 'admin' ? 0 : importedGuestUses,
      createdAt: new Date().toISOString(),
    });
    setAuthMessage(
      plan === 'admin'
        ? 'Admin account ready. Unlimited exports enabled.'
        : 'Free account created. You now have 5 total trial exports.'
    );
    setPaywallOpen(false);
  }

  function signOut() {
    setAccessState((current) => ({ ...current, currentEmail: '' }));
    setAuthMessage('');
  }

  function recordExport(kind) {
    const current = accessStateRef.current;
    const currentUsage = usageForState(current);

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

    accessStateRef.current = nextState;
    setAccessState(nextState);
    return { allowed: true };
  }

  useEffect(() => {
    function handleBuilderMessage(event) {
      const payload = event.data || {};
      if (payload.type !== 'SMART_SHEET_EXPORT_REQUEST') return;

      const result = recordExport(payload.exportKind || 'download');
      event.source?.postMessage(
        {
          type: 'SMART_SHEET_EXPORT_RESPONSE',
          requestId: payload.requestId,
          ...result,
        },
        event.origin
      );
    }

    window.addEventListener('message', handleBuilderMessage);
    return () => window.removeEventListener('message', handleBuilderMessage);
  }, []);

  const remainingText = usage.unlimited ? 'Unlimited' : `${usage.remaining} left`;

  return (
    <main className="app-shell">
      <section className="access-bar">
        <div>
          <p className="access-kicker">Smart Sheet Builder V5.3A</p>
          <h1>Export access</h1>
          <p>
            Guest users get 2 free exports. Free registered accounts get 5 total exports.
            PNG/TIFF download is counted as usage.
          </p>
        </div>
        <div className="usage-card">
          <span>{usage.label}</span>
          <strong>{remainingText}</strong>
          <small>
            {usage.signedIn ? usage.email : 'Not signed in'}
          </small>
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
              ×
            </button>
            <p className="access-kicker">Master PrintLab access</p>
            <h2>{usage.remaining <= 0 && !usage.unlimited ? 'Trial limit reached' : 'Account access'}</h2>
            <p className="modal-copy">
              Register free to unlock 5 total trial exports. Subscription and credits will be added
              in the next phase.
            </p>

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
              <button type="submit">{authMode === 'register' ? 'Create free account' : 'Sign in'}</button>
            </form>

            {authMessage && <p className="auth-message">{authMessage}</p>}

            <div className="coming-soon-box">
              <strong>Coming next:</strong> subscription, credits, admin dashboard, and subscriber-only
              free design library.
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
