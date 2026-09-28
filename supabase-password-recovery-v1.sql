-- Run after supabase-user-management-v1.sql, in Smart Sheet Builder's project.
begin;
do $$ begin
  if to_regclass('public.user_access_history') is null then raise exception 'Run supabase-user-management-v1.sql first'; end if;
end $$;
create table if not exists public.password_recovery_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now()+interval '15 minutes'),
  used_at timestamptz
);
alter table public.password_recovery_tickets enable row level security;
revoke all on public.password_recovery_tickets from public,anon,authenticated;
create index if not exists password_recovery_tickets_expiry on public.password_recovery_tickets(expires_at);
create or replace function public.ssb_create_password_recovery(p_user uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare ticket uuid;
begin
  delete from public.password_recovery_tickets where expires_at<now();
  insert into public.password_recovery_tickets(user_id) values(p_user) returning id into ticket;
  return ticket;
end $$;
create or replace function public.ssb_claim_password_recovery(p_user uuid,p_ticket uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.password_recovery_tickets set used_at=now() where id=p_ticket and user_id=p_user and used_at is null and expires_at>now();
  return found;
end $$;
create or replace function public.ssb_record_password_change(p_user uuid) returns void
language sql security definer set search_path=public,pg_temp as $$
  insert into public.user_access_history(user_id,actor_id,event) values(p_user,p_user,'password_changed_by_user');
$$;
revoke all on function public.ssb_create_password_recovery(uuid),public.ssb_claim_password_recovery(uuid,uuid),public.ssb_record_password_change(uuid) from public,anon,authenticated;
grant execute on function public.ssb_create_password_recovery(uuid),public.ssb_claim_password_recovery(uuid,uuid),public.ssb_record_password_change(uuid) to service_role;
notify pgrst,'reload schema';
commit;
