# Client Upload Portal / Client Jobs

Implemented against the export/auth baseline on `codex/design-library-v1`. This feature has not been deployed and the production database has not been changed by this task.

For the disabled-link error investigation, live check results, updated migration requirement and exact localhost/Vercel environment setup, see [CLIENT-PORTAL-LINK-FIX.md](CLIENT-PORTAL-LINK-FIX.md). Re-run the updated migration even if the initial Client Jobs schema was already installed.

## Deployment setup

1. Keep the existing authentication and quota migrations from `EXPORT-AUTH-CALLBACK-SETUP.md`. Run **`supabase-client-jobs-v1.sql` last** in the intended Supabase project. It is rerunnable. It creates `client_portals`, `client_jobs`, `client_job_rates`, `client_job_exports`, two service-only RPCs, and the **private** `client-job-sources` bucket. It does not grant registrants admin or library-management access, change accounts, or reset credits.
2. Configure these **server-only** Vercel environment variables, then redeploy:

   | Variable | Value |
   | --- | --- |
   | `SMART_SHEET_SITE_URL` | Canonical HTTPS app origin, e.g. `https://smart-sheet-builder.vercel.app` |
   | `RESEND_API_KEY` | Transactional sending key from your Resend account |
   | `CLIENT_JOBS_EMAIL_FROM` | Sender on your verified Resend domain, e.g. `Print Shop <jobs@your-domain.example>` |
   | `CRON_SECRET` | A new random secret, at least 32 bytes. Vercel sends it automatically to the daily cron route. |

   Preserve the existing Supabase URL, anon key, service-role key, and export signing secret. Never prefix the service role, email key or maintenance secret with `NEXT_PUBLIC_`. Local development uses its own Supabase project/provider sandbox, `SMART_SHEET_SITE_URL=http://localhost:3000`, and a separate non-public `CRON_SECRET` so portal setup can be exercised; Vercel does not invoke cron jobs on localhost.

3. Vercel Hobby requires no external scheduler. This repository includes exactly one production cron in `vercel.json`: **GET `/api/client-jobs/maintenance` at `15 2 * * *` (02:15 UTC daily)**. Add the same `CRON_SECRET` value in Vercel → Project → Settings → Environment Variables for Production, then redeploy. Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` and the endpoint rejects any other request. Do not configure Supabase Cron, pg_net, or an every-minute scheduler. Vercel Hobby schedules daily cron jobs only; delivery can occur within Vercel's documented hourly precision window.

4. Sign in as a verified normal shop user. Open **Client Jobs → Shop portal settings**. Confirm shop name/email, click **Use current Builder sheet settings**, review the preset, and save/enable the link. New verified accounts get an opaque link on first access, disabled until settings are explicitly enabled. No customer account is required.
5. Send a small test submission through the link in a signed-out browser. Check notification delivery to the configured address, open the authenticated job, and test a PNG and TIFF using an account with sufficient credits. The public preview and confirmation use no credit.

## Retention and honest limitations

- Confirmation uses database `clock_timestamp()` exactly once; `expires_at = confirmed_at + 24 hours`. Drafts expire two hours after creation. Retries, reopening, link rotation, or email delivery do not extend either deadline.
- Access expires exactly at `expires_at`, independently of the cron. Every public submission action, owner job view, preview, private file response, PNG/TIFF preparation and export consumption checks server/database time and rejects when `now >= expires_at`; refreshes never extend it. The UI says **“Expired — files are no longer available.”** A file legitimately saved before expiry cannot be revoked from a device.
- Physical temporary source objects, manifests, notifications and temporary output metadata are removed by the daily Vercel cron. Deletion can therefore occur after the exact 24-hour access deadline, or later after a transient Storage outage; no bytes, preview, download or export are served during that interval. Cleanup deletes Storage objects before clearing their database paths, so a failed delete remains retryable and the task is idempotent.
- Storage deletion precedes removal of asset paths/manifest, so failed deletion remains retryable. A removed draft design is immediately excluded from preview/access, and its private object is removed by the same bounded lifecycle. No flattened preview or final PNG/TIFF is persisted to the server.
- The history keeps only reference, dates, counts, meters, notification-sent date, and PNG/TIFF saved flags; source metadata and layout are cleared on purge. The UI lists the newest 100 jobs.
- Email has an exact UTC expiry and an authenticated **Open Client Job** button. A reliable live countdown runs in the app, not the static email. The durable outbox retries failed sends; stable [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys) prevent duplicates. No attachments or public source URLs. Sending requires explicit provider setup; no real email was sent during automated tests. SMTP used for Supabase Auth is separate from this job-notification adapter. See [Resend send-email API](https://resend.com/docs/api-reference/emails/send-email).
- Public draft sessions intentionally live only in the current tab's memory. Refreshing starts a new submission; the abandoned draft is cleaned after two hours. No cross-customer resume link is exposed.

## Limits / authorization

- Static **8-bit PNG** only; signature/chunk framing, CRC and actual pixel decode are verified server-side. Empty artwork, corrupted data and animated PNGs are rejected. The original uploaded bytes are stored unchanged and SHA-256 checked again before owner reconstruction.
- Per file: 4 MiB, 16,777,216 pixels, 8192 pixels per side. Per submission: ten uploads, 32 MiB, 32 megapixels of active source canvases, 500 pieces. Up to twenty unexpired submissions per shop. Deleted/failed upload reservations still count toward the ten-upload allowance until the submission expires.
- Output: ten sheets maximum, 128 megapixels per sheet, 32767 pixels per side. An oversized request is rejected explicitly; source and output resolution are never silently reduced. Adjusting the shop preset is an explicit owner choice.
- Public mutations: 120/hour per trusted network; new drafts: 10/hour; portal views: 240/hour. Durable counters contain HMACs, never raw IPs. On Vercel the trusted ingress header is used. Else configure `SMART_SHEET_TRUSTED_IP_HEADER` only when your proxy strips and overwrites it; without one the conservative shared fallback applies.
- All tables have RLS enabled with no anon/authenticated table access. RPC execute permission is service-role-only. The API verifies Supabase Auth email confirmation and active profile, then derives owner ID from that verified identity. Super Admin has no cross-shop bypass in these endpoints.
- A restrictive bucket policy also denies direct browser access even if another broader storage policy exists. File requests require the owning verified user and a confirmed, unexpired job. Public sessions are signed opaque draft credentials bound to both job and current portal token. Rotating/disabling links prevents further public access/mutations immediately and preserves owner job access.
- Job export tickets bind job ID as well as identity, format, request and fingerprint. The same existing credit RPC performs charging/finalization/refund inside the job-expiry transaction. No alternative free export endpoint was added. The locked recipe preserves retry identity even when the native canvas is rebuilt after a lost debit response.

## Full-resolution quality

`public/sheet-packing.js` contains the existing builder packer extracted unchanged. Both regular layout and server-generated client manifests use it. Original orientation comes first, left-to-right rows, rotation only as gap fallback. Spacing and the default 0.30-inch allowance stay separate; existing manual placement is untouched.

The server finds nonzero-alpha bounds with the builder's one-native-pixel padding. Native cropped width/height divided by 300 determines physical artwork size. The manifest stores exact crop rectangles, source hashes, placement coordinates/rotations, output DPI, sheet pixels/inches and total physical sheet meters, including unused sheet area. Confirmation locks it.

`ClientJobPreview` draws scaled display-only canvases. Owner export uses a separate builder iframe so the main working layout remains intact. It decodes original PNGs, copies the recorded crop without re-trimming, rebuilds one exact full-resolution sheet, and calls the existing guarded PNG/TIFF entry point. TIFF profiles, RGB/CMYK conversion, W1/UV spot resources and encoder blocks are unchanged.

## API / UI file inventory

- `app/api/client-jobs/route.js`: verified-owner link/settings/list and confirmed job detail (GET/POST).
- `app/api/client-upload/[token]/route.js`: public shop name and signed draft create/upload/remove/preview/confirm (GET/POST).
- `app/api/client-jobs/[id]/files/[file]/route.js`: checked private source proxy (GET).
- `app/api/client-jobs/maintenance/route.js`: Vercel-`CRON_SECRET` protected daily expiry purge/email retry (GET).
- `app/api/_lib/client-jobs.js`: validation, shared packing adapter, private Storage, signed draft/link credentials and email provider adapter.
- `app/api/_lib/export-security.js`, `app/api/_lib/supabase.js`, `app/api/export/consume/route.js`: optional job binding/expiry around the existing export guard; ordinary exports retain their previous path.
- `app/client-upload/[token]/page.jsx`: public customer form/read-only preview.
- `app/components/ClientJobs.jsx`: signed-in jobs button, owner modal/settings/history and guarded export bridge.
- `app/components/ClientJobPreview.jsx`: scaled checkerboard preview, shared by both views.
- `app/client-jobs.css`, `app/layout.jsx`, `app/page.jsx`: responsive styling, stylesheet import and small main-app entry point.
- `public/builder.html`, `public/sheet-packing.js`: shared unchanged packer plus isolated locked-manifest reconstruction bridge.
- `next.config.mjs`: no-store/no-referrer on public portal pages.
- `package.json`, `package-lock.json`: `pngjs` server validator dependency.
- `supabase-client-jobs-v1.sql`: schema, private bucket and service-only transactional operations.
- `tests/client-jobs.test.cjs`, `tests/client-jobs-ui.test.cjs`: new SQL/API/browser coverage. Existing builder fixture routers additionally serve the extracted packing script; frozen TIFF hashes are unchanged.

## Verification performed

- Production build and lint pass. Lint retains five existing warnings in the library, auth hook and main-page hook dependencies; no new warnings.
- Real PostgreSQL (PGlite) + real Next API handlers: native 2048 PNG/CRC validation, multiple files/quantities, horizontal 20-copy packing, trim/spacing/edge allowance, meters, opaque session isolation, owner/cross-user/guest denial, locked manifest, exact 24-hour expiry, idempotent confirmation, provider retry, quota/ticket binding, expiry between prepare and consume, source byte equality, failed deletion honesty, successful purge/history, two-hour drafts, link rotation/disable and RLS. Supabase HTTP/Storage and Resend transport are controlled test boundaries.
- Headless Chrome against a production Next build: signed-out multi-PNG upload, quantity edits, read-only preview, mobile 375px, confirmation, owner deep link/badge, actual original-source PNG and DTF W1 TIFF downloads at 900 × 900, PNG alpha samples 0/4/255, debit-response loss and same-request retry, two-credit exhaustion, responsive owner UI, live expiry clearing previews/export controls, subsequent purge/history display, no page errors.
- Existing export-enforcement browser suite also passes: guest persistence across reload, Basic credit exhaustion, owner/Unlimited PNG and TIFF, duplicate clicks, failed encoding/save without a charge, real Supabase SDK refresh and outage handling. The PNG validator additionally rejects an interlaced decompression fixture exceeding its declared native dimensions.
- Existing builder, incremental-layout, zero-spacing, RGB/W1 TIFF, optimizer, background-editor, export-enforcement and delivery tests pass. Existing tests verify CMYK/W1, UV RGB/CMYK spot resources and Tarpaulin alpha TIFF; frozen protected encoder hashes pass.
- Not live-tested: production Supabase Storage/provider delivery, actual scheduled cleanup, real email inboxes, native OS Save As interaction, Photoshop/RIP imports or a physical printer. Complete the deployment smoke test above before enabling customer links in production.
