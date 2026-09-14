const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.SMART_SHEET_TEST_URL || 'http://localhost:3000';
const localKey = 'smart-sheet-builder-v53b-local-test';
const sessionKey = 'smart-sheet-builder-v53b-session';
const owner = 'masterprintlabcorp@gmail.com';
const password = 'test-only-password';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    async function createPage(server = false, identity = 'owner') {
      const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        if (!server) return route.fulfill({ status: 501, json: { configured: false, message: 'Supabase env vars are not configured' } });
        const guest = { label: 'Guest trial', signedIn: false, remaining: 2, limit: 2, used: 0, plan: 'guest' };
        const isAdmin = identity !== 'basic', canManageLibrary = identity === 'owner';
        const user = { label: isAdmin ? 'Admin' : 'Basic account', email: canManageLibrary ? owner : identity === 'basic' ? 'mpl.smartsheetbuilder@gmail.com' : 'other-admin@example.test', signedIn: true, unlimited: true, remaining: null, limit: null, used: 12, plan: isAdmin ? 'admin' : 'free', isAdmin, canManageLibrary };
        if (url.pathname === '/api/auth/me') return route.fulfill({ json: { configured: true, usage: user } });
        if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/register') return route.fulfill({ json: { configured: true, session: { accessToken: 'mock-validated-token', user: { email: owner } }, usage: user } });
        if (url.pathname === '/api/library') return route.fulfill({ json: { configured: true, canManageLibrary, designs: [], categories: [] } });
        if (url.pathname === '/api/export/consume') return route.fulfill({ json: { configured: true, allowed: true, usage: user } });
        return route.fulfill({ json: { configured: true, usage: guest } });
      });
      await page.goto(base); await page.locator('.usage-card').getByText(server ? 'Server protected' : 'Local test mode').waitFor();
      return page;
    }
    const entry = page => page.frameLocator('iframe').locator('#openDesignLibrary');
    const workspace = page => page.locator('.builder-workspace.is-open');
    async function closeLibrary(page) { await page.getByRole('button', { name: 'Close Design Library' }).click(); }
    async function enterCredentials(page, email = owner) {
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.locator('.auth-form button[type=submit]').click();
    }
    async function exportRequest(page) {
      return page.frames().find(f => f.url().includes('builder.html')).evaluate(() => new Promise(resolve => {
        const requestId = crypto.randomUUID();
        function done(e) { if (e.data?.requestId === requestId) { removeEventListener('message', done); resolve(e.data); } }
        addEventListener('message', done);
        parent.postMessage({ type: 'SMART_SHEET_EXPORT_REQUEST', requestId, exportKind: 'png' }, location.origin);
      }));
    }
    const local = await createPage();
    await local.evaluate(({ localKey, owner, password }) => localStorage.setItem(localKey, JSON.stringify({ guestExportsUsed: 0, currentEmail: owner, accounts: { [owner]: { email: owner, password, plan: 'admin', exportsUsed: 0 } } })), { localKey, owner, password });
    await local.reload(); await local.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    assert.match(await local.locator('.usage-card').innerText(), /Admin\nUnlimited/);
    await entry(local).click(); await workspace(local).waitFor(); assert.equal(await local.locator('.access-modal').count(), 0);
    await local.getByText('Manage library', { exact: false }).click();
    assert(await local.locator('.library-admin-fields').evaluate(el => el.disabled), 'local admin has management identity without a server bypass');
    await closeLibrary(local);
    for (let i = 0; i < 6; i++) assert((await exportRequest(local)).allowed, 'owner stays unlimited');
    await local.getByRole('button', { name: 'Account', exact: true }).click(); assert.equal(await local.locator('.auth-form').count(), 0);
    await local.getByRole('button', { name: 'Close account' }).click();
    await local.getByRole('button', { name: 'Sign out', exact: true }).click();
    assert.equal(await local.evaluate(k => JSON.parse(localStorage.getItem(k)).currentEmail, localKey), '');
    await entry(local).click(); await local.locator('.auth-form').waitFor();
    assert.equal(await local.getByLabel('Email', { exact: true }).inputValue(), '');
    assert.equal(await local.getByLabel('Password', { exact: true }).inputValue(), '');
    assert(!/env vars|Supabase/.test(await local.locator('.access-modal').innerText()));
    await enterCredentials(local); await workspace(local).waitFor();
    await closeLibrary(local); await local.reload(); await local.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    await entry(local).click(); await workspace(local).waitFor(); await closeLibrary(local);
    await local.getByRole('button', { name: 'Sign out', exact: true }).click(); await local.reload();
    await local.locator('.usage-card').getByText('Local test mode').waitFor(); assert.equal(await local.getByRole('button', { name: 'Sign out', exact: true }).count(), 0);
    assert((await exportRequest(local)).allowed); assert((await exportRequest(local)).allowed); assert.equal((await exportRequest(local)).allowed, false);
    await local.getByRole('button', { name: 'Close account' }).click(); await entry(local).click();
    await local.getByRole('tab', { name: 'Create account', exact: true }).click();
    await enterCredentials(local, 'new-user@example.test'); await workspace(local).waitFor(); await closeLibrary(local);
    assert.match(await local.locator('.usage-card').innerText(), /3 left/, 'registration preserves imported guest usage');
    assert((await exportRequest(local)).allowed); assert((await exportRequest(local)).allowed); assert((await exportRequest(local)).allowed); assert.equal((await exportRequest(local)).allowed, false);
    await local.close();

    const server = await createPage(true);
    await entry(server).click(); await server.locator('.auth-form').waitFor(); await enterCredentials(server); await workspace(server).waitFor();
    await closeLibrary(server); await server.reload(); await server.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    await entry(server).click(); await workspace(server).waitFor(); assert.equal(await server.locator('.access-modal').count(), 0);
    await closeLibrary(server); await server.getByRole('button', { name: 'Sign out', exact: true }).click();
    assert.equal(await server.evaluate(k => localStorage.getItem(k), sessionKey), null);
    await entry(server).click(); await server.locator('.auth-form').waitFor(); await server.getByRole('tab', { name: 'Create account', exact: true }).click();
    await enterCredentials(server); await workspace(server).waitFor(); await server.close();
    for (const identity of ['basic', 'other']) {
      const page = await createPage(true, identity);
      await entry(page).click(); await enterCredentials(page, identity === 'basic' ? 'mpl.smartsheetbuilder@gmail.com' : 'other-admin@example.test');
      await workspace(page).waitFor();
      assert.equal(await page.locator('.library-admin').count(), 0);
      assert.equal(await page.getByText('Show hidden', { exact: true }).count(), 0);
      await closeLibrary(page);
      assert.match(await page.locator('.usage-card').innerText(), identity === 'basic' ? /Basic account\nUnlimited/ : /Admin\nUnlimited/);
      for (let i = 0; i < 7; i++) assert((await exportRequest(page)).allowed);
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      const account = await page.locator('.access-modal').innerText();
      assert.match(account, /Unlimited/); if (identity === 'basic') assert(!account.includes('Admin'));
      await page.getByRole('button', { name: 'Close account' }).click();
      await page.reload(); await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
      await entry(page).click(); await workspace(page).waitFor();
      assert.equal(await page.locator('.library-admin').count(), 0);
      await closeLibrary(page); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await entry(page).click(); await page.locator('.auth-form').waitFor();
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log('Auth checks passed: local owner direct library access and refresh, guest gate, login/register continuation, sign-out persistence, empty credentials/account summary, local 2/5 export limits, mocked Supabase owner/basic-unlimited/other-admin display and library permissions, login/register/session restore/sign-out.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
