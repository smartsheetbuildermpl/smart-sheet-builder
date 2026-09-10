# Supabase Setup For Smart Sheet Builder V5.3B

## 1. Create Project

Create a Supabase project, then copy:

- Project URL
- Anon public key
- Service role secret key

## 2. Run SQL

Open Supabase SQL Editor and run:

```sql
-- Paste the full contents of supabase-smart-sheet-v53b.sql here.
```

## 3. Add Vercel Environment Variables

In Vercel, open:

Project Settings -> Environment Variables

Add:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
SMART_SHEET_ADMIN_EMAILS=your-email@example.com
NEXT_PUBLIC_SMART_SHEET_ADMIN_EMAILS=your-email@example.com
```

Redeploy after saving.

## 4. Test Flow

1. Open the deployed Vercel URL in an incognito/private window.
2. Export PNG or TIFF twice as guest.
3. Third export should ask for account.
4. Register with email and password.
5. Registered free account should show 3 left if the guest already used 2 exports.
6. Export three more times.
7. Next export should be blocked unless the account is admin/subscriber.

## Notes

- If the header says `Local test mode`, Supabase env vars are missing or incomplete.
- If the header says `Server protected`, the app is using Supabase-backed API routes.
- For future subscribers, update `profiles.plan` to `subscriber`.
- For admin access, set the account email in `SMART_SHEET_ADMIN_EMAILS` before the user signs in, or manually set `role = 'admin'` and `plan = 'admin'`.
