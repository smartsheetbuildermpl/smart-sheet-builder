# Registration and Users & Registrations

This change is for **Smart Sheet Builder**, not MPL Cloud. No live database changes are performed by the build or tests.

## Installation order

1. In the Supabase project used by Smart Sheet Builder, confirm the existing owner `masterprintlabcorp@gmail.com` exists and has verified email. Do not create a replacement owner or an `exec_admin` account.
2. Back up the database before migration. Prerequisites are the existing `supabase-smart-sheet-v53b.sql`, `supabase-design-library-v1.sql`, and `supabase-access-entitlements-v1.sql` schemas. Do not rerun old scripts blindly against an unrelated project.
3. Run **`supabase-user-management-v1.sql`** in that project's SQL Editor. It is transactional and repeat-safe. It fails before making changes if the verified owner or entitlement prerequisite is absent. It preserves existing users, roles, plans, usage counters, entitlement values, and export records. It creates missing profiles without inventing historical registration events.
4. Deploy this app version after the migration. It uses the existing `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and server-only `SUPABASE_SERVICE_ROLE_KEY`; no new credentials are needed. Never put the service key in a `NEXT_PUBLIC_` variable.
5. In Supabase Authentication, verify the Site URL/allowed redirect URLs and email delivery configuration. Keep the desired Confirm email setting. With confirmation enabled, signup shows an email instruction and does not create a browser session. After following the confirmation link, the user signs in. With confirmation disabled, Supabase's immediately verified session can sign in directly.
6. Test using a separate Basic account and the existing owner. Open the access bar → **Users & Registrations** as owner. New registrants must be Standard, non-admin, and unable to manage the Design Library. This release does not send admin emails or create any other login.

Run the migration before this app: authenticated exports and login now call its transactional permission/usage functions. Missing functions fail closed, rather than bypassing export limits. The PNG/TIFF renderer, encoder, dimensions, channels, and builder source files have not changed.

## Exact permissions and storage

- New auth identities trigger profile creation with `role=user`, `plan=free`, `exports_unlimited=false`, `is_super_admin=false`. User metadata supplies only bounded contact/printing fields, never privileges. The API requires full name, email, and password. Optional notice acknowledgement records a server timestamp.
- `account_status` is derived: `profiles.status=blocked` means Suspended; otherwise an unconfirmed Auth email means Pending verification; otherwise Active. Email verification is always read from Supabase Auth, not user metadata. Reactivation does not verify an email.
- Standard access means the existing 5 total export allowance with existing guest-usage carryover. Unlimited access changes an export entitlement only; it never changes role or library permission. Existing subscribers/admins/unlimited flags remain effective until the owner explicitly changes access. `export_access_override` records such an explicit choice so Standard can also override a legacy subscription without rewriting its role/plan.
- A unique partial index permits just one `profiles.is_super_admin=true`. The migration binds it to the existing verified owner's UUID once. Reusing/changing an email or editing signup metadata cannot transfer the grant. Library management uses this same existing owner identity; Basic, Unlimited, and legacy non-owner admins cannot manage designs/categories.
- `/api/admin/users` and `/api/admin/users/[id]` require a valid verified Auth token, active profile, and bound owner. The database functions independently verify the acting owner's UUID. Authenticated/anonymous database roles cannot execute those functions or access audit/export-history tables directly. A supplied actor ID or role is never trusted.
- `/api/auth/profile` reads/updates only the token owner's allowed name, shop, mobile, city, country, machine type, and estimated usage. Profile table writes are denied to browser roles. A restrictive SELECT policy limits reads to the same user, even if an older permissive policy is broad.
- Only access/status changes are exposed; no delete or role-change action exists. Every change requires UI confirmation and an expected `updated_at` value. Stale edits return a conflict. The database rejects changes to the owner/acting administrator's critical access.
- Access changes and their old/new values, actor, and timestamp commit in one transaction to `user_access_history`. Only new registrations receive registration audit events. Existing `usage_exports` entries supply export history; missing older events are not synthesized. "Total recorded exports" can differ from carried-over/legacy allowance counters.
- Authenticated export consumption locks the same profile row as access changes, checks current status/verification/allowance, increments the standard counter, and records the event atomically. Guest import also locks that row and never decreases usage. Guest trial behavior is retained; suspending an account does not disable anonymous guest trials for all visitors.
- Suspension denies authenticated login continuation, profile operations, library access, and exports. Existing tokens do not bypass the server checks. UI state is not an authorization boundary.
- Browser local-test mode remains available on localhost only. It cannot create a real Super Admin session or access server admin APIs, and production cannot fall back to local unlimited accounts when Supabase is unavailable.

## Verification

No test uses real customer credentials or writes to the live Supabase project.

```powershell
npm run lint
npm run build
node tests/access-permissions.test.cjs
node tests/user-management-api.test.cjs
# Install/provide @electric-sql/pglite and playwright in a QA runtime via NODE_PATH.
node tests/user-management-db.test.cjs
# Start the app, then set SMART_SHEET_TEST_URL if not using localhost:3000.
node tests/user-management-ui.test.cjs
node tests/auth-state.test.cjs
node tests/workspace-ui.test.cjs
node tests/builder.test.cjs
node tests/rgb-w1-tiff.test.cjs
```

Database tests execute the migration twice in isolated PGlite PostgreSQL, then exercise registration metadata attacks, RLS/execute permissions, owner protection, legacy preservation, verification/suspension, Standard/Unlimited changes, usage accounting, and audit accuracy. API tests run actual handlers with only the Supabase network boundary mocked. Browser tests mock account endpoints and exercise desktop/mobile forms, confirmations, profile edits, owner protection, and keyboard navigation.

Live email delivery, the installed production schema/RLS, and end-to-end real Supabase account creation still require the post-install smoke test above. Lint reports existing library image and hook-dependency warnings; it has no errors.
