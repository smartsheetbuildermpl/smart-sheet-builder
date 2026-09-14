-- Run in Supabase Dashboard > the configured project > SQL Editor > New query.
-- Prerequisites: supabase-smart-sheet-v53b.sql and supabase-design-library-v1.sql.
-- Adds a server-managed export entitlement; does not reset usage or delete data.
begin;

alter table public.profiles
  add column if not exists exports_unlimited boolean not null default false;
comment on column public.profiles.exports_unlimited is
  'Server-managed unlimited exports, independent of admin role and subscription plan.';

-- Profiles are read by their owners, written only by the existing server routes.
-- Restrictive policies also guard against any broader permissive policies.
alter table public.profiles enable row level security;
revoke insert, update, delete on public.profiles from public, anon, authenticated;
drop policy if exists "profiles_server_insert_only" on public.profiles;
create policy "profiles_server_insert_only" on public.profiles as restrictive
  for insert to anon, authenticated with check (false);
drop policy if exists "profiles_server_update_only" on public.profiles;
create policy "profiles_server_update_only" on public.profiles as restrictive
  for update to anon, authenticated using (false) with check (false);
drop policy if exists "profiles_server_delete_only" on public.profiles;
create policy "profiles_server_delete_only" on public.profiles as restrictive
  for delete to anon, authenticated using (false);

-- All catalog access goes through /api/library. The server verifies Supabase
-- identity, limits non-owner reads to visible designs, and allows only the owner
-- to mutate. No browser role can bypass that gate using PostgREST directly.
alter table public.design_library_categories enable row level security;
alter table public.design_library_designs enable row level security;
revoke all on public.design_library_categories, public.design_library_designs
  from public, anon, authenticated;
grant all on public.design_library_categories, public.design_library_designs to service_role;
drop policy if exists "library_categories_server_only" on public.design_library_categories;
create policy "library_categories_server_only" on public.design_library_categories as restrictive
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "library_designs_server_only" on public.design_library_designs;
create policy "library_designs_server_only" on public.design_library_designs as restrictive
  for all to anon, authenticated using (false) with check (false);

-- Scope this restriction to our bucket, leaving other Storage buckets alone.
-- Server-issued signed URLs still let signed-in users load visible PNGs.
update storage.buckets set public = false where id = 'smart-sheet-library';
drop policy if exists "smart_sheet_library_server_only" on storage.objects;
create policy "smart_sheet_library_server_only" on storage.objects as restrictive
  for all to anon, authenticated
  using (bucket_id <> 'smart-sheet-library')
  with check (bucket_id <> 'smart-sheet-library');

commit;
