create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  role text not null default 'customer' check (role in ('customer', 'admin')),
  plan text not null default 'free' check (plan in ('free', 'subscriber', 'admin')),
  status text not null default 'active' check (status in ('active', 'blocked')),
  exports_used integer not null default 0 check (exports_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.guest_usage (
  guest_id text primary key,
  exports_used integer not null default 0 check (exports_used >= 0),
  last_export_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_exports (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  guest_id text,
  export_kind text not null default 'download',
  counted_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  status text not null default 'inactive',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.design_library (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  storage_path text not null,
  preview_url text,
  tags text[] not null default '{}',
  subscriber_only boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_email_idx on public.profiles (email);
create index if not exists usage_exports_user_id_idx on public.usage_exports (user_id);
create index if not exists usage_exports_guest_id_idx on public.usage_exports (guest_id);
create index if not exists design_library_active_idx on public.design_library (active);

alter table public.profiles enable row level security;
alter table public.guest_usage enable row level security;
alter table public.usage_exports enable row level security;
alter table public.subscriptions enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.design_library enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
on public.profiles
for select
to authenticated
using (auth.uid() = id);

drop policy if exists "Users can read their own subscriptions" on public.subscriptions;
create policy "Users can read their own subscriptions"
on public.subscriptions
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can read their own credits" on public.credit_ledger;
create policy "Users can read their own credits"
on public.credit_ledger
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Subscribers can read active design library" on public.design_library;
create policy "Subscribers can read active design library"
on public.design_library
for select
to authenticated
using (
  active = true
  and exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.status = 'active'
      and profiles.plan in ('subscriber', 'admin')
  )
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists guest_usage_touch_updated_at on public.guest_usage;
create trigger guest_usage_touch_updated_at
before update on public.guest_usage
for each row execute function public.touch_updated_at();

drop trigger if exists subscriptions_touch_updated_at on public.subscriptions;
create trigger subscriptions_touch_updated_at
before update on public.subscriptions
for each row execute function public.touch_updated_at();

drop trigger if exists design_library_touch_updated_at on public.design_library;
create trigger design_library_touch_updated_at
before update on public.design_library
for each row execute function public.touch_updated_at();
