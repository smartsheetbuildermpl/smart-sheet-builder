# Smart Sheet Builder by Master PrintLab

Vercel-ready Next.js wrapper for Smart Sheet Builder V5.3A.

V5.3A keeps the stable V5.2.4 Photoshop-compatible PNG/TIFF export engine and adds the first access/usage gate foundation:

- Guest users: 2 free exports
- Registered free users: 5 total exports
- Export usage is counted only on PNG/TIFF download
- Subscription, credits, admin dashboard, and subscriber-only free design library are prepared as next phases

## Local Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy To Vercel

1. Push this folder to GitHub.
2. Import the repo in Vercel.
3. Framework preset: `Next.js`.
4. Build command: `npm run build`.
5. Output directory: leave default.

## Current Architecture

- `app/page.jsx` is the V5.3A access wrapper and local trial account gate.
- `public/builder.html` contains the stable builder and TIFF engine, with export hooks that ask the wrapper before download.
- `public/builder.html` direct online access shows a lock notice so users are guided through the main app wrapper.
- V5.3B should move account, usage, subscription, and credits from local storage to Supabase tables.

## Optional Admin Setting

In Vercel Environment Variables, add:

```bash
NEXT_PUBLIC_SMART_SHEET_ADMIN_EMAILS=your-email@example.com
```

Comma-separated emails listed here become unlimited local admin accounts when they register in V5.3A.

## Planned Supabase Tables For V5.3B

- `profiles` — user role, plan, status
- `usage_exports` — every PNG/TIFF export event
- `subscriptions` — active paid plan and expiration
- `credit_ledger` — credit purchases and deductions
- `design_library` — future free design database for subscribed users
