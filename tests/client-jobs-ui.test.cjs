const { chromium } = require('playwright'),
  { fixture, png } = require('./client-jobs.test.cjs'),
  { NextRequest } = require('next/server'),
  { PNG } = require('pngjs'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const base = process.env.SMART_SHEET_TEST_URL || 'http://localhost:3114',
  out = process.env.SMART_SHEET_SCREENSHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'client-jobs-ui-'));
fs.mkdirSync(out, { recursive: true });
const jwt = (user) =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), role: 'authenticated' })).toString('base64url')}.test-signature`;
(async () => {
  const f = await fixture(),
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  let loseConsume = true;
  let failOnePublicUpload = true;
    let previewRequests = 0, failPreview = true, failDetail = true;
  let failRotate = true, rotateAttempts = 0;
  const consumedKeys = [];
  try {
    const token = await f.portal('basic', { widthIn: 3, lengthIn: 3, edgeIn: 0.1, gapIn: 0.1 });
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
        if (pub && rr.method() === 'POST' && u.searchParams.get('action') === 'upload' && failOnePublicUpload) {
          failOnePublicUpload = false;
          return r.fulfill({
            status: 503,
            json: { message: 'Simulated upload connection failure' }
          });
        } else if (pub) {
          if (rr.method() === 'POST' && u.searchParams.get('action') === 'preview') {
            previewRequests++;
            await new Promise(resolve => setTimeout(resolve, 1200));
            if (failPreview) { failPreview = false; return r.fulfill({status:503,json:{message:'Layout service temporarily unavailable. Please retry.'}}); }
          }
          if (rr.method() === 'POST' && u.searchParams.get('action') === 'upload')
            await new Promise((resolve) => setTimeout(resolve, 250));
          result = await f.pub[rr.method()](req, { params: { token: pub[1] } });
        }
        else if (match) {
          await new Promise(resolve => setTimeout(resolve, 1200));
          result = await f.files.GET(req, {
            params: { id: match[1], file: match[2] }
          });
        }
        else if (u.pathname === '/api/client-jobs') {
          if (rr.method() === 'POST' && rr.postDataJSON().action === 'rotate') {
            rotateAttempts++;
            await new Promise(resolve => setTimeout(resolve, 400));
            if (failRotate) { failRotate=false; return r.fulfill({status:503,json:{message:'Link service temporarily unavailable. Please retry.'}}); }
          }
          if (u.searchParams.has('id') && failDetail) { failDetail=false; return r.fulfill({status:503,json:{message:'Private sources temporarily unavailable.'}}); }
          result = await f.owner[rr.method()](req);
        }
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
    await customer.page.getByRole('heading', { name: 'Legacy / Default Profile' }).waitFor();
    assert.equal(
      await customer.page
        .getByRole('button', {
          name: /Edit Background|Optimize for Print|Download|Convert to TIFF|Sign in/
        })
        .count(),
      0
    );
    await customer.page.locator('input[type=file]').setInputFiles({
      name: 'soft-edge.png',
      mimeType: 'image/png',
      buffer: png()
    });
    await customer.page.locator('.client-file').waitFor();
    await customer.page.getByText('Failed — Retry', { exact: true }).waitFor();
    assert.equal(
      await customer.page.getByRole('button', { name: 'Retry', exact: true }).count(),
      1,
      'a failed file remains available for retry without removing other uploads'
    );
    await customer.page.getByRole('button', { name: 'Retry', exact: true }).click();
    await customer.page.getByText('Uploading', { exact: true }).waitFor();
    await customer.page.getByText('Ready', { exact: true }).waitFor();
    assert(await customer.page.getByRole('button',{name:'Generate Print Preview',exact:true}).isDisabled(),'project name required before preview');
    await customer.page.screenshot({path:path.join(out,'required-project-name.png'),fullPage:true});
    await customer.page.getByLabel('Project / Client Name *',{exact:true}).fill('Browser jersey order');
    assert.equal(
      await customer.page
        .getByRole('button', { name: 'Generate Print Preview', exact: true })
        .isEnabled(),
      true,
      'preview becomes available only after the real upload reaches Ready'
    );
    assert.equal(await customer.page.locator('.client-file-thumbnail').count(), 1);
    const width = customer.page.getByRole('spinbutton', { name: 'Width (in) for soft-edge.png' });
    const height = customer.page.getByRole('spinbutton', { name: 'Height (in) for soft-edge.png' });
    const lock = customer.page.getByRole('checkbox', { name: 'Lock aspect ratio for soft-edge.png' });
    assert(await lock.isChecked());
    const aspect = Number(await width.inputValue()) / Number(await height.inputValue());
    await width.fill('0.8');
    assert(Math.abs(Number(await height.inputValue())-0.8/aspect)<0.000001);
    await height.fill('0.5');
    assert(Math.abs(Number(await width.inputValue())-0.5*aspect)<0.000001);
    await lock.uncheck();await width.fill('0.8');await height.fill('0.6');
    assert.equal(await width.inputValue(), '0.8');assert.equal(await height.inputValue(), '0.6');
    await width.fill('0');assert(await customer.page.getByRole('button',{name:'Generate Print Preview',exact:true}).isDisabled());await width.fill('0.8');
    await customer.page.screenshot({ path: path.join(out, 'client-requested-size.png') });
    assert(
      await customer.page
        .getByRole('button', { name: 'Decrease quantity for soft-edge.png' })
        .isDisabled()
    );
    await customer.page
      .getByRole('button', { name: 'Increase quantity for soft-edge.png' })
      .click();
    assert.equal(
      await customer.page
        .getByRole('spinbutton', { name: 'Quantity for soft-edge.png' })
        .inputValue(),
      '2'
    );
    await customer.page
      .getByRole('button', { name: 'Decrease quantity for soft-edge.png' })
      .click();
    await customer.page
      .getByRole('spinbutton', { name: 'Quantity for soft-edge.png' })
      .fill('0');
    assert.equal(
      await customer.page
        .getByRole('spinbutton', { name: 'Quantity for soft-edge.png' })
        .inputValue(),
      '1',
      'direct quantity entry is clamped to one'
    );
    await customer.page
      .getByRole('spinbutton', { name: 'Quantity for soft-edge.png' })
      .fill('2');
    await customer.page.clock.install();
    await customer.page
      .getByRole('button', { name: 'Generate Print Preview', exact: true })
      .click();
    await customer.page.getByText('Preparing your print layout', {exact:true}).waitFor();
    assert(await customer.page.getByRole('button',{name:'Preparing print layout…',exact:true}).isDisabled());
    await customer.page.screenshot({path:path.join(out,'client-preparing-layout.png'),fullPage:true});
    await customer.page.clock.fastForward(15001);
    await customer.page.getByText('Still preparing your layout — larger artwork can take longer.',{exact:true}).waitFor();
    await customer.page.getByRole('button',{name:'Retry preview',exact:true}).waitFor();
    assert.equal(await customer.page.locator('.client-layout-loading').count(),0);
    assert.equal(previewRequests,1,'duplicate clicks cannot start another preview request');
    assert.equal((await f.one('select count(*)::int as n from client_jobs')).n,1,'failed preview retains the original submission');
    await customer.page.getByRole('button',{name:'Retry preview',exact:true}).click();
    await customer.page.locator('.client-preview canvas').waitFor();
    await customer.page.evaluate(() => {
      const decode = window.createImageBitmap;
      window.failArtworkDecode = true;
      window.createImageBitmap = function(...args) { if (window.failArtworkDecode) return Promise.reject(Error('Temporary artwork decode failure')); return decode(...args); };
    });
    await customer.page.getByRole('button',{name:'Generate Print Preview',exact:true}).click();
    await customer.page.getByRole('button',{name:'Retry preview',exact:true}).waitFor();
    assert.equal(await customer.page.locator('.client-layout-loading').count(),0,'render failure stops animation');
    assert.equal(await customer.page.locator('.client-preview-card').getAttribute('aria-busy'),'false');
    assert(await customer.page.getByRole('button',{name:'Confirm & Send to Shop',exact:true}).isDisabled(),'failed render cannot be confirmed');
    const requestsBeforeRenderRetry = previewRequests;
    await customer.page.evaluate(() => { window.failArtworkDecode = false; });
    await customer.page.getByRole('button',{name:'Retry preview',exact:true}).click();
    await customer.page.locator('.client-preview canvas').waitFor();
    assert.equal(previewRequests,requestsBeforeRenderRetry,'render retry does not create another server layout');
    await width.fill('0.9');
    assert.equal(await customer.page.getByRole('button',{name:'Confirm & Send to Shop',exact:true}).count(),0,'size edit invalidates preview');
    await customer.page.getByRole('button',{name:'Generate Print Preview',exact:true}).click();await customer.page.locator('.client-preview canvas').waitFor();
    await customer.page.getByRole('button',{name:'Increase quantity for soft-edge.png'}).click();
    assert.equal(await customer.page.getByRole('button',{name:'Confirm & Send to Shop',exact:true}).count(),0,'quantity edit invalidates preview');
    await customer.page.getByRole('button',{name:'Decrease quantity for soft-edge.png'}).click();
    await customer.page.getByRole('button',{name:'Generate Print Preview',exact:true}).click();await customer.page.locator('.client-preview canvas').waitFor();
    assert.match(
      await customer.page.locator('.client-columns').innerText(),
      /2 pieces/
    );
    const chooserReady = customer.page.waitForEvent('filechooser');
    await customer.page
      .getByRole('button', { name: 'Add more design', exact: true })
      .click();
    const chooser = await chooserReady;
    await chooser.setFiles({
      name: 'very-long-client-filename-that-must-truncate-without-breaking-the-upload-layout.png',
      mimeType: 'image/png',
      buffer: png(80, 40)
    });
    await customer.page.locator('.client-file').nth(1).waitFor();
    await customer.page.getByText('Uploading', { exact: true }).waitFor();
    assert(
      await customer.page
        .getByRole('button', { name: /Waiting for uploads/ })
        .isDisabled(),
      'preview remains disabled while an additional real upload is in flight'
    );
    await customer.page
      .locator('.client-file')
      .nth(1)
      .getByText('Ready', { exact: true })
      .waitFor();
    assert.equal(await customer.page.locator('.client-file-thumbnail').count(), 2);
    await customer.page
      .getByRole('spinbutton', {
        name: 'Quantity for very-long-client-filename-that-must-truncate-without-breaking-the-upload-layout.png'
      })
      .fill('3');
    await customer.page
      .getByLabel('Project / Client Name *', {exact:true})
      .fill('Browser jersey order');
    await customer.page
      .getByRole('button', { name: 'Generate Print Preview', exact: true })
      .click();
    await customer.page.getByText('5 pieces · 0.076 m', { exact: true }).waitFor();
    assert.match(
      await customer.page.locator('.client-columns').innerText(),
      /5 pieces · 0.076 m/
    );
    const uploadActions = await customer.page
      .locator('.client-upload-actions button')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { text: button.textContent, x: rect.x, y: rect.y };
        })
      );
    assert.equal(uploadActions[0].text, 'Add more design');
    assert.equal(uploadActions[1].text, 'Generate Print Preview');
    assert(Math.abs(uploadActions[0].y - uploadActions[1].y) < 1);
    assert(uploadActions[0].x < uploadActions[1].x);
    await customer.page.screenshot({ path: path.join(out, 'client-upload-desktop.png'), fullPage: true });
    await customer.page.setViewportSize({ width: 1100, height: 520 });
    assert(
      await customer.page.locator('.client-page').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollHeight > el.clientHeight && el.scrollTop > 0;
      }),
      'public portal remains vertically scrollable on a short desktop viewport'
    );
    await customer.page
      .getByRole('button', { name: 'Confirm & Send to Shop' })
      .scrollIntoViewIfNeeded();
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
      .getByRole('heading', { name: 'Gang sheet submitted' })
      .waitFor();
    assert.equal(f.emails.length, 1);
    const job = await f.one('select * from client_jobs where reference=$1', [
      'Browser jersey order'
    ]);
    assert.equal(job.quantity, 5);
    assert.equal(job.assets[0].widthIn, 0.9);assert.equal(job.assets[0].heightIn, 0.6);
    assert(job.manifest.sheets.flatMap(s=>s.placements).filter(p=>p.assetId===job.assets[0].id).every(p=>p.baseW===270&&p.baseH===180));
    const configuredServices=Object.fromEntries(['RESEND_API_KEY','CLIENT_JOBS_EMAIL_FROM','CRON_SECRET'].map(key=>[key,process.env[key]]));
    for(const key of Object.keys(configuredServices)) delete process.env[key];
    const owner = await pageFor('basic');
    await owner.page.goto(`${base}/?clientJob=${job.id}`);
    await owner.page.getByRole('dialog', { name: 'Client Portal' }).waitFor();
    await owner.page.getByRole('button',{name:'Retry layout',exact:true}).waitFor();
    assert.equal(await owner.page.locator('.client-layout-loading').count(),0);
    await owner.page.getByRole('button',{name:'Retry layout',exact:true}).click();
    await owner.page.getByText('Preparing your print layout',{exact:true}).waitFor();
    assert(await owner.page.getByRole('button',{name:'View details',exact:true}).first().isDisabled());
    await owner.page.screenshot({path:path.join(out,'shop-preparing-layout.png'),fullPage:true});
    await owner.page.getByRole('button',{name:'Close Client Portal',exact:true}).click();
    assert.equal(await owner.page.locator('.client-layout-loading:visible').count(),0,'closing cancels layout loading');
    await owner.page.locator('.access-reveal-handle').hover();
    await owner.page.getByRole('button',{name:/^Client Portal/}).click();
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
    assert.equal(
      await owner.page.getByRole('button', { name: 'Copy upload link' }).count(),
      0,
      'sharing controls stay out of the main Client Portal view'
    );
    await owner.page.screenshot({ path: path.join(out, 'client-portal-desktop.png'), fullPage: true });
    await owner.page.getByRole('button', { name: 'Shop portal settings' }).click();
    await owner.page.getByText(/Client Portal email delivery is not configured in this environment/).waitFor();
    await owner.page.getByText(/Scheduled cleanup is not configured in this environment/).waitFor();
    await owner.page.screenshot({path:path.join(out,'missing-local-services-owner-warning.png'),fullPage:true});
    const localProfile=owner.page.getByRole('article',{name:'UV-DTF 24″ Gang Sheet',exact:true});
    await localProfile.getByRole('button',{name:'Edit',exact:true}).click();
    await owner.page.getByRole('button',{name:'Create/Enable link',exact:true}).click();
    await owner.page.getByRole('dialog',{name:'Save settings and enable link?',exact:true}).getByRole('button',{name:'Save and enable',exact:true}).click();
    await localProfile.getByText('Active',{exact:true}).waitFor();
    await owner.page.screenshot({path:path.join(out,'save-enable-without-resend-cron.png'),fullPage:true});
    await owner.page.keyboard.press('Escape');
    const enabledWithoutServices=(await (await f.owner.GET(f.req('/',undefined,'basic'))).json()).profiles.find(p=>p.name==='UV-DTF 24″ Gang Sheet');
    assert.equal(enabledWithoutServices.active,true);
    assert.equal((await f.owner.POST(f.req('/',{action:'disable',profileId:enabledWithoutServices.id},'basic'))).status,200);
    Object.assign(process.env,configuredServices);
    await owner.page.getByRole('button',{name:'Close Client Portal',exact:true}).click();
    await owner.page.locator('.access-reveal-handle').hover();
    await owner.page.getByRole('button',{name:/^Client Portal/}).click();
    await localProfile.getByText('Disabled',{exact:true}).waitFor();
    const legacy = owner.page.getByRole('article',{name:'Legacy / Default Profile',exact:true});
    await legacy.getByRole('button',{name:'Edit',exact:true}).click();
    const gap = owner.page.getByLabel('Spacing (in)',{exact:true}), edge = owner.page.getByLabel('Auto-layout edge allowance (in)',{exact:true});
    assert.equal(await gap.inputValue(),'0.1'); assert.equal(await edge.inputValue(),'0.1');
    await owner.page.getByRole('button',{name:'Reset portal layout defaults',exact:true}).click();
    assert.equal(await gap.inputValue(),'0.3'); assert.equal(await edge.inputValue(),'0.5');
    await edge.scrollIntoViewIfNeeded();
    await owner.page.screenshot({path:path.join(out,'portal-layout-defaults.png'),fullPage:true});
    await owner.page.getByRole('button',{name:'Use current Builder sheet settings',exact:true}).click();
    assert.equal(await gap.inputValue(),'0.1'); assert.equal(await edge.inputValue(),'0.1');
    await owner.page.keyboard.press('Escape');
    assert(await legacy.getByRole('button',{name:'Edit',exact:true}).evaluate(el => el === document.activeElement));
    const copyOrigin = legacy.getByRole('button',{name:'Copy link',exact:true});
    await owner.page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable:true, value:async payload => { window.sharedPortalLink=payload; } }));
    await copyOrigin.focus();
    const portalScroll = await owner.page.locator('.client-jobs-dialog').evaluate(el => el.scrollTop);
    await copyOrigin.click();
    const shareDialog = owner.page.getByRole('dialog',{name:'Share Client Upload Link',exact:true});
    await shareDialog.waitFor();
    assert(await shareDialog.evaluate(el=>el.getBoundingClientRect().height<500),'share action stays compact');
    assert.equal(await owner.page.locator('.client-jobs-dialog:not(.client-action-dialog)').evaluate(el=>el.scrollTop),portalScroll,'share does not jump to settings');
    assert(await shareDialog.getByRole('button',{name:'Copy link',exact:true}).evaluate(el=>el===document.activeElement));
    await owner.page.keyboard.press('Shift+Tab');
    assert(await shareDialog.evaluate(el=>el.contains(document.activeElement)),'focus remains inside action modal');
    const originalLink = await owner.page.getByLabel('Client upload link',{exact:true}).inputValue();
    assert.equal(new URL(originalLink).origin, new URL(base).origin);
    assert.equal(new URL(originalLink).pathname, '/client-upload/' + token);
    await owner.page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { if (!window.copyFailedOnce) { window.copyFailedOnce=true; throw Error('Simulated clipboard failure'); } window.copiedPortalLink = text; } } }));
    await shareDialog.getByRole('button',{name:'Copy link',exact:true}).click();
    await shareDialog.getByRole('alert').filter({hasText:'Copy the displayed link manually or retry'}).waitFor();
    await owner.page
      .getByRole('dialog',{name:'Share Client Upload Link',exact:true}).getByRole('button', { name: 'Copy link', exact: true })
      .click();
    assert.equal(await owner.page.evaluate(() => window.copiedPortalLink), originalLink);
    await shareDialog.getByText('Upload link copied.', { exact: true }).waitFor();
    await shareDialog.getByRole('button',{name:'Share',exact:true}).click();
    await shareDialog.getByText('Upload link shared.',{exact:true}).waitFor();
    assert.equal((await owner.page.evaluate(()=>window.sharedPortalLink)).url,originalLink);
    await owner.page.screenshot({path:path.join(out,'share-link-action-modal.png'),fullPage:true});
    await owner.page.keyboard.press('Escape');
    assert(await copyOrigin.evaluate(el=>el===document.activeElement));
    assert.equal(await owner.page.locator('.client-jobs-dialog').evaluate(el=>el.scrollTop),portalScroll,'closing restores focus without scrolling');
    assert.equal(
      await owner.page.getByRole('button', { name: /^Client Portal/ }).count(),
      1
    );
    await owner.page.screenshot({
      path: path.join(out, 'owner-desktop.png'),
      fullPage: true
    });
    await owner.page.getByRole('button', { name: 'Done', exact: true }).click();
    await owner.page.locator('.client-submission-list').getByText('Confirmed', { exact: true }).waitFor();
    assert.match(
      await owner.page.locator('.client-submission-row').first().innerText(),
      /Browser jersey order[\s\S]*2[\s\S]*5[\s\S]*0\.076 m/
    );
    await owner.page.setViewportSize({ width: 1100, height: 520 });
    assert(
      await owner.page.locator('.client-jobs-dialog').evaluate((el) => {
        return el.scrollHeight <= el.clientHeight + 1 && el.scrollTop === 0;
      }),
      'owner modal stays fixed while panes manage scrolling on a short desktop viewport'
    );
    await owner.page.setViewportSize({ width: 1360, height: 900 });
    // Original builder iframe stays intact while a separate export instance rebuilds the manifest.
    const iframe = owner.page
      .frames()
      .find((fr) => fr.url().includes('clientJob=1'));
    await iframe.waitForFunction(() => window.smartSheetClientJob);
    await owner.page
      .getByRole('button', { name: 'Download layout PNG', exact: true })
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
      .getByRole('button', { name: 'Download layout PNG', exact: true })
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
      );
    const pixelComparison = await owner.page.evaluate(async ({ source, exported, placement, crop }) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + source; await img.decode();
      const native = document.createElement('canvas');native.width=crop.w;native.height=crop.h;native.getContext('2d').drawImage(img,crop.x,crop.y,crop.w,crop.h,0,0,crop.w,crop.h);
      const c = document.createElement('canvas'); c.width = 900; c.height = 900;
      const ctx = c.getContext('2d');ctx.imageSmoothingQuality='high';ctx.translate(placement.x+placement.w/2,placement.y+placement.h/2);ctx.rotate(placement.rotation*Math.PI/180);ctx.filter='saturate(100%)';
      ctx.drawImage(native,-placement.baseW/2,-placement.baseH/2,placement.baseW,placement.baseH);
      const digest = async context => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',context.getImageData(placement.x,placement.y,placement.w,placement.h).data))).map(b=>b.toString(16).padStart(2,'0')).join('');
      const result = new Image();result.src='data:image/png;base64,'+exported;await result.decode();
      const actual=document.createElement('canvas');actual.width=900;actual.height=900;const actualCtx=actual.getContext('2d');actualCtx.drawImage(result,0,0);
      return {expected:await digest(ctx),actual:await digest(actualCtx)};
    }, { source: png().toString('base64'), exported: fs.readFileSync(await saved.path()).toString('base64'), placement: p, crop: job.assets[0].crop });
    assert.equal(pixelComparison.actual,pixelComparison.expected,'decoded requested-size export RGBA matches a reference drawn from the original full-resolution PNG');
    assert(
      (
        await f.one('select downloaded_png from client_jobs where id=$1', [
          job.id
        ])
      ).downloaded_png
    );
    const tiffDownload = owner.page.waitForEvent('download');
    await owner.page
      .getByRole('button', { name: 'Convert layout to TIFF', exact: true })
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
      .getByRole('button', { name: 'Download layout PNG', exact: true })
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
    await owner.page.getByRole('button', { name: 'Download layout PNG', exact: true }).waitFor();
    await owner.page.getByRole('button', { name: 'Download layout PNG', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
    assert.equal(await owner.page.locator('dialog .client-preview canvas').count(), 0);
    await owner.page.getByRole('button', { name: 'Close Client Portal' }).click();
    await owner.page.locator('.access-reveal-handle').hover();
    await owner.page.getByRole('button', { name: /^Client Portal/ }).click();
    await owner.page.locator('.client-status-badge.expired').getByText('Expired', { exact: true }).waitFor();
    await owner.page.getByText('Expired — files are no longer available.', { exact: true }).waitFor();
    await owner.page.getByRole('button', { name: 'Shop portal settings' }).click();
    assert(f.objects.size > 0, 'opening Client Portal does not invoke physical cleanup');
    const maintenance = await f.maintenance.GET(
      new NextRequest('https://shop.test/api/client-jobs/maintenance', {
        headers: { authorization: 'Bearer test-maintenance' }
      })
    );
    assert.equal(maintenance.status, 200);
    assert.equal(f.objects.size, 0, 'daily cron purges expired private files');
    await owner.page.getByRole('article',{name:'Legacy / Default Profile',exact:true}).getByRole('button', { name: 'Disable', exact: true }).click();
    const disableDialog = owner.page.getByRole('dialog',{name:'Disable upload link?',exact:true});
    await disableDialog.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal((await f.owner.GET(f.req('/api/client-jobs',undefined,'basic')).then(r=>r.json())).portal.enabled,true,'cancel does not disable');
    await legacy.getByRole('button',{name:'Disable',exact:true}).click();
    await disableDialog.getByRole('button',{name:'Disable link',exact:true}).click();
    await owner.page.getByRole('dialog',{name:'Portal link setup required',exact:true}).waitFor();
    await customer.page.goto(`${base}/client-upload/${token}`);
    await customer.page.getByRole('alert').filter({ hasText: 'This upload portal is currently disabled.' }).waitFor();
    assert.equal(await customer.page.locator('input[type=file]').count(), 0);
    await owner.page.keyboard.press('Escape');
    await legacy.getByRole('button',{name:'Copy link',exact:true}).click();
    const setupDialog = owner.page.getByRole('dialog',{name:'Portal link setup required',exact:true});
    await setupDialog.getByRole('button',{name:'Enable link',exact:true}).click();
    const enableDialog = owner.page.getByRole('dialog',{name:'Enable upload link?',exact:true});
    await enableDialog.getByRole('button',{name:'Enable link',exact:true}).click();
    await shareDialog.waitFor();
    await owner.page.keyboard.press('Escape');
    await owner.page.getByRole('article',{name:'Legacy / Default Profile',exact:true}).getByRole('button', { name: 'Regenerate link', exact: true }).click();
    const rotateDialog=owner.page.getByRole('dialog',{name:'Regenerate upload link?',exact:true});
    await owner.page.screenshot({path:path.join(out,'regenerate-link-confirmation.png'),fullPage:true});
    await rotateDialog.getByRole('button',{name:'Regenerate',exact:true}).click();
    assert(await rotateDialog.getByRole('button',{name:'Updating…',exact:true}).isDisabled());
    await rotateDialog.getByRole('alert').filter({hasText:'temporarily unavailable'}).waitFor();
    assert.equal(rotateAttempts,1);
    await rotateDialog.getByRole('button',{name:'Regenerate',exact:true}).click();
    await shareDialog.waitFor();
    assert.equal(rotateAttempts,2,'one failed attempt followed by explicit retry');
    assert.notEqual(await owner.page.getByLabel('Client upload link',{exact:true}).inputValue(),originalLink);
    const nextToken = (await owner.page.getByLabel('Client upload link',{exact:true}).inputValue()).split('/').at(-1);
    await owner.page.keyboard.press('Escape');
    await customer.page.reload();
    await customer.page.getByRole('alert').filter({ hasText: 'invalid or has been replaced' }).waitFor();
    await customer.page.goto(`${base}/client-upload/${nextToken}`);
    await customer.page.getByRole('heading', { name: 'Legacy / Default Profile' }).waitFor();
    // Exercise real machine-specific links, required names, and a clean next draft.
    const profiles = (await (await f.owner.GET(f.req('/api/client-jobs',undefined,'basic'))).json()).profiles;
    for (const machine of ['dtf','tarpaulin']) {
      const profile=profiles.find(p=>p.template===machine);
      assert.equal((await f.owner.POST(f.req('/api/client-jobs',{action:'enable',profileId:profile.id},'basic'))).status,200);
      const client=await pageFor();await client.page.setViewportSize({width:1400,height:1100});await client.page.goto(`${base}/client-upload/${profile.url.split('/').at(-1)}`);
      await client.page.getByRole('heading',{name:profile.name,exact:true}).waitFor();
      await client.page.locator('input[type=file]').setInputFiles({name:'Uniform artwork.png',mimeType:'image/png',buffer:png(600,300)});
      await client.page.getByText('Ready',{exact:true}).waitFor();
      assert(await client.page.getByRole('button',{name:'Generate Print Preview',exact:true}).isDisabled());
      assert.equal(await client.page.getByRole('combobox').count(),0,'client cannot choose machine or sheet settings');
      await client.page.screenshot({path:path.join(out,`public-profile-${machine}.png`),fullPage:true});
      await client.page.getByLabel('Project / Client Name *',{exact:true}).fill('Mikael – Company Uniform');
      await client.page.getByRole('button',{name:'Generate Print Preview',exact:true}).click();await client.page.locator('.client-preview canvas').waitFor();
      await client.page.getByRole('button',{name:'Confirm & Send to Shop',exact:true}).click();await client.page.getByRole('heading',{name:'Gang sheet submitted',exact:true}).waitFor();
      assert.equal(await client.page.getByRole('button',{name:/Download|TIFF|PNG backup/}).count(),0);
      await client.page.screenshot({path:path.join(out,`submitted-profile-${machine}.png`),fullPage:true});
      const totalBefore=(await f.one('select count(*)::int n from client_jobs')).n;
      const lockedBefore=(await f.one('select count(*)::int n from client_jobs where confirmed_at is not null')).n;
      await client.page.getByRole('button',{name:'Create another gang sheet',exact:true}).click();
      assert.equal(await client.page.getByLabel('Project / Client Name *',{exact:true}).inputValue(),'');
      assert.equal(await client.page.locator('.client-file').count(),0);assert.equal(await client.page.locator('.client-preview canvas').count(),0);
      assert.equal((await f.one('select count(*)::int n from client_jobs')).n,totalBefore,'clearing success does not create or re-submit a job');
      await client.page.screenshot({path:path.join(out,`new-draft-${machine}.png`),fullPage:true});
      await client.page.locator('input[type=file]').setInputFiles({name:'Next artwork.png',mimeType:'image/png',buffer:png(60,40)});await client.page.getByText('Ready',{exact:true}).waitFor();
      assert.equal((await f.one('select count(*)::int n from client_jobs')).n,totalBefore+1);
      await client.page.reload();await client.page.getByRole('heading',{name:profile.name,exact:true}).waitFor();
      assert.equal((await f.one('select count(*)::int n from client_jobs where confirmed_at is not null')).n,lockedBefore,'refresh cannot resubmit the prior confirmation');
      await client.context.close();
    }
    await owner.page.getByRole('button', { name: 'Close Client Portal' }).click();
    await owner.page.locator('.access-reveal-handle').hover();await owner.page.getByRole('button',{name:/^Client Portal/}).click();
    if (!await owner.page.locator('.client-upload-profiles').isVisible()) await owner.page.getByRole('button',{name:'Shop portal settings',exact:true}).click();
    await owner.page.getByRole('article',{name:'DTF 24″ Gang Sheet',exact:true}).waitFor();
    await owner.page.getByRole('article',{name:'DTF 24″ Gang Sheet',exact:true}).getByText('Active',{exact:true}).waitFor();
    await owner.page.setViewportSize({width:1440,height:1100});await owner.page.locator('dialog').evaluate(el=>{el.scrollTop=0;});
    await owner.page.screenshot({path:path.join(out,'upload-profiles-management.png'),fullPage:true});
    const disabledProfile=owner.page.getByRole('article',{name:'UV-DTF 24″ Gang Sheet',exact:true});
    await disabledProfile.getByRole('button',{name:'Share',exact:true}).click();
    await setupDialog.waitFor();
    await owner.page.setViewportSize({width:375,height:520});
    assert(await setupDialog.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;}));
    assert(await setupDialog.evaluate(el=>el.getBoundingClientRect().height<450),'mobile setup action does not fill the viewport');
    await owner.page.screenshot({path:path.join(out,'disabled-profile-mobile-modal.png'),fullPage:true});
    await owner.page.keyboard.press('Escape');
    assert(await disabledProfile.getByRole('button',{name:'Share',exact:true}).evaluate(el=>el===document.activeElement));
    await disabledProfile.getByRole('button',{name:'Edit',exact:true}).click();
    await owner.page.getByRole('button',{name:'Create/Enable link',exact:true}).click();
    const saveConfirm=owner.page.getByRole('dialog',{name:'Save settings and enable link?',exact:true});
    await saveConfirm.getByRole('button',{name:'Cancel',exact:true}).click();
    assert(await owner.page.getByRole('dialog',{name:'Edit UV-DTF 24″ Gang Sheet',exact:true}).isVisible());
    await owner.page.keyboard.press('Escape');
    await owner.page.setViewportSize({width:1440,height:1100});
    await owner.page.getByRole('article',{name:'DTF 24″ Gang Sheet',exact:true}).getByRole('button',{name:'Edit',exact:true}).click();
    assert.equal(await owner.page.getByLabel('Printing machine',{exact:true}).inputValue(),'dtf');
    await owner.page.keyboard.press('Escape');
    await owner.page.getByRole('article',{name:'DTF 24″ Gang Sheet',exact:true}).getByRole('button',{name:'Duplicate profile',exact:true}).click();
    await owner.page.getByRole('article',{name:'DTF 24″ Gang Sheet (copy)',exact:true}).waitFor();
    await owner.page.getByRole('button',{name:'Create new profile',exact:true}).click();
    await owner.page.getByLabel('Profile name',{exact:true}).fill('Custom test profile');await owner.page.getByRole('button',{name:'Create profile',exact:true}).click();
    await owner.page.getByRole('dialog',{name:'Edit Custom test profile',exact:true}).waitFor();
    await owner.page.keyboard.press('Escape');
    await owner.page.getByRole('article',{name:'Custom test profile',exact:true}).waitFor();
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
