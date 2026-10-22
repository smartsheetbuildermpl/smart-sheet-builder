# Client Upload Portal / Client Jobs

Implemented against the export/auth baseline on `codex/design-library-v1`. This feature has not been deployed and the production database has not been changed by this task.

For the disabled-link error investigation, live check results, updated migration requirement and exact localhost/Vercel environment setup, see [CLIENT-PORTAL-LINK-FIX.md](CLIENT-PORTAL-LINK-FIX.md). Re-run the updated migration even if the initial Client Jobs schema was already installed.

## Deployment setup

### Configuration dependencies (current behavior)

Saving/enabling profiles, generating opaque links, public upload and read-only preview require the existing Supabase credentials/schema and a validated public origin. They **do not require** Resend or `CRON_SECRET`. Owner Shop portal settings show separate email/cleanup warnings without mislabeling the link as unavailable. A missing required origin returns a structured `portal_configuration_missing` owner error; missing Supabase credentials and URL failures have specific configuration codes, without exposing values.

Email delivery requires both `RESEND_API_KEY` and `CLIENT_JOBS_EMAIL_FROM`. A new submission's confirmation is rejected with `503 portal_email_not_configured` until they exist; the draft, originals, quantities, sizes and preview are preserved so the client can retry before the draft deadline. After successful confirmation the existing durable outbox retries provider failures. Replaying an already confirmed submission remains idempotent if email configuration later disappears.

`CRON_SECRET` authorizes maintenance only. Missing it never bypasses authentication or prevents profile saves. The daily endpoint returns 401 without the configured matching Bearer secret. With a valid secret, physical cleanup runs even without Resend; the response reports `emailConfigured: false` and `notified: 0`. Exact 24-hour access expiry is still enforced by the existing database/access checks, independently of scheduled deletion.

For a fully operational **Vercel Production** portal set `SMART_SHEET_SITE_URL=https://smart-sheet-builder.vercel.app`, the existing matching `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, valid `RESEND_API_KEY`, verified `CLIENT_JOBS_EMAIL_FROM`, and a strong `CRON_SECRET`. Preserve any existing `SMART_SHEET_EXPORT_SECRET` unchanged (the supported service-key fallback remains). No new variable was introduced. Vercel deployment origins are a validated fallback when the canonical URL is absent; explicitly setting the canonical URL avoids ambiguity.

**Localhost** reads `.env.local` independently. Supabase credentials/schema are required. Portal origin comes from the actual loopback request, so `SMART_SHEET_SITE_URL` is optional for local portal links; if explicitly set for other auth flows, use `http://localhost:3000`. Resend is optional for settings/upload/preview and required for new confirmation. A local `CRON_SECRET` is only needed to exercise authenticated maintenance manually; Vercel never schedules localhost. None of these variable names is exclusive to localhost. Never copy localhost into the Production site URL or expose server secrets as `NEXT_PUBLIC_*`.

Read-only verification on 2026-10-22: the Supabase project referenced by local configuration reports a private PNG-only bucket with `file_size_limit=33554432`, and PostgREST documents `ssb_client_upload_reserve`. This confirms the upload-limit/RPC state there, not that Vercel targets the same project or has every required variable. The available Vercel browser session requires login, so Production environment presence is unverified. No live configuration or data was changed.

### Upload / preview reliability update

After the existing Client Jobs and machine-profile migrations, apply **`supabase-client-upload-limits-v1.sql`** before deploying this update. It raises the private `client-job-sources` bucket's file limit to at least 32 MiB (preserving any larger/unlimited allowance) and adds a service-only, idempotent upload-reservation RPC. It adds no columns and does not modify/delete existing profiles, submissions, expiry, RLS, accounts, or credits. A prerequisite guard aborts the transaction if the private bucket is missing. No new environment variable is required. Reapplying the old initial migration resets the bucket to 4 MiB; always apply the upload-limit migration last. Rerunning this migration is safe even after jobs/profiles exist.

Files over 4 MiB use a narrowly scoped Supabase signed **upload-only** URL, bypassing Vercel's request-body ceiling. The URL permits creation at one reserved private path, with no read or overwrite permission. Server finalization checks the reservation, declared/actual bytes, static PNG contents, dimensions, CRC and native alpha bounds before making the asset ready. Retry reuses the same reservation and immutable object. No source conversion occurs. Supabase's [signed upload URLs last two hours](https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl). Abandoned drafts containing these grants retain their private paths until two hours after the draft deadline, then daily cleanup deletes them; access still stops at the original deadline. Confirmed jobs retain exact 24-hour expiry and the same daily cron.

Public and owner previews render one display-scale sheet at a time, using per-design proxies capped at 1600 px. Geometry is the original packed manifest, with no output-sized canvas. The owner export precheck (`GET /api/client-jobs?id=…&exportSheet=…`) checks the actual selected sheet, then the existing export bridge reconstructs that one sheet from checksum-verified originals. No total-sheet multiplier or ten-sheet restriction is applied to sequential exports. Oversized sheets remain previewable and show their actual physical/pixel dimensions and MP count; only their final allocation is refused.

Verification: `node tests/client-portal-regression.test.cjs` (local app at port 3114) compares `8000b97` with current packing/PNG validation, tests DTF 23×39 at 300 PPI for 5×5×10 and 4×3×10, an original over 4 MiB, retry without duplicate reservation, oversized preview, sequential sheet limits, expiry and owner isolation. Existing `tests/client-jobs-ui.test.cjs` verifies native PNG/TIFF reconstruction. Both use isolated database/storage/email fixtures, never live writes. After deployment, manually repeat a >4 MiB upload and owner download to verify the real Storage limit, CORS and Vercel streaming response; [Vercel recommends direct uploads and streamed large responses](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions).

1. Keep the existing authentication and quota migrations from `EXPORT-AUTH-CALLBACK-SETUP.md`. For a fresh installation run **`supabase-client-jobs-v1.sql`**, then **`supabase-client-upload-profiles-v1.sql`**, then **`supabase-client-upload-limits-v1.sql`** in the intended Supabase project. Existing installations with the first two already applied need only the latest upload-limit migration. They are rerunnable. The initial migration creates `client_portals`, `client_jobs`, `client_job_rates`, `client_job_exports`, two service-only RPCs, and the **private** `client-job-sources` bucket. It does not grant registrants admin or library-management access, change accounts, or reset credits.
2. Configure these **server-only** Vercel environment variables, then redeploy:

   | Variable | Value |
   | --- | --- |
   | `SMART_SHEET_SITE_URL` | Canonical HTTPS app origin, e.g. `https://smart-sheet-builder.vercel.app` |
   | `RESEND_API_KEY` | Transactional sending key from your Resend account |
   | `CLIENT_JOBS_EMAIL_FROM` | Sender on your verified Resend domain, e.g. `Print Shop <jobs@your-domain.example>` |
   | `CRON_SECRET` | A new random secret, at least 32 bytes. Vercel sends it automatically to the daily cron route. |

   Preserve the existing Supabase URL, anon key, service-role key, and export signing secret. Never prefix the service role, email key or maintenance secret with `NEXT_PUBLIC_`. Local development should use its own Supabase project/provider sandbox; email/cron dependencies are described above. Vercel does not invoke cron jobs on localhost.

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
- Per file: 32 MiB, 16,777,216 pixels, 8192 pixels per side. Per submission: ten uploads, 32 MiB, 500 pieces. Up to twenty unexpired submissions per shop. Deleted upload reservations still count toward the ten-upload allowance until the submission expires; direct-upload retries reuse their reservation.
- Final output: 128 megapixels per selected sheet, 32767 pixels per side, 33,554,432 pixels of distinct original sources referenced by that sheet. Actual sheets are packed from requested copies and exported one at a time. These final allocation limits do not block preview generation; source and output resolution are never silently reduced. Adjusting the shop preset is an explicit owner choice.
- Public mutations: 120/hour per trusted network; new drafts: 10/hour; portal views: 240/hour. Durable counters contain HMACs, never raw IPs. On Vercel the trusted ingress header is used. Else configure `SMART_SHEET_TRUSTED_IP_HEADER` only when your proxy strips and overwrites it; without one the conservative shared fallback applies.
- All tables have RLS enabled with no anon/authenticated table access. RPC execute permission is service-role-only. The API verifies Supabase Auth email confirmation and active profile, then derives owner ID from that verified identity. Super Admin has no cross-shop bypass in these endpoints.
- A restrictive bucket policy denies ordinary direct browser access even if another broader storage policy exists. The upload-only capability described above grants no read permission. File reads still require the owning verified user and a confirmed, unexpired job. Public sessions are signed opaque draft credentials bound to both job and current portal token. Rotating/disabling links prevents public session access/mutations immediately and preserves owner job access; previously issued upload-only grants cannot finalize an asset after disable/rotation and their private objects are cleaned after the grant expires.
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
