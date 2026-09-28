# Export enforcement and persistent sessions

## Rollout (Smart Sheet Builder only)

1. Apply `supabase-export-credits-v1.sql` if it has not been applied yet, after its user-management prerequisites.
2. Apply **`supabase-export-enforcement-v1.sql` last** in the same Supabase project. It is repeatable and does not reset balances or usage. Rerunning an older migration requires rerunning this one last.
3. Deploy this app version and refresh existing tabs. Use Node **22 or newer** for the installed Supabase SDK; development verification used Node 24.
4. Keep the existing Supabase URL, public anon key, and server-only service-role key configured. Optional server-only `SMART_SHEET_EXPORT_SECRET` provides a stable signing key separate from the service-role key. Use a long random secret; never prefix it `NEXT_PUBLIC_`. Rotating the signing key invalidates guest cookies and outstanding authorizations, so keep it stable.
5. On Vercel, IP throttling uses the platform's `x-vercel-forwarded-for` header. On another host, configure `SMART_SHEET_TRUSTED_IP_HEADER` only if the trusted reverse proxy strips/replaces that header. Without a trusted IP header, cookie identity and transactional quota enforcement still operate; network throttling is skipped rather than trusting spoofable client input.

No migration, Dashboard setting, deployment, commit, or push was performed by this task.

## Root causes and changes

- The old guest reader synthesized a row containing the requested guest ID when no row existed. Consumption interpreted that as an existing row and PATCHed zero records. The UI could briefly display one remaining while the next read returned two. That path is removed.
- Guest identity previously came from writable localStorage/request fields, and guest read/modify/write was not atomic. The server now issues a random opaque UUID in a signed, one-year, HttpOnly, SameSite=Lax cookie (`ssb_guest_trial`, Secure in production; localhost development permits HTTP). Guest usage stays in `guest_usage`. Refresh, navigation, and idle reload reuse the same cookie. A first-rollout legacy ID hint can import only already-spent usage, including historical exports where the old PATCH never inserted a counter; it cannot grant extra quota.
- The prior registered gate used reusable short-retry receipts even after successful delivery. Completed receipts can no longer authorize a second download. A fresh deliberate export starts a new operation; concurrent/uncertain retries of a still-ready operation remain idempotent.
- Old sessions were persisted manually but never refreshed, and any `/auth/me` failure cleared them. A single official Supabase browser client now persists and refreshes tokens. A one-time migration avoids resurrecting rejected SDK sessions from an older compatibility copy. Temporary network/profile errors retain identity but fail closed for exports; confirmed invalid refresh tokens lead to sign-in. The app waits for the initial session check and refreshes on focus/visibility. Listeners clean up on unmount.

## Exact official export boundary

Both PNG and TIFF actions use `public/export-delivery.js` through `public/builder.html`. No keyboard/alternate downloader exists; native Save As and browser-download fallback converge on the same save helper.

1. Before any export encoding or destination picker, `POST /api/export/consume` with `action: prepare` checks the verified account or signed guest cookie and current server quota. It issues a 10-minute HMAC authorization bound to actor, format, request UUID and rendering fingerprint. This is an authorization preflight, not a credit deduction or guarantee against another concurrent export. See `EXPORT-AUTH-CALLBACK-SETUP.md` for the follow-up correction: Save As now opens only after the complete Blob and final quota check; both buttons share one global export lock.
2. Only a complete, nonempty final Blob can send `action: consume`. The endpoint verifies the signature/binding/expiry; `ssb_credit_export` or `ssb_guest_export` locks the account's database row, rechecks current quota, deduplicates the operation, records usage, and deducts once atomically. Concurrent preflights cannot overspend. Denial never calls the save helper, creates a download object URL, or reports completion.
3. Successful handoff marks the receipt saved. Observable native-write failures refund exactly once and void the failed usage record. Interrupted finalization/refund uses the existing small retry outbox. Already-saved receipts cannot be refunded or replayed for a free download.

Direct standalone `builder.html` and unconfigured/offline mode cannot authorize official exports. They must use the main app with the server configured. The image processing and encoder output bytes are unchanged.

## Guest abuse protection and limits

`guest_trial_networks` stores only HMAC network identifiers, a window timestamp and creation count. It permits 30 new identities per network per hour, then temporarily throttles only new identities. Existing guest cookies and signed-in accounts continue working. Expired windows reset; old buckets are pruned after 24 hours during new creation. Raw IPs are not stored in these tables or shown by the app.

`guest_export_receipts` binds request keys and delivery state to the server guest ID. Tables/RPCs are service-only; browser roles cannot mutate/read guest counters or invoke guest grants. Normal registered users retain their existing own-credit reads; admin/library permissions are untouched.

Guest cookies are per browser and hostname. Clearing site data, private browsing, another browser/device, cookie expiry, or changing domains can create another identity; the short network throttle reduces repeated resets, not a permanent office ban. Browser storage cannot establish a permanent human identity.

The browser already holds the artwork and rendered canvas. Official buttons are server-gated; this is not DRM against users modifying their own JavaScript or capturing canvas pixels. Browser-download fallback can confirm handoff, not completion on disk. A crash/reload or lost response exactly between committed debit and file handoff can leave an uncertain ready receipt; quota does not reset, and no completion is fabricated. Retry the same live attempt promptly or retain its reference for support. Exact atomicity between a database commit and a user's local filesystem is not available to a web app.

## Supabase Dashboard session checks

Live project values were **not inspected or changed**. In **Authentication → Settings → Sessions**, check:

| Setting | For persistent staff sign-in |
| --- | --- |
| Time-box user sessions | Disabled / no fixed duration, unless your policy intentionally requires it |
| Inactivity timeout | Disabled / no timeout, unless your policy intentionally requires it |
| Single session per user | Off if the same account legitimately uses multiple browsers/devices |
| JWT expiry | Keep the usual 3600 seconds; refresh handles expiry, so do not extend it to hide this bug |
| Refresh token rotation / reuse protection | Keep enabled; retain the normal 10-second reuse interval |

These are manual checks, not assertions about your current settings. Some session limits require a paid Supabase plan. See [Supabase session documentation](https://supabase.com/docs/guides/auth/sessions) and [Vercel request header documentation](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for).

## Files changed for this follow-up

- Download/export: `public/builder.html`, `public/export-delivery.js`, `app/api/export/consume/route.js`, `app/api/export/status/route.js`, `app/api/_lib/export-security.js`, `app/api/_lib/supabase.js`.
- Session/UI: `app/lib/browser-auth.js`, `app/hooks/useSmartSheetAuth.js`, `app/api/auth/me/route.js`, `app/page.jsx`, `app/reset-password/page.jsx` (clear SDK session after recovery), `package.json`, `package-lock.json`.
- Migration: `supabase-export-enforcement-v1.sql` (new). Earlier rolling-credit work remains in the working tree.
- New tests: `tests/export-enforcement.test.cjs`, `tests/export-enforcement-ui.test.cjs`.
- Updated tests: `tests/access-permissions.test.cjs`, `tests/auth-state.test.cjs`, `tests/export-delivery.test.cjs`, `tests/export-credits-ui.test.cjs`, and encoder-only auth stubs in `tests/rgb-w1-tiff.test.cjs`, `tests/zero-spacing.test.cjs`, `tests/print-optimizer.test.cjs`, `tests/background-editor.test.cjs`.

## Verification

The enforcement suites run actual route handlers and migrations in isolated PostgreSQL/PGlite. Browser tests use those same handlers/database with actual PNG/TIFF download events, plus the real Supabase SDK with a controlled Auth HTTP boundary: registered 1→0, both formats denied at zero, guest 2→1→0 over reloads, duplicate clicks/requests, failed encoding/save, owner/Unlimited, idle refresh, temporary outage preservation, invalid refresh logout, signed cookies/tokens, network throttle, legacy usage import, and RLS. They do not write to production Supabase.

Separate regression suites cover account/library permissions, password recovery, registration/admin UI, rolling-credit refills, countdown/mobile UI, and decoded PNG/TIFF color/alpha/channel/dimension output. Frozen encoder-block hashes still match the committed pre-credit implementation. Production cookie behavior, actual project session policies, and live staff accounts need a post-deployment smoke test.

Final checks: `npm run build` and `npm run lint` passed (five existing lint warnings; no new lint errors). Registered, guest, and Unlimited enforcement suites passed, including actual browser download-event assertions. Access-permission, password API/UI, registration/admin API/UI, rolling-credit database/UI, delivery, RGB/W1, zero-spacing, builder, and print-optimizer regression checks passed. The full-resolution PNG/TIFF pixel comparisons and frozen encoder hashes passed.
