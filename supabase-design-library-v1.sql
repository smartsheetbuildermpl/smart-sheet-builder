-- Smart Sheet Builder Design Library V1
-- Run this once in the Supabase SQL Editor for the same project configured in .env.local.
-- It creates new tables and a Storage bucket only; it does not alter or delete existing data.

create extension if not exists pgcrypto;

create table if not exists public.design_library_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint design_library_categories_name_not_blank check (length(trim(name)) > 0)
);

create table if not exists public.design_library_designs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_id uuid references public.design_library_categories(id) on delete set null,
  tags text[] not null default '{}',
  storage_path text not null unique,
  width_px integer check (width_px is null or width_px > 0),
  height_px integer check (height_px is null or height_px > 0),
  visible boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint design_library_designs_name_not_blank check (length(trim(name)) > 0)
);

create index if not exists design_library_categories_sort_order_idx
  on public.design_library_categories (sort_order, name);
create index if not exists design_library_designs_visible_idx
  on public.design_library_designs (visible, created_at desc);
create index if not exists design_library_designs_category_idx
  on public.design_library_designs (category_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('smart-sheet-library', 'smart-sheet-library', false, 16777216, array['image/png'])
on conflict (id) do nothing;

-- The app's server routes use the service role after they verify the current signed-in
-- user and existing admin role. The bucket stays private; catalog responses contain
-- only short-lived signed image URLs. No browser client receives the service role key.
