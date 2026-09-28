const { chromium } = require('playwright'),
  { fixture, png } = require('./client-jobs.test.cjs'),
  { NextRequest } = require('next/server'),
  { PNG } = require('pngjs'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const base = process.env.SMART_SHEET_TEST_URL || 'http://localhost:3114',
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'client-jobs-ui-'));
const jwt = (user) =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), role: 'authenticated' })).toString('base64url')}.test-signature`;
(async () => {
  const f = await fixture(),
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  let loseConsume = true;
  const consumedKeys = [];
  try {
    const token = await f.portal('basic', { widthIn: 3, lengthIn: 3 });
    async function pageFor(user) {
      const context = await browser.newContext({ hasTouch: true }),
        page = await context.newPage({
          viewport: { width: 1360, height: 900 }
        });
      page.on('pageerror', (e) => errors.push(e.message));
      if (user)
        await context.addInitScript(
          ({ u, token }) =>
            localStorage.setItem(
              'smart-sheet-builder-v53b-session',
              JSON.stringify({
                accessToken: token,
                refreshToken: 'fixture-refresh',
                user: u
              })
            ),
          { u: f.users[user], token: jwt(f.users[user]) }
        );
      await page.route('**/auth/v1/**', (r) =>
        r.fulfill({
          json: r.request().url().includes('/token')
            ? {
                access_token: jwt(f.users[user]),
                refresh_token: 'fixture-refresh',
                expires_in: 3600,
                token_type: 'bearer',
                user: f.users[user]
              }
            : f.users[user]
        })
      );
      await page.route('**/api/**', async (r) => {
        const rr = r.request(),
          u = new URL(rr.url()),
          headers = await rr.allHeaders();
        if (headers.authorization && user)
          headers.authorization = `Bearer ${user}`;
        const req = new NextRequest(rr.url(), {
          method: rr.method(),
          headers,
          ...(rr.method !== 'GET' && rr.postDataBuffer()
            ? { body: rr.postDataBuffer() }
            : {})
        });
        let result;
        const match = u.pathname.match(
            /^\/api\/client-jobs\/([^/]+)\/files\/([^/]+)$/
          ),
          pub = u.pathname.match(/^\/api\/client-upload\/([^/]+)$/);
        if (pub)
          result = await f.pub[rr.method()](req, { params: { token: pub[1] } });
        else if (match)
          result = await f.files.GET(req, {
            params: { id: match[1], file: match[2] }
          });
        else if (u.pathname === '/api/client-jobs')
          result = await f.owner[rr.method()](req);
        else if (u.pathname === '/api/auth/me') result = await f.me.GET(req);
        else if (u.pathname === '/api/export/status')
          result = await f.status.GET(req);
        else if (u.pathname === '/api/export/consume') {
          result = await f.consume.POST(req);
          if (rr.postDataJSON().action === 'consume') {
            consumedKeys.push(rr.postDataJSON().requestKey);
            if (loseConsume) {
              loseConsume = false;
              return r.fulfill({
                status: 503,
                json: { message: 'Simulated lost debit response' }
              });
            }
          }
        } else
          result = Response.json({
            history: [],
            profile: {},
            credits: { balance: 2 }
          });
        await r.fulfill({
          status: result.status,
          headers: Object.fromEntries(result.headers),
          body: Buffer.from(await result.arrayBuffer())
        });
      });
      return { page, context };
    }
    const customer = await pageFor();
    await customer.page.goto(`${base}/client-upload/${token}`);
    await customer.page.getByRole('heading', { name: 'Test shop' }).waitFor();
    assert.equal(
      await customer.page
        .getByRole('button', {
          name: /Edit Background|Optimize for Print|Download|Convert to TIFF|Sign in/
        })
        .count(),
      0
    );
    await customer.page.locator('input[type=file]').setInputFiles([
      { name: 'soft-edge.png', mimeType: 'image/png', buffer: png() },
      { name: 'logo.png', mimeType: 'image/png', buffer: png(80, 40) }
    ]);
    await customer.page.locator('.client-file').nth(1).waitFor();
    await customer.page
      .getByLabel('Quantity', { exact: true })
      .first()
      .fill('2');
    await customer.page
      .getByLabel('Quantity', { exact: true })
      .nth(1)
      .fill('3');
    await customer.page
      .getByLabel('Client reference / order name (optional)')
      .fill('Browser jersey order');
    await customer.page
      .getByRole('button', { name: 'Generate Print Preview', exact: true })
      .click();
    await customer.page.locator('.client-preview canvas').waitFor();
    assert.match(
      await customer.page.locator('.client-columns').innerText(),
      /5 pieces · 0.076 m/
    );
    await customer.page.setViewportSize({ width: 375, height: 812 });
    assert(
      await customer.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    );
    await customer.page.screenshot({
      path: path.join(out, 'customer-mobile.png'),
      fullPage: true
    });
    await customer.page
      .getByRole('button', { name: 'Confirm & Send to Shop' })
      .click();
    await customer.page
      .getByRole('heading', { name: 'Submission confirmed' })
      .waitFor();
    assert.equal(f.emails.length, 1);
    const job = await f.one('select * from client_jobs where reference=$1', [
      'Browser jersey order'
    ]);
    assert.equal(job.quantity, 5);
    const owner = await pageFor('basic');
    await owner.page.goto(`${base}/?clientJob=${job.id}`);
    await owner.page.getByRole('dialog', { name: 'Client Portal' }).waitFor();
    await owner.page.locator('.client-preview canvas').waitFor();
    await owner.page.getByRole('button', { name: 'Close Client Portal' }).click();
    await owner.page.locator('.access-reveal-handle').hover();
    await owner.page.locator('.access-actions > .client-portal-trigger').waitFor();
    await owner.page.waitForFunction(() => document.querySelector('.access-actions').getBoundingClientRect().top >= 0);
    const header = await owner.page.locator('.access-actions').evaluate(el => {
      const buttons = [...el.children].filter(e => e.tagName === 'BUTTON');
      return buttons.map(b => { const r=b.getBoundingClientRect(); return {text:b.textContent, x:r.x,y:r.y,height:r.height,position:getComputedStyle(b).position}; });
    });
    assert.equal(header.length, 3);
    assert.match(header[0].text, /^Client Portal/);
    assert.equal(header[1].text, 'Account & exports');
    assert.equal(header[2].text, 'Sign out');
    assert(header.every(b => b.position === 'static' && b.height === 40 && Math.abs(b.y-header[0].y)<1));
    assert(header[0].x < header[1].x && header[1].x < header[2].x);
    assert.equal(await owner.page.locator('.client-portal-trigger').count(), 1);
    assert.equal(await owner.page.locator('.client-jobs-handle').count(), 0);
    await owner.page.screenshot({path:path.join(out,'header-desktop.png'),fullPage:true});
    await owner.page.setViewportSize({width:375,height:812});
    await owner.page.mouse.move(370,700);
    await owner.page.locator('.access-reveal-handle').tap();
    await owner.page.waitForFunction(() => document.querySelector('#builder-access-bar').hasAttribute('inert'));
    assert(await owner.page.locator('.client-portal-trigger').evaluate(el => !!el.closest('[inert]')));
    await owner.page.locator('.access-reveal-handle').tap();
    await owner.page.waitForFunction(() => !document.querySelector('#builder-access-bar').hasAttribute('inert'));
    await owner.page.waitForFunction(() => document.querySelector('.access-bar').getBoundingClientRect().top >= -0.1);
    assert(await owner.page.locator('.client-portal-trigger').evaluate(el => !!el.closest('#builder-access-bar .access-actions')));
    assert(await owner.page.locator('.client-portal-trigger').evaluate(el => {const r=el.getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight;}));
    assert(await owner.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await owner.page.screenshot({path:path.join(out,'header-mobile-menu.png'),fullPage:true});
    await owner.page.setViewportSize({width:1360,height:900});
    await owner.page.locator('.access-reveal-handle').hover();
    await owner.page.getByRole('button', { name: /^Client Portal/ }).click();
    await owner.page.locator('.client-preview canvas').waitFor();
    await owner.page.getByText('Portal link active', { exact: true }).waitFor();
    const originalLink = await owner.page.getByLabel('Client upload link').inputValue();
    assert.equal(new URL(originalLink).origin, new URL(base).origin);
    assert.equal(new URL(originalLink).pathname, '/client-upload/' + token);
    await owner.page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedPortalLink = text; } } }));
    await owner.page.getByRole('button', { name: 'Copy link', exact: true }).click();
    assert.equal(await owner.page.evaluate(() => window.copiedPortalLink), originalLink);
    assert.equal(
      await owner.page.getByRole('button', { name: /^Client Portal/ }).count(),
      1
    );
    await owner.page.screenshot({
      path: path.join(out, 'owner-desktop.png'),
      fullPage: true
    });
    // Original builder iframe stays intact while a separate export instance rebuilds the manifest.
    const iframe = owner.page
      .frames()
      .find((fr) => fr.url().includes('clientJob=1'));
    await iframe.waitForFunction(() => window.smartSheetClientJob);
    await owner.page
      .getByRole('button', { name: 'Download Final PNG', exact: true })
      .click();
    await owner.page
      .getByRole('alert')
      .filter({ hasText: /temporarily unavailable/ })
      .waitFor();
    assert.equal(
      (
        await f.one(
          'select balance from free_export_credits where user_id=$1',
          [f.users.basic.id]
        )
      ).balance,
      1
    );
    const pngDownload = owner.page.waitForEvent('download');
    await owner.page
      .getByRole('button', { name: 'Download Final PNG', exact: true })
      .click();
    const saved = await pngDownload.catch(async (e) => {
      console.log(
        'EXPORT DEBUG',
        await owner.page.locator('[role=alert]').allTextContents(),
        await iframe.locator('#clientJobExportStatus').textContent(),
        errors
      );
      throw e;
    });
    const output = PNG.sync.read(fs.readFileSync(await saved.path()));
    assert.equal(
      consumedKeys[0],
      consumedKeys[1],
      'same locked manifest keeps uncertain-debit retry key across reconstruction'
    );
    assert.equal(output.width, 900);
    assert.equal(output.height, 900);
    const p = job.manifest.sheets[0].placements.find(
        (p) => p.assetId === job.assets[0].id
      ),
      a = (x, y) => output.data[((p.y + y) * 900 + p.x + x) * 4 + 3];
    assert.equal(a(0, 0), 0);
    assert.equal(a(1, 2), 4);
    assert.equal(a(3, 2), 255);
    assert(
      (
        await f.one('select downloaded_png from client_jobs where id=$1', [
          job.id
        ])
      ).downloaded_png
    );
    const tiffDownload = owner.page.waitForEvent('download');
    await owner.page
      .getByRole('button', { name: 'Convert to TIFF', exact: true })
      .click();
    await iframe.locator('#dtfCheckConfirm').click();
    const td = await tiffDownload,
      bytes = fs.readFileSync(await td.path());
    assert.equal(bytes.toString('ascii', 0, 2), 'II');
    const ifd = bytes.readUInt32LE(4),
      tags = {};
    for (let n = 0; n < bytes.readUInt16LE(ifd); n++) {
      let at = ifd + 2 + n * 12;
      tags[bytes.readUInt16LE(at)] = bytes.readUInt32LE(at + 8);
    }
    assert.equal(tags[256], 900);
    assert.equal(tags[257], 900);
    assert(bytes.includes(Buffer.from('W1')));
    assert(
      (
        await f.one('select downloaded_tiff from client_jobs where id=$1', [
          job.id
        ])
      ).downloaded_tiff
    );
    assert.equal(
      (
        await f.one(
          'select balance from free_export_credits where user_id=$1',
          [f.users.basic.id]
        )
      ).balance,
      0
    );
    await owner.page
      .getByRole('button', { name: 'Download Final PNG', exact: true })
      .click();
    await owner.page
      .getByRole('alert')
      .filter({ hasText: /credits/ })
      .waitFor();
    assert.equal(
      (
        await f.one(
          'select count(*)::int n from usage_exports where user_id=$1',
          [f.users.basic.id]
        )
      ).n,
      2
    );
    await owner.page.setViewportSize({ width: 375, height: 812 });
    await owner.page.screenshot({
      path: path.join(out, 'owner-mobile.png'),
      fullPage: true
    });
    assert(
      await owner.page
        .locator('dialog')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    );
    await f.q(
      "update client_jobs set expires_at=clock_timestamp()+interval '8 seconds' where id=$1",
      [job.id]
    );
    await owner.page.goto(`${base}/?clientJob=${job.id}`);
    await owner.page.getByRole('button', { name: 'Download Final PNG', exact: true }).waitFor();
    await owner.page.getByRole('button', { name: 'Download Final PNG', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    assert.equal(await owner.page.locator('dialog .client-preview canvas').count(), 0);
    await owner.page.getByRole('button', { name: 'Close Client Portal' }).click();
    await owner.page.locator('.access-reveal-handle').hover();
    await owner.page.getByRole('button', { name: /^Client Portal/ }).click();
    await owner.page.getByText('Expired — files are no longer available. · Expired', { exact: true }).waitFor();
    assert(f.objects.size > 0, 'opening Client Portal does not invoke physical cleanup');
    const maintenance = await f.maintenance.GET(
      new NextRequest('https://shop.test/api/client-jobs/maintenance', {
        headers: { authorization: 'Bearer test-maintenance' }
      })
    );
    assert.equal(maintenance.status, 200);
    assert.equal(f.objects.size, 0, 'daily cron purges expired private files');
    owner.page.once('dialog', d => d.accept());
    await owner.page.getByRole('button', { name: 'Disable link', exact: true }).click();
    await owner.page.getByText('Portal link setup required', { exact: true }).waitFor();
    await customer.page.goto(`${base}/client-upload/${token}`);
    await customer.page.getByRole('alert').filter({ hasText: 'This upload portal is currently disabled.' }).waitFor();
    assert.equal(await customer.page.locator('input[type=file]').count(), 0);
    await owner.page.getByRole('button', { name: 'Create/Enable link', exact: true }).click();
    await owner.page.getByText('Portal link active', { exact: true }).waitFor();
    owner.page.once('dialog', d => d.accept());
    await owner.page.getByRole('button', { name: 'Regenerate link', exact: true }).click();
    await owner.page.waitForFunction(old => document.querySelector('input[aria-label="Client upload link"]').value !== old, originalLink);
    const nextToken = (await owner.page.getByLabel('Client upload link').inputValue()).split('/').at(-1);
    await customer.page.reload();
    await customer.page.getByRole('alert').filter({ hasText: 'invalid or has been replaced' }).waitFor();
    await customer.page.goto(`${base}/client-upload/${nextToken}`);
    await customer.page.getByRole('heading', { name: 'Test shop' }).waitFor();
    await owner.page.getByRole('button', { name: 'Close Client Portal' }).click();
    await customer.context.close();
    await owner.context.close();
    assert.deepEqual(errors, []);
    console.log(
      'PASS: real customer multi-PNG/quantities/read-only mobile preview/confirm + owner deep link, real full-resolution PNG(alpha0/4/255)/DTF W1 TIFF(900×900), exact locked source pixels, normal credit debit/exhaustion; no page errors. Screenshots:',
      out
    );
  } finally {
    await browser.close();
    await f.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
