# Password recovery and account security

This setup is for **Smart Sheet Builder**, not MPL Cloud. No production database or Supabase Dashboard settings were changed by this implementation.

## Configure before deploying

1. In the Smart Sheet Builder Supabase project's SQL Editor, run `supabase-password-recovery-v1.sql` after the existing `supabase-user-management-v1.sql` migration. It is repeatable. It adds private, expiring, single-use recovery tickets and a password-change audit RPC. Existing users, roles, profiles, export records and library permissions are not changed.
2. In Vercel, set this server-only environment variable for **Production**:
   ```text
   SMART_SHEET_SITE_URL=https://smart-sheet-builder.vercel.app
   ```
   Keep the existing Supabase URL, anon key and server-only service-role key configuration. Never put the service-role key in a `NEXT_PUBLIC_` variable.
3. In Supabase **Authentication → URL Configuration**, set:
   - Site URL: `https://smart-sheet-builder.vercel.app`
   - Redirect URLs: `https://smart-sheet-builder.vercel.app/reset-password`
   - Development redirect: `http://localhost:3000/reset-password`
   - If using another development port, add its exact URL too (for example `http://localhost:3108/reset-password`).
4. For local development, leave `SMART_SHEET_SITE_URL` unset so the development request origin is used, or set it to the exact local origin in `.env.local`. Do not use a production value while testing on localhost. For Vercel previews, allow the exact preview `/reset-password` URL in Supabase; the app uses `VERCEL_URL` unless explicitly overridden. The requesting page and configured site origin must match so the browser can retain the recovery proof.
5. In Supabase **Authentication → Email Templates → Reset Password**, verify that the reset link uses `{{ .ConfirmationURL }}`. This preserves Supabase verification and redirects to the configured `/reset-password` page with a PKCE code. Do not replace it with the bare Site URL or remove the query parameters. Previously sent implicit-flow links must be replaced with a new request from this version of the app.
6. Configure production email delivery in Supabase **Authentication → Email → SMTP Settings** (custom SMTP): sender address/name, SMTP host, port, username and password from your email provider. Verify the sender/domain with that provider. Test an actual message to a staff inbox and check spam. The public success message deliberately does not prove an address exists or a message was delivered.
7. Redeploy after environment changes. Keep existing email confirmation and security policies enabled. Both forms require at least eight characters and matching confirmation; Supabase may enforce stricter password rules.

Optional: set a stable, server-only `SMART_SHEET_RECOVERY_SECRET` to a cryptographically random secret (at least 32 random bytes) on all instances. Without it, the app derives its recovery-cookie encryption key from the existing service-role secret. Rotating either effective key invalidates outstanding recovery cookies; request new links afterward.

Supabase references: [password authentication and recovery](https://supabase.com/docs/guides/auth/passwords), [redirect URL configuration](https://supabase.com/docs/guides/auth/redirect-urls), [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

## Staff test steps

1. Sign out → Sign in → **Forgot password?** Enter a known test email and send. Repeat with an unknown address after the cooldown. Both must show: “If an account exists for this email, we sent a password reset link. Please check your inbox and spam folder.”
2. Open the newest email link in the **same browser** where it was requested, within 15 minutes. A new request replaces that browser's previous recovery proof. Set matching passwords of at least eight characters. Expect “Password changed successfully”, then Sign In.
3. Sign in with the new password; verify the old password fails. Reopen the used link and try an expired link: both should offer **Request a new reset link**.
4. Sign in → Account → **Security → Change password**. Try a wrong current password, mismatched confirmation, then a valid change. Expect success and a fresh sign-in. The app has no Supabase JS SDK; it re-authenticates through the existing Supabase Auth REST client before updating its own authenticated user.
5. As the owner, open **Users & Registrations → View History** for that account. Expect “Password changed by user” with its timestamp, without password values. Check that role, status, export allowance/usage and Design Library permission are unchanged. An unlimited account remains non-admin.

## Security and operational behavior

- Recovery uses Supabase PKCE and a short-lived encrypted HttpOnly cookie. Ordinary login tokens or a forged `type=recovery` URL cannot authorize a reset. The recovery page also supports a custom email template supplying Supabase's recovery `token_hash`, verified server-side with `type: recovery`.
- Reset requests have a 60-second resend cooldown and retain Supabase's server-side rate limits. Provider responses that could reveal whether an account exists use the same public success message. Configuration and network failures can report non-account-specific errors.
- Password writes use the authenticated `/auth/v1/user` endpoint (the same endpoint as `auth.updateUser`), never an admin password-reset endpoint. Signed-in changes require the current password and identity matching. No admin UI or API can choose another target user.
- Recovery tickets and their RPCs are inaccessible to anonymous/authenticated database clients; only the server service role can create/claim tickets or append this audit event. Existing RLS and owner protections are unchanged.
- Passwords are never written to profiles, audit history, local storage or logs. The pre-existing localhost offline test login now stores salted PBKDF2 verifiers and migrates legacy local test records instead of retaining readable passwords. It is not a production password recovery system.
- Supabase Auth updates and app audit inserts are separate operations. If the password succeeds but the audit insert fails, the UI reports successful password change with an explicit audit warning. Do not retry the same password change to repair an audit record. Diagnose the migration/service configuration instead. No historical audit events are fabricated.
- Cancellation or rejected requests do not modify role, profile, status, usage or permissions. Suspended accounts remain suspended after credential recovery. Temporary re-authentication/recovery sessions are signed out after success; Supabase controls the lifetime of existing JWTs.

## Files and verification

Pages/components: `app/page.jsx`, `app/reset-password/page.jsx`, `app/components/PasswordRequestForm.jsx`, `app/components/PasswordFields.jsx`, `app/components/ChangePassword.jsx`, `app/components/UsersDialog.jsx`.

Supporting code: `app/api/_lib/password-auth.js`, the four routes in `app/api/auth/password/{request,verify,reset,change}/route.js`, `app/lib/password-rules.js`, `app/lib/local-test-credentials.js`, `app/hooks/useSmartSheetAuth.js`, `app/globals.css`, `next.config.mjs`.

Migration: `supabase-password-recovery-v1.sql`. Tests: `tests/password-auth.test.cjs`, `tests/password-ui.test.cjs`, extended `tests/user-management-db.test.cjs`, plus existing auth, access and user-management regression suites.

Automated API/browser tests isolate Supabase responses; the database suite executes the SQL in isolated PostgreSQL/PGlite. These tests do not send real email, change live passwords, or apply the production migration. Complete the staff test steps against your configured Supabase project before calling email delivery verified.
