const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const base = process.env.SMART_SHEET_TEST_URL || 'http://localhost:3000';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ssb-password-ui-'));
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let changes = 0, resets = 0, verifies = 0;
    const success = 'If an account exists for this email, we sent a password reset link. Please check your inbox and spam folder.';
    await page.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url()), body = request.postDataJSON();
      const token = request.headers().authorization;
      if (url.pathname === '/api/auth/password/request') return route.fulfill({ json: { message: success, retryAfter: 60 } });
      if (url.pathname === '/api/auth/password/verify') { verifies++; return body.code === 'valid-code' ? route.fulfill({ json: { ready: true } }) : route.fulfill({ status: 401, json: { message: 'This recovery link is invalid, expired, or already used. Request a new reset link.' } }); }
      if (url.pathname === '/api/auth/password/reset') { resets++; return route.fulfill({ json: { message: 'Password changed successfully' } }); }
      if (url.pathname === '/api/auth/password/change') { changes++; return body.currentPassword === 'correct-current' ? route.fulfill({ json: { message: 'Password changed successfully' } }) : route.fulfill({ status: 400, json: { message: 'Current password could not be verified. Check it and try again.' } }); }
      if (url.pathname === '/api/auth/profile') return route.fulfill({ json: { profile: { full_name: 'Test User', business_name: '', mobile: '', city: '', country: '', machine_type: '', monthly_usage: '' } } });
      return route.fulfill({ json: { configured: true, usage: { signedIn: Boolean(token), email: token ? 'test@example.test' : '', label: token ? 'Free account' : 'Guest trial', remaining: token ? 5 : 2, used: 0, unlimited: false, isSuperAdmin: false } } });
    });
    await page.goto(`${base}/?signin=1`);
    await page.getByRole('button', { name: 'Forgot password?', exact: true }).click();
    await page.getByLabel('Email address', { exact: true }).fill('known@example.test');
    await page.getByRole('button', { name: 'Send reset link', exact: true }).click();
    await page.getByText(success, { exact: true }).waitFor();
    assert(await page.getByRole('button', { name: /Resend in/ }).isDisabled());
    assert(await page.locator('.access-modal-card').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: path.join(output, 'request-mobile.png') });
    await page.getByRole('button', { name: 'Back to Sign In' }).click();
    await page.getByLabel('Password', { exact: true }).waitFor();
    await page.goto(`${base}/reset-password?code=expired`);
    await page.getByRole('button', { name: 'Request a new reset link' }).click();
    await page.getByLabel('Email address').waitFor();
    // Open the next link as a new page visit, not a same-document hash change.
    await page.goto(base);
    await page.goto(`${base}/reset-password#access_token=ordinary-session&type=recovery`);
    await page.getByRole('button', { name: 'Request a new reset link' }).waitFor();
    assert.equal(new URL(page.url()).hash, '');
    const before = verifies;
    await page.goto(`${base}/reset-password?code=valid-code`);
    await page.getByRole('button', { name: 'Set new password' }).waitFor();
    assert.equal(verifies, before + 1, 'StrictMode must exchange the single-use code once');
    assert.equal(new URL(page.url()).search, '');
    await page.getByLabel('New password', { exact: true }).fill('short');
    await page.getByLabel('Confirm new password', { exact: true }).fill('short');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await page.getByText('Use at least 8 characters for your new password.', { exact: true }).waitFor();
    await page.getByLabel('New password', { exact: true }).fill('longer-password-123');
    await page.getByLabel('Confirm new password', { exact: true }).fill('mismatch-password');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await page.getByText('The new passwords do not match.', { exact: true }).waitFor(); assert.equal(resets, 0);
    await page.getByLabel('Confirm new password', { exact: true }).fill('longer-password-123');
    await page.screenshot({ path: path.join(output, 'reset-mobile.png') });
    await page.getByRole('button', { name: 'Set new password' }).click();
    await page.getByText('Password changed successfully', { exact: true }).waitFor(); assert.equal(resets, 1);
    await page.waitForURL(`${base}/`); await page.getByRole('button', { name: 'Forgot password?', exact: true }).waitFor();
    await page.evaluate(() => localStorage.setItem('smart-sheet-builder-v53b-session', JSON.stringify({ accessToken: 'user-token', user: { email: 'test@example.test' } })));
    await page.reload();
    await page.locator('.access-reveal-handle').hover(); await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.locator('.account-security summary').click();
    await page.getByLabel('Current password', { exact: true }).fill('wrong-current');
    await page.getByLabel('New password', { exact: true }).fill('longer-password-123');
    await page.getByLabel('Confirm new password', { exact: true }).fill('longer-password-123');
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await page.getByText('Current password could not be verified. Check it and try again.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Current password', { exact: true }).inputValue(), '');
    await page.getByLabel('Current password', { exact: true }).fill('correct-current');
    await page.getByLabel('New password', { exact: true }).fill('new-password-456');
    await page.getByLabel('Confirm new password', { exact: true }).fill('new-password-456');
    await page.screenshot({ path: path.join(output, 'change-mobile.png') });
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await page.getByText('Password changed successfully. Sign in with your new password.', { exact: true }).waitFor();
    assert.equal(changes, 2); assert.equal(await page.evaluate(() => localStorage.getItem('smart-sheet-builder-v53b-session')), null);
    assert(!await page.evaluate(() => JSON.stringify(localStorage).includes('new-password-456')));
    assert.deepEqual(errors, []);
    console.log(`PASS: recovery request/cooldown, invalid link, single exchange, inline length/match errors, successful reset/sign-in, current password failure, signed-in change/sign-out, no stored passwords, mobile. Screenshots: ${output}`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
