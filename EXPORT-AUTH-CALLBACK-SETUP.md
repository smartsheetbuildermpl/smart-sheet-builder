# Export guard and email callback rollout

This document covers the export/callback fix on top of the uncommitted rolling-credit and enforcement work. No production database migration, Dashboard change, commit, push, or deployment was performed.

## Confirmed diagnosis

- **Empty files:** both `downloadPng` and `downloadTiff` opened `chooseExportDestination` before `exportDelivery.prepare`. A native picker can create a file before authorization rejects the export. Their lock was per sheet, allowing simultaneous exports on different sheets.
- **Browser authentication:** the local `NEXT_PUBLIC_SUPABASE_URL` contains `https://xczwxxybbohnzkxgtsjd.supabase.co/rest/v1/`. The server already normalized this to the project origin, but `browser-auth.js` passed the entire path to the SDK. The SDK consequently targeted `/rest/v1/auth/v1/...`. This affects session adoption immediately after a successful server login, as well as refresh. The browser client now normalizes to the same origin as the server.
- Read-only HTTPS checks on September 27, 2026: the malformed Auth settings URL returned **404**, the normalized `/auth/v1/settings` returned **200**, email authentication was enabled, and automatic confirmation was **false**. The normalized service REST schema returned **200** and advertised the credit/guest RPCs, but did not advertise `ssb_create_password_recovery`.
- The deployed production `/auth/callback` and `/reset-password` both returned **404**. The production export-status endpoint returned **200**. The working tree had no confirmation page, and recovery accepted only PKCE codes or token hashes, rejecting implicit recovery links. Signup did not specify its callback destination.
- **Production login attribution remains limited:** Vercel logs/environment inspection was unavailable, and no real user's password was used. The malformed URL is proven in this local configuration and reproduced/covered by the SDK browser test; it is not proof that Vercel has the same value. Check the production variable/logs below before claiming this is the only production login cause. Network and HTTP failures now log only an endpoint, status/error code—never request bodies, keys, tokens, or passwords.

## Export behavior and exact handlers

`public/builder.html` now routes both export buttons through `startExport`:

1. Acquire a single global export lock; disable export buttons on all sheets.
2. Authorize with the server. Only explicit `allowed: true` plus a signed authorization proceeds. Denial invokes the guest/standard/unavailable modal and stops.
3. For TIFF, only an authorized user opens the existing production/profile check. After confirmation, recheck and bind the chosen RGB/CMYK profile.
4. `encodePng` / `encodeTiff` encode the existing full-resolution sheet composition. The workspace's existing full-resolution display canvas is unchanged; no export-specific image read, PNG encode, TIFF strip generation or Blob creation happens before authorization. No CSS-scaled/thumbnail/magnifier input was introduced.
5. Once a complete nonempty Blob exists, `exportDelivery.deliver` performs the atomic final quota check/debit. It refuses missing tickets and non-boolean permission values.
6. Only then call `saveExportBlob` and `chooseExportDestination`. If the long preparation exhausted browser user activation, an **Export ready → Save as…** dialog obtains a fresh click. Cancel/write failure uses the existing refund path. Unsupported browsers retain the existing download fallback.

The TIFF encoding/color/Photoshop resource blocks remain byte-for-byte unchanged. PNG/TIFF dimensions and output pixels remain covered by regression tests. A denied preflight, denied final check, or failed encoder cannot invoke the picker/download anchor. The browser's fallback download API cannot confirm that a person kept a file on disk; existing delivery limitations still apply.

The modal in `app/page.jsx` distinguishes exhausted guests, exhausted standard users with a server-backed countdown, and unavailable access. Owner/Unlimited permission still comes from server validation, not UI state. No payment processing was added.

## Auth behavior and files

Added:

- `app/auth/callback/page.jsx`: public confirmation, invalid-link recovery/resend, mobile UI.
- `app/api/auth/confirm/route.js`: Supabase token-hash verification, cookie-bound PKCE exchange, or Auth-verified implicit session; never trusts URL claims or grants roles.
- `app/api/auth/confirmation/request/route.js`: privacy-safe resend with a 60-second cookie cooldown plus Supabase's server limits.
- `supabase-auth-callback-v1.sql`: one-use implicit-recovery proof index/function, accessible only to `service_role`; no profile, quota or permission changes.

Changed for this pass:

- `app/lib/browser-auth.js`: normalize SDK URL.
- `app/api/auth/register/route.js`: configured callback destination and PKCE challenge/cookie.
- `app/api/_lib/password-auth.js`: shared trusted callback URL and separately named encrypted confirmation cookie.
- `app/api/auth/password/verify/route.js`: implicit recovery support alongside existing PKCE/token-hash flows.
- `app/api/auth/password/request/route.js`: preserve friendly network-error handling.
- `app/reset-password/page.jsx`: implicit link handling, same-page hash navigation, token scrubbing, success/sign-in action.
- `app/api/_lib/supabase.js`, `app/api/_lib/user-management.js`, `app/hooks/useSmartSheetAuth.js`: sanitized transport diagnostics, explicit permission checks and helpful network messages.
- `app/page.jsx`, `app/components/ExportCredits.jsx`, `app/globals.css`: export-denial states/countdown, legacy root-link forwarding, callback sign-in button styling.
- `next.config.mjs`: no-referrer/no-store headers on callback/reset/root pages.
- `public/builder.html`, `public/export-delivery.js`: centralized early guard, global lock and deferred Save As.

Existing secure password update/current-password/audit logic remains in place. Recovery credentials are scrubbed from the URL and held in a short-lived encrypted HttpOnly cookie, not localStorage. An ordinary password-session token with a forged `type=recovery` is rejected. Implicit recovery requires Auth validation of the exact JWT, matching user, a recent email OTP/recovery authentication following a recent server-recorded recovery request, and a one-use database ticket. Supabase's implicit verification currently issues the `otp` AMR; a URL event/type alone is not authorization. Token-hash templates are recommended for reliable cross-device use. PKCE links require the originating browser's verifier cookie.

## Manual rollout steps

1. In **the Smart Sheet Builder Supabase project** (not MPL Cloud), open SQL Editor. Preserve existing records; do not reset tables or balances. Apply missing prerequisites in order:
   - Existing user-management migration: `supabase-user-management-v1.sql` (and its earlier access/schema prerequisites, if not already installed).
   - `supabase-password-recovery-v1.sql` — required for every secure password reset and password-change audit. It was absent from the inspected schema's advertised RPCs.
   - `supabase-auth-callback-v1.sql` — new, run after password recovery.
   - If not already deployed: `supabase-export-credits-v1.sql`, then `supabase-export-enforcement-v1.sql`. Do not rerun an older quota migration after enforcement without rerunning enforcement last.
2. In **Vercel → Smart Sheet Builder → Settings → Environment Variables**, verify:
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://xczwxxybbohnzkxgtsjd.supabase.co` (project origin only, no `/rest/v1/`). Confirm this is your intended Smart Sheet project.
   - Existing `NEXT_PUBLIC_SUPABASE_ANON_KEY` belongs to that project.
   - Existing `SUPABASE_SERVICE_ROLE_KEY` belongs to that project and has **no `NEXT_PUBLIC_` prefix**.
   - Production `SMART_SHEET_SITE_URL` = `https://smart-sheet-builder.vercel.app`.
   - Keep any existing recovery/export signing secrets stable. Never place them in public variables.
   - Use Node 22+ for the installed SDK (tests used Node 24).
   - For localhost `.env.local`, `SMART_SHEET_SITE_URL=http://localhost:3000` may be set; otherwise development uses the request origin. For Preview, use that exact trusted preview origin or omit this variable in Preview so the Vercel preview hostname is used. Do not copy a localhost value into Production.
3. In **Supabase → Authentication → URL Configuration**:
   - **Site URL:** `https://smart-sheet-builder.vercel.app`
   - **Redirect URLs:** add these exact entries:
     - `https://smart-sheet-builder.vercel.app/auth/callback`
     - `https://smart-sheet-builder.vercel.app/reset-password`
     - `http://localhost:3000/auth/callback`
     - `http://localhost:3000/reset-password`
   - Add the exact callback/reset URLs for any other development port or trusted Vercel Preview you actually test. Avoid broad production wildcard redirects.
4. In **Authentication → Email Templates → Confirm signup**, replace the confirmation link's `href` with:

   ```html
   <a href="{{ if .RedirectTo }}{{ .RedirectTo }}{{ else }}{{ .SiteURL }}/auth/callback{{ end }}?token_hash={{ .TokenHash }}&amp;type=signup">Confirm email</a>
   ```

5. In **Authentication → Email Templates → Reset password**, use:

   ```html
   <a href="{{ if .RedirectTo }}{{ .RedirectTo }}{{ else }}{{ .SiteURL }}/reset-password{{ end }}?token_hash={{ .TokenHash }}&amp;type=recovery">Reset password</a>
   ```

   Keep the rest of each email's branding/content. These links go to the app, which verifies the hash server-side; do not expose passwords or service keys in templates. The default `{{ .ConfirmationURL }}` template is also supported for correctly configured app redirect URLs, through PKCE/implicit handling.
6. Keep **Confirm email** enabled if that is your existing policy. In Authentication's **SMTP Settings**, verify a working sender/domain/provider and delivery limits. Check inbox/spam and Supabase Auth logs for delivery failures; this code does not install an SMTP provider.
7. Deploy/redeploy **this source version** to Vercel after environment changes. Public environment values are embedded at build time. Merely configuring redirect URLs cannot fix a deployed 404 page.
8. Open production in a fresh tab, register a test Basic account, click the real confirmation email, sign in, request a reset, open it, and change the password. Try an expired/used link. Check Vercel Runtime Logs for `[ssb-supabase-network]` / `[ssb-supabase-response]` if login still fails; check Supabase Auth logs in the same time window. Never paste passwords, JWTs or keys into logs/screenshots.
9. Exhaust a test guest and standard user's allowance. Click each TIFF/PNG button: the appropriate modal must appear with no Save As or download. With an allowed account, export once and inspect the nonempty file. Preserve production customer quotas; use dedicated test accounts.

## Verification and limits

- `npm run build` and `npm run lint` passed. Five pre-existing lint warnings remain (two library images, one auth cleanup ref, two root hook dependencies). The build also reports a non-fatal webpack cache snapshot warning. Both public callback pages appear in the production route table.
- Final verification also served that production build on local port 3113 and passed `password-ui`, `auth-callback-ui`, `export-enforcement-ui`, and `export-credits-ui` without development hot reload. External Auth was still mocked; this was not a production database test. `git diff --check` passed.
- Actual Chrome UI: exhausted guest/standard **button clicks** do not invoke canvas encoding, the instrumented native picker, or browser download events. Allowed exports create nonempty files. Global duplicate PNG/TIFF clicks are serialized. Access outage also fails closed.
- Actual Next API handlers plus PGlite PostgreSQL execute the real quota and callback migrations. Tests cover privacy, cooldown, PKCE/token-hash/implicit proofs, expired/used links, JWT protection, one-use tickets and RLS.
- Chrome login exercises the real login route and official SDK with a configured `/rest/v1/` suffix, proving the normalized request goes to `/auth/v1/user`. Confirmation/reset success, used links, legacy root redirects and mobile pages are checked; screenshots were visually inspected.
- API/SQL, rolling credits, delivery/refund, registration/admin permissions, password change, RGB/W1/CMYK/UV/Tarpaulin, layout spacing, full-resolution PNG/TIFF and Background Editor regression suites were run.
- These browser tests mock external Supabase Auth responses; no real signup/reset emails were sent and no customer credentials were used. Native OS picker calls are instrumented; selecting a real Windows folder still needs the post-deployment staff check. Vercel logs/environment and actual email delivery were not available for live verification.

New tests: `tests/auth-callback.test.cjs`, `tests/auth-callback-ui.test.cjs`.
Updated tests: `tests/export-enforcement.test.cjs`, `tests/export-enforcement-ui.test.cjs`, `tests/export-delivery.test.cjs`, `tests/export-credits-ui.test.cjs`, `tests/password-ui.test.cjs`, `tests/user-management-api.test.cjs`.

Template/reference: [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates). Implicit AMR verification was checked against [Supabase Auth verify implementation](https://github.com/supabase/auth/blob/master/internal/api/verify.go).
