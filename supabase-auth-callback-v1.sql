-- Run AFTER supabase-password-recovery-v1.sql. No account/role/quota changes.
begin;
alter table public.password_recovery_tickets add column if not exists implicit_proof text;
create unique index if not exists password_recovery_implicit_once
  on public.password_recovery_tickets(implicit_proof) where implicit_proof is not null;
create or replace function public.ssb_create_implicit_password_recovery(p_user uuid,p_proof text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare ticket uuid;
begin
  if p_proof !~ '^[0-9a-f]{64}$' or p_proof is null then raise exception 'Invalid recovery proof'; end if;
  -- Keep replay tombstones longer than the accepted 15-minute email session.
  delete from public.password_recovery_tickets where expires_at<now()-interval '1 day';
  insert into public.password_recovery_tickets(user_id,implicit_proof) values(p_user,p_proof)
    on conflict do nothing returning id into ticket;
  if ticket is null then raise exception 'Recovery link already used' using errcode='22023'; end if;
  return ticket;
end $$;
revoke all on function public.ssb_create_implicit_password_recovery(uuid,text) from public,anon,authenticated;
grant execute on function public.ssb_create_implicit_password_recovery(uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
