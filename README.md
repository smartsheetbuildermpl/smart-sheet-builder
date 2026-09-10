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
