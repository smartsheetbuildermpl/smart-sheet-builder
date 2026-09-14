# Smart Sheet Builder by Master PrintLab

Vercel-ready Next.js wrapper for Smart Sheet Builder V5.3B.

V5.3B keeps the stable V5.2.4 Photoshop-compatible PNG/TIFF export engine and upgrades the V5.3A trial gate into a Supabase-ready account and usage system:

- Guest users: 2 free exports
- Registered free users: 5 total exports
- Export usage is counted only on PNG/TIFF download
- Usage can be enforced server-side through Supabase API routes
- Local test mode still works when Supabase env vars are missing
- Subscription, credits, admin controls, and subscriber-only free design library tables are prepared for future phases

## Local Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Without Supabase environment variables, the app falls back to local test mode so you can still test the product flow.

## Deploy To Vercel

1. Push this folder to GitHub.
2. Import the repo in Vercel.
3. Framework preset: `Next.js`.
4. Build command: `npm run build`.
5. Output directory: leave default.
6. Add the Supabase environment variables below.

## Supabase Environment Variables

Add these in Vercel Project Settings, then redeploy:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
SMART_SHEET_ADMIN_EMAILS=your-email@example.com
NEXT_PUBLIC_SMART_SHEET_ADMIN_EMAILS=your-email@example.com
```

Keep `SUPABASE_SERVICE_ROLE_KEY` server-only. Do not expose it in browser code.

## Supabase Setup

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `supabase-smart-sheet-v53b.sql`.
4. In Authentication settings, choose whether email confirmation is required.
5. Copy the env vars into Vercel and redeploy.

## Owner-only library and unlimited basic account

Spacing now defaults to **0 inches**. The number input and slider accept zero in
all measurement units. Existing manual placements stay put when spacing changes;
Auto-arrange applies the selected spacing to all pieces.

Library management is independent of export entitlements:

| Account | Export allowance | Library access |
| --- | --- | --- |
| `masterprintlabcorp@gmail.com` | Admin / Unlimited, as before | Browse all designs and manage PNGs/categories/visibility |
| Basic user with `profiles.exports_unlimited = true` | Basic account / Unlimited | Browse and add visible designs; no management controls |
| Other admin profiles | Existing admin allowance | Browse and add visible designs; no library management |
| Ordinary registered user | 5 total exports | Browse and add visible designs |
| Guest | 2 exports | Sign-in gate |

The server verifies the Supabase Auth identity on every library request. Only the
owner can mutate the catalog or request hidden designs. No browser email check
grants the basic account unlimited exports. The existing export endpoints read
the profile entitlement; blocked accounts remain blocked.

### One-time Supabase setup

1. In **Supabase Dashboard → the same project used by the app → SQL Editor →
   New query**, run `supabase-access-entitlements-v1.sql`. The existing base and
   Design Library V1 SQL files must already have been run. This adds
   `profiles.exports_unlimited` (default false), enables library RLS, restricts
   profile writes to the server, and protects only the `smart-sheet-library`
   Storage bucket. It does not delete data or reset export counters.
2. Supply the existing `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` through your
   private server environment or ignored `.env.local`. Do not paste keys or
   passwords into source files or terminal commands.
3. From a **private PowerShell terminal in this repository**, run:

   ```powershell
   & .\scripts\provision-basic-unlimited.ps1
   ```

   It first checks configuration and the entitlement column, then prompts for a
   password without echo. It sends that password through a private child-process
   stdin pipe, never through arguments, environment variables, or files.
   The command targets only `mpl.smartsheetbuilder@gmail.com`, finds an existing
   Auth account before creating one, and saves `role = customer`, `plan = free`,
   `status = active`, `exports_unlimited = true`. Existing passwords and export
   history are preserved. Email confirmation is set through the Auth Admin API
   for immediate password sign-in. Rerunning is safe after a partial failure.
   It refuses to proceed if the target is in the configured admin email list.
4. Restart localhost after configuring its environment: `npm run dev`.

All browser catalog reads and writes go through the protected app API. The SQL
intentionally grants no direct browser access to the library tables/bucket;
visible PNGs are read using the server-issued signed URLs. Existing signed URLs
remain valid until their one-hour expiry. This uses Supabase's documented
[server access and Storage RLS model](https://supabase.com/docs/guides/storage/security/access-control).

### Local verification

Open `http://127.0.0.1:3000`. Confirm spacing starts at 0, add pieces with touching
edges, then download PNG/TIFF normally. Sign in as the owner and confirm **Admin**,
**Unlimited**, and **Manage library**. Sign out and sign in as the provisioned basic
user: confirm **Basic account**, **Unlimited**, direct library access, and no
management or hidden-design controls. Add a visible library PNG, arrange/export,
refresh, and check the account display again. Sign out and verify the library
opens the sign-in gate. An ordinary account still has 5 exports; a guest has 2.

Checks (browser tests require Playwright and Chrome):

```text
npm run build
node tests/access-permissions.test.cjs
node tests/auth-state.test.cjs
node tests/workspace-ui.test.cjs
node tests/zero-spacing.test.cjs
node tests/builder.test.cjs
```

Auth/workspace tests use mocked API responses; access tests execute actual route
handlers against mocked Supabase. Provisioning tests also use a mock server.
Zero-spacing tests download PNG and TIFF files and compare decoded pixels. These
tests do not apply SQL, create live users, verify live RLS, or test Photoshop.

## Current Architecture

- `app/page.jsx` is the V5.3B access wrapper.
- `app/api/auth/*` handles register, login, and current account status.
- `app/api/export/*` checks and consumes PNG/TIFF export usage.
- `app/api/_lib/supabase.js` talks to Supabase Auth and REST using built-in `fetch`.
- `public/builder.html` contains the stable builder and TIFF engine, with export hooks that ask the wrapper before download.
- `public/builder.html` direct online access shows a lock notice so users are guided through the main app wrapper.

## Future Phases

- Add payment/subscription provider.
- Set `profiles.plan = 'subscriber'` when payment is active.
- Add admin dashboard for users, usage, and plan edits.
- Build the subscriber-only free design library using the prepared `design_library` table.
- Move export increments into a Supabase RPC function if you need fully atomic high-traffic counters.
