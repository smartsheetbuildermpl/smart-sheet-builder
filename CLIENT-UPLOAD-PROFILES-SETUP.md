# Client Upload Profiles

Apply `supabase-client-upload-profiles-v1.sql` **after** the existing `supabase-client-jobs-v1.sql` in the same Supabase project. Apply this migration before deploying the profile UI. It is additive and rerunnable; it does not change storage, export credits, user accounts, TIFF/PNG encoders or cron. Do not re-run the base Client Jobs migration alone afterward: always apply the profiles migration last to restore the profile-aware RPC wrapper.

The migration adds `client_upload_profiles` (RLS enabled, no anon/authenticated access) and `client_jobs.profile_id`, `profile_name`, and `machine`. The original maintenance operations are retained as a service-only internal function. The public API remains the only way to resolve opaque links; clients cannot list profiles or read notification email, owner identity, storage paths or private settings. Verified owners can manage only their own profiles. There is no profile deletion action.

Existing generic portals are copied as **Legacy / Default Profile** with the exact existing hash, encrypted token, enabled state and settings. Historical manifests, source assets, references, deadlines and export records remain untouched. New history labels are explicit legacy labels, not reconstructed claims about historical profile names. Reapplying the migration does not overwrite saved profiles. Old owner API callers remain compatible with the legacy profile. New jobs snapshot profile ID/name/machine, identifier, settings and requested sizes at preview time; confirmation uses the reviewed recipe and email recipient, even if a profile is edited between preview and confirmation. A concurrent profile edit during layout computation returns a retryable conflict instead of saving mixed settings.

The four templates are created once on the owner's first settings load, initially disabled:

| Profile | Machine | Sheet (in) | Output DPI |
| --- | --- | --- | --- |
| DTF 24″ Gang Sheet | DTF | 23 × 39 | 300 |
| UV-DTF 24″ Gang Sheet | UV-DTF 24″ | 23 × 39 | 300 |
| UV-DTF 12″ Gang Sheet | UV-DTF 12″ | 11 × 39 | 300 |
| Tarpaulin | Tarpaulin | 63 × 39 | 150 |

All new templates use **0.30 in spacing / 0.50 in automatic allowance**; main Builder defaults stay **0.10 / 0.10**. Tarpaulin's new template explicitly displays 150 DPI in settings: 63 × 39 at 300 DPI would exceed the existing 128-megapixel portal sheet budget. This is an editable profile output setting, never a change to uploaded original bytes or an automatic quality fallback. Existing legacy Tarpaulin settings are not rewritten. Owners must review and save/enable each profile before sharing. Create and Duplicate create disabled profiles; Regenerate affects only the selected link, preserves its enabled state and never changes confirmed jobs. Disable retains history and owner access until each job's original expiry.

No new environment variables, bucket policies, signing keys or scheduler changes are required. Preserve the existing Supabase, public-origin, Resend and `CRON_SECRET` configuration. Profile links use the current/configured validated origin and opaque tokens, with the same two-hour draft and exact 24-hour confirmed expiry.

## Manual acceptance after deployment

1. Open Client Portal → settings gear → Upload Profiles. Check the legacy link still works, review all four templates, then enable only the intended profiles.
2. Open a DTF link and Tarpaulin link signed out. Each shows its own profile badge; no machine or shop-layout controls appear. A blank Project / Client Name blocks Preview/Confirm on both client and server.
3. Upload originals, request sizes/quantities, review and confirm. Check the identifier/profile in owner history and the notification subject/body. Open an older confirmed job and verify its layout/exports are unchanged.
4. Edit/rotate/disable one profile. Other profile links and confirmed recipes must stay intact. Create another gang sheet clears all previous draft state under the same link; refresh never resubmits a confirmation.
5. Check private original-source PNG/TIFF export with sufficient credits and expiry rejection. Daily cleanup still runs through `/api/client-jobs/maintenance` at `15 2 * * *`.

For rollback, revert the app commit while retaining the additive tables/columns and service wrapper. Existing generic API compatibility remains available. Do not delete profiles/history or restore older manifests as a rollback. Retain a database backup and apply future SQL changes forward.

Automated checks: `node tests/client-upload-profiles.test.cjs`, `node tests/client-jobs.test.cjs`, `node tests/portal-layout-defaults.test.cjs`, `node tests/client-requested-size.test.cjs`, and `node tests/client-jobs-ui.test.cjs` against a local app. These use isolated PostgreSQL/API/provider fixtures and never mutate production accounts or send real notifications.
