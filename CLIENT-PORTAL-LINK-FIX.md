# Client Portal link diagnosis and deployment

## Live checks on 2026-09-27

- The Supabase project configured in local `.env.local` is `xczwxxybbohnzkxgtsjd`. It contains one portal record, with `enabled = false`. The existing database function filters out disabled portals before lookup, then raises the same `P0002` message for a disabled record, an unknown token, and an inactive shop. This reproduced the exact reported error. Portal tokens do not expire; draft submission sessions do.
- All four Client Jobs tables, both RPCs, and the private `client-job-sources` bucket exist in that project. Anonymous direct table reads and RPC execution were tested and denied. The deployed RPC still has the earlier ambiguous lookup logic and needs the updated migration.
- Local configuration has Supabase URL/anon/service credentials, but no `SMART_SHEET_SITE_URL`, `RESEND_API_KEY`, `CLIENT_JOBS_EMAIL_FROM`, or `CRON_SECRET`. Missing notification/maintenance configuration prevents enabling a portal intentionally. The owner previously lacked useful setup feedback.
- The real saved-token lookup at `http://localhost:3000` now returns `503 portal_setup_required` against the old live RPC, correctly requesting the database update.
- Both the production portal page and public API at `https://smart-sheet-builder.vercel.app` return HTTP 404 HTML. The Client Portal application code is not available at that production deployment yet. Production is **not verified working**.
- Vercel project-management credentials are not available here. Its actual environment variable values and whether it targets this same Supabase project could not be inspected. No production environment, database record, email, deployment or enabled state was changed during these checks.
- REST access does not expose PostgreSQL catalog details. Exact live index definitions and RLS policy flags were not independently inspected; use the read-only catalog audit below. API permission denial alone is not presented as proof of every policy definition.

## Fix implemented

The service-only SQL lookup resolves the token hash first, then separately checks enabled and shop eligibility. The API returns stable codes:

| Condition | HTTP | Code / message |
| --- | --- | --- |
| Unknown/replaced/malformed token | 404 | `portal_not_found` — invalid or replaced link |
| Disabled portal | 403 | `portal_disabled` — “This upload portal is currently disabled.” |
| Suspended/unverified shop | 403 | `portal_paused` — shop not accepting uploads |
| Expired submission | 410 | `submission_expired` — start a new submission |
| Invalid submission credential | 401 | `submission_invalid` — start a new submission |
| Missing/old schema | 503 | `portal_setup_required` — server database update required |
| Missing environment/unreachable service | 503 | `portal_configuration_error` — service problem, not an expired link |

Development/server logs report configuration or schema failures without tokens, email addresses or keys. An old RPC's ambiguous error explicitly requests the migration rather than guessing which state it represents.

Owner settings show **Portal link active** or **Portal link setup required**, list missing setup items, and expose **Create/Enable link**. Copy is enabled only for an active, recoverable link. Save checks configuration before changing the record. Rotate replaces only the token; re-enable retains the token; existing confirmed jobs remain accessible to their owner. If a signing-key change makes a saved token unrecoverable, no empty/broken URL is shown; explicit Create/Enable replaces it.

`app/api/_lib/public-app-url.js` is the shared URL policy for Client Jobs and auth callback/recovery URLs. `SMART_SHEET_SITE_URL` is the single explicit configuration variable. The earlier alternate `NEXT_PUBLIC_SITE_URL` portal fallback is removed. Credentials, query strings, paths, insecure production origins and localhost origins on Vercel are rejected. Trusted Vercel deployment variables are the fallback; arbitrary forwarded Host headers are not used. A local portal request uses its actual loopback origin, including when testing a production build locally. No full portal URL is stored in `client_portals`.

## Required Supabase update

1. In the Supabase project used by the app, run the **updated `supabase-client-jobs-v1.sql`** in SQL Editor. It is rerunnable and preserves portal tokens, users, jobs and export records. Even if the first version was already installed, this rerun is required to replace its function body. It also reloads the PostgREST schema cache.
2. Run **`scripts/check-client-portal.sql`** (read-only). Confirm:
   - Four tables have RLS enabled.
   - Primary/unique indexes exist; `client_jobs_owner_date` and `client_jobs_expiry` exist.
   - Both RPCs are security-definer, executable by `service_role`, not `anon` or `authenticated`.
   - `has_disabled_link_fix` is true for `ssb_client_jobs`.
   - The restrictive `client_job_sources_private` policy exists; the bucket is private, PNG-only, 4 MiB per file.
3. Keep existing Auth Site URL, allowed callback/reset URLs, email confirmation and existing auth/credit migrations. Public customers do **not** need a Supabase Auth redirect URL for `/client-upload/*` and do not sign in.
4. Set Vercel's standard `CRON_SECRET` and deploy the repository's daily Hobby-compatible cron. `vercel.json` schedules **GET `/api/client-jobs/maintenance` at `15 2 * * *`**. No external scheduler is required.

## Exact Vercel environment configuration

Set these for the **Production** environment of the Smart Sheet Builder Vercel project, then deploy the code with these values. Secrets below must come from your own existing project/provider; do not copy placeholder text as a real key.

| Variable | Value |
| --- | --- |
| `SMART_SHEET_SITE_URL` | `https://smart-sheet-builder.vercel.app` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xczwxxybbohnzkxgtsjd.supabase.co` **if this is the intended production project**; must match the migrated project |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | That same project's existing anon/publishable client key supported by the current app |
| `SUPABASE_SERVICE_ROLE_KEY` | That same project's existing server-only service-role key |
| `RESEND_API_KEY` | Your configured Resend sending API key |
| `CLIENT_JOBS_EMAIL_FROM` | An actual verified sender, e.g. `Smart Sheet Builder <jobs@YOUR-VERIFIED-DOMAIN>` |
| `CRON_SECRET` | A generated random secret of at least 32 bytes. Vercel sends it as the cron route's Bearer secret. |

Preserve `SMART_SHEET_EXPORT_SECRET` if already configured. The existing service-role-key fallback remains supported; do not rotate signing keys as a troubleshooting shortcut. No new service-role or provider key belongs in a `NEXT_PUBLIC_*` variable.

For **local `.env.local`**, use `SMART_SHEET_SITE_URL=http://localhost:3000` and real development credentials/provider configuration. Local loopback origin resolution works without that variable for the portal, but setting it also documents the intended auth redirects. Do not copy the local value into Vercel Production. For Vercel Preview, use a validated preview origin or the trusted `VERCEL_URL` fallback, not localhost. Redeploy after changing Vercel environment variables; changing local `.env.local` does not update Vercel.

Resend sender/domain verification and Vercel `CRON_SECRET` must be configured before enabling uploads; the app does not fabricate these credentials or silently skip notifications/retention. Exact access expiry remains server-enforced at `expires_at`; the daily cron performs physical deletion afterwards.

## URL formats and smoke test

- Local: `http://localhost:3000/client-upload/<43-character-opaque-token>`
- Production: `https://smart-sheet-builder.vercel.app/client-upload/<43-character-opaque-token>`

After migration and deployment:

1. Sign in as a verified shop user. Open Client Jobs, complete settings, then **Create/Enable link**. Wait for **Portal link active**; do not reuse a failed/partial save's URL.
2. Click **Copy link**. Open it in a signed-out/incognito tab; the shop name and PNG upload controls must appear without login. Test the local and production origins separately.
3. Disable: that link must show the disabled message. Re-enable: the same token must work again.
4. Regenerate: the old URL must show invalid/replaced; the new URL must open the portal. Existing confirmed jobs stay in the owner's list.
5. Upload, preview and confirm a small PNG. Check delivery and authenticated owner export using the original guarded flow. Public preview must not charge credits.

## Verification and changed files for this fix

- `tests/client-portal-link.test.cjs`: real API handlers and PostgreSQL fixture cover persisted enable/disable/rotate/re-enable, anonymous lookup, invalid/expired states, missing environment/schema, owner status, local/prod URL policy and hostile request-origin rejection.
- Updated `tests/client-jobs.test.cjs` and `tests/client-jobs-ui.test.cjs`: lifecycle status codes, actual UI Copy/Disable/Enable/Rotate, customer error states, full-resolution PNG/TIFF and credit/expiry regression coverage.
- `app/api/_lib/public-app-url.js` added; `app/api/_lib/password-auth.js` delegates URL resolution to it. Existing password and auth-callback tests are required and retained.
- `app/api/_lib/client-jobs.js`, `app/api/client-jobs/route.js`, `app/api/client-upload/[token]/route.js`: state resolution, diagnostic codes, readiness and safe link creation.
- `app/components/ClientJobs.jsx`, `app/client-upload/[token]/page.jsx`: owner setup status and customer retry/new-submission/error presentation.
- `supabase-client-jobs-v1.sql` updated; `scripts/check-client-portal.sql` and this document added.
- No TIFF, image processing, layout, quota algorithm, role or Design Library permission changes in this fix.

Build/lint and automated tests run locally. A live production success test remains pending the migration update, environment setup and deployment; the current production 404 is recorded rather than reported as a passing test.
