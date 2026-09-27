# Free Export Credits rollout

**Follow-up enforcement:** also read `EXPORT-ENFORCEMENT-SETUP.md` and run `supabase-export-enforcement-v1.sql` last. It adds persistent server-issued guest cookies, authorization before encoding, and Supabase session refresh. Completed receipts no longer grant a repeat download; only an uncertain, still-ready attempt can retry with the same key. The follow-up guide supersedes earlier guest-path/retry details below.

## Deploy

1. In the **Smart Sheet Builder** Supabase project (not MPL Cloud), run `supabase-export-credits-v1.sql` after the existing `supabase-user-management-v1.sql`. Keep the password-recovery migration installed too. Do not rerun older migrations after the credits migration without rerunning the credits migration last.
2. Deploy this app version. Existing tabs must refresh: the old registered-user consume RPC now returns a refresh-required result instead of enforcing a lifetime allowance.
3. Test a verified standard account, the owner account, and an existing Unlimited account. No new environment variables, scheduler, payment setup, or extra administrator account are needed.

The migration has not been applied to production by this task. It can be repeated without resetting a used balance. Existing profiles, roles, legacy counters, registration/audit records, and exports remain intact. Existing standard accounts receive two credits at migration time regardless of earlier lifetime usage. New verified accounts receive two independently of guest usage. Guests keep their existing two-total-export path.

## Credit timing

- Free balance ranges from zero to two. One credit is earned per completed three-hour interval while below two.
- Spending from a full balance starts the three-hour timer. Spending a second credit before that timer finishes preserves elapsed time; it does not restart the timer. An idle zero balance reaches one after three hours and two after six hours.
- Once full, the timer is cleared. Extra idle time cannot be banked beyond two credits.
- PostgreSQL `clock_timestamp()` determines refill eligibility. Status/consume requests apply earned refills under the same per-profile lock as access changes. No cron job is necessary.
- The display counts down from a server timestamp using monotonic elapsed time and refreshes server status at the deadline, on focus, and every 30 seconds while visible. It never grants credits locally. Offline test accounts cannot mint registered credits.
- Existing owner and Unlimited access bypass credits and keep their existing role and Design Library rights. Unlimited users do not receive consumption ledger deductions.

## Export delivery and retry rules

PNG/TIFF encoding runs first. Only a complete, nonempty final Blob requests export access. Rendering, upload, layout, background tools and Optimize for Print do not call the credit RPC. A per-sheet in-memory lock prevents double-click encoding; it is excluded from layout history.

The delivery helper fingerprints the rendering recipe (full-resolution source identity, positions, sizes, rotations, vibrance, sheet dimensions, name, DPI, format/profile and sheet index). It retains an operation key for an unchanged short retry. The database atomically locks the profile, refills, verifies permissions, checks the receipt, and deducts once. The same operation cannot be reused for a different fingerprint or format, and successful retry access expires after two minutes according to server time. Different sheets and PNG versus TIFF are distinct exports. The helper never copies or downsizes the final export pixels.

Encoding errors and picker cancellation do not debit a credit. A native file-write failure returns the credit through a receipt-bound, idempotent transaction; the export record is marked void, not deleted. The ledger records the original debit and its reversal. A receipt already marked saved cannot be refunded. Returns are capped at two if a refill occurred meanwhile.

If a refund or saved acknowledgement is interrupted, a small account-bound delivery outbox retries when the same account reconnects. It stores operation/receipt identifiers, not credentials or balances. The server authorizes every retry; editing local storage cannot grant credits. Further registered exports wait for outstanding delivery confirmations. A successful local save is never refunded simply because its acknowledgement was lost.

**Browser boundary:** a website cannot verify that an ordinary download finished on the user's disk. Without the native Save As API, success means the fully encoded file was handed to the browser download manager. Closing the tab or losing the response after a debit can leave an uncertain ready receipt; retry the unchanged export promptly or retain its reference for support. This client-rendered application does not upload print files to a trusted server renderer or provide DRM against someone modifying their own browser code. Database balances, refills, refunds, and idempotency are server enforced.

## Schema and permissions

`supabase-export-credits-v1.sql` adds:

- `free_export_credits`: separate balance and refill anchor, with a hard zero-to-two check.
- `export_credit_receipts`: authenticated-user-bound operation key, format/fingerprint, ready/saved/refunded state and linked export record.
- `usage_exports.voided_at`: distinguishes failed delivery from completed/ready export records without erasing history.
- Reuses existing `credit_ledger` for `free_refill`, `export_consumed`, and `export_refunded`. Initial grants are identified explicitly. The extensible reason/metadata fields can support future adjustment/purchase sources; no purchase or adjustment grant endpoint exists.
- Service-only RPCs `ssb_credit_snapshot`, `ssb_credit_export`, and `ssb_credit_history`, plus the verified-account initialization trigger. It replaces the old guest-to-profile import and lifetime consume behavior for registered users, and updates the existing owner detail/history RPC.

Authenticated users have read-only RLS access to their own credit balance and ledger, with restrictive self-read guards. They cannot mutate credits, read receipts, invoke the service RPCs, or select another user's history through the app endpoint. `/api/export/credits` derives the target from the verified login. Existing owner authorization protects `/api/admin/users/[id]`; only that area can view another user's credits. Access controls, owner protection, and Design Library restrictions retain their existing rules.

## Files changed

Schema: `supabase-export-credits-v1.sql` (existing schema files are not edited).

Export/auth integration: `app/api/_lib/supabase.js`; `app/api/export/{status,consume,credits}/route.js`; `app/api/auth/{me,login,register}/route.js`; `app/api/admin/users/[id]/route.js`; `app/hooks/useSmartSheetAuth.js`; `public/export-delivery.js`; `public/builder.html`.

UI: `app/components/ExportCredits.jsx`; `app/components/UsersDialog.jsx`; `app/page.jsx`; `app/account-notice/page.jsx`; `app/globals.css`.

Tests: new `tests/export-credits-db.test.cjs`, `tests/export-delivery.test.cjs`, `tests/export-credits-ui.test.cjs`; updated auth/access/user-management API expectations and browser asset routing. `tests/builder.test.cjs` and `tests/protected-builder-blocks.json` now fingerprint the unchanged encoder/profile/color sections separately from the intentionally changed delivery wrapper. Their new hashes were taken from the pre-change committed source and matched against the working source.

## Verification

The SQL suite executes the real migrations and RPCs in isolated PostgreSQL/PGlite: migration reruns, legacy preservation, initial balances, 3h/6h refill/cap, concurrent duplicate/distinct exports, exhausted balance, failed/saved/expired/foreign receipts, owner/Unlimited bypass, suspension, RLS, and owner-only cross-user history.

API tests verify identity binding, rejecting browser-supplied balances/time/target IDs, existing guest two-total allowance, registration and Design Library protections. Browser tests exercise actual PNG/TIFF encoding and delivery with a mocked account service, the live countdown under an intentionally wrong browser clock, mobile zero-credit UI, disabled Coming Soon control, encoding/save failures, and interrupted refund retry. No real checkout or purchased-credit grants are present.

Production Supabase migration, real email accounts, and physical printer output still require deployment verification. The separate TIFF regression suites decode exported PNG/TIFF files and compare source pixels, RGB/CMYK, W1/UV spot metadata, dimensions and alpha; they do not operate Photoshop or a printer.
