-- Run after supabase-user-management-v1.sql. Safe to repeat; never resets balances.
begin;
create table if not exists public.free_export_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 2 check (balance between 0 and 2),
  refill_from timestamptz,
  check ((balance=2 and refill_from is null) or (balance<2 and refill_from is not null))
);
create table if not exists public.export_credit_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_key uuid not null,
  fingerprint text not null,
  export_kind text not null check (export_kind in ('png','tiff')),
  charged boolean not null,
  state text not null default 'ready' check (state in ('ready','saved','refunded')),
  usage_id bigint references public.usage_exports(id),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,request_key)
);
create index if not exists export_receipts_retry on public.export_credit_receipts(user_id,fingerprint,created_at desc);
alter table public.usage_exports add column if not exists voided_at timestamptz;
create index if not exists credit_ledger_user_date on public.credit_ledger(user_id,created_at desc,id desc);
alter table public.free_export_credits enable row level security;
alter table public.export_credit_receipts enable row level security;
revoke all on public.free_export_credits,public.export_credit_receipts,public.credit_ledger from public,anon,authenticated;
grant select on public.free_export_credits,public.credit_ledger to authenticated;
grant all on public.free_export_credits,public.export_credit_receipts,public.credit_ledger to service_role;
grant usage,select on sequence public.credit_ledger_id_seq to service_role;
drop policy if exists free_credits_self on public.free_export_credits;
create policy free_credits_self on public.free_export_credits for select to authenticated using(user_id=auth.uid());
drop policy if exists free_credits_self_guard on public.free_export_credits;
create policy free_credits_self_guard on public.free_export_credits as restrictive for select to authenticated using(user_id=auth.uid());
drop policy if exists credit_history_self_guard on public.credit_ledger;
create policy credit_history_self_guard on public.credit_ledger as restrictive for select to authenticated using(user_id=auth.uid());

-- Initial balances are independent of lifetime exports. Log only grants made now.
with added as (
  insert into public.free_export_credits(user_id) select id from public.profiles
  where not public.ssb_unlimited(profiles) on conflict do nothing returning user_id
) insert into public.credit_ledger(user_id,delta,reason,metadata)
select user_id,2,'free_refill','{"source":"initial_balance","balance":2}'::jsonb from added;

create or replace function public.ssb_credit_snapshot(p_user uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.profiles; c public.free_export_credits; stamp timestamptz; steps integer; added integer;
begin
  -- Same lock order as access changes and export consumption.
  select * into strict p from public.profiles where id=p_user for update;
  stamp=clock_timestamp();
  if public.ssb_unlimited(p) then return jsonb_build_object('balance',null,'next_credit_at',null,'server_time',stamp,'unlimited',true); end if;
  insert into public.free_export_credits(user_id) values(p_user) on conflict do nothing;
  if found then insert into public.credit_ledger(user_id,delta,reason,metadata) values(p_user,2,'free_refill','{"source":"initial_balance","balance":2}'); end if;
  select * into strict c from public.free_export_credits where user_id=p_user for update;
  if c.balance<2 then
    steps=greatest(0,floor(extract(epoch from (stamp-c.refill_from))/10800)::integer);
    added=least(2-c.balance,steps);
    if added>0 then
      update public.free_export_credits set balance=balance+added,
        refill_from=case when balance+added=2 then null else refill_from+added*interval '3 hours' end
        where user_id=p_user returning * into c;
      insert into public.credit_ledger(user_id,delta,reason,metadata)
      values(p_user,added,'free_refill',jsonb_build_object('balance',c.balance,'completed_intervals',added));
    end if;
  end if;
  return jsonb_build_object('balance',c.balance,'next_credit_at',c.refill_from+interval '3 hours','server_time',stamp,'unlimited',false);
end $$;

-- New verified accounts get their own balance; no guest counter is transferred.
create or replace function public.ssb_initial_free_credits() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.email_confirmed_at is not null and exists(select 1 from public.profiles where id=new.id) then
    perform public.ssb_credit_snapshot(new.id);
  end if;
  return new;
end $$;
drop trigger if exists zz_ssb_initial_free_credits on auth.users;
create trigger zz_ssb_initial_free_credits after insert or update of email_confirmed_at on auth.users
for each row execute function public.ssb_initial_free_credits();

create or replace function public.ssb_import_guest_usage(p_user uuid,p_guest text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.profiles;
begin
  select * into strict p from public.profiles where id=p_user for update;
  if p.status='blocked' then raise exception 'Account suspended' using errcode='42501'; end if;
  if not exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null) then raise exception 'Verify your email' using errcode='42501'; end if;
  return to_jsonb(p);
end $$;

-- Retire the old non-idempotent lifetime counter entry point, including old tabs.
create or replace function public.ssb_consume_export(p_user uuid,p_kind text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin return jsonb_build_object('allowed',false,'reason','refresh_required','message','Refresh Smart Sheet Builder to use Free Export Credits.'); end $$;

create or replace function public.ssb_credit_export(p_user uuid,p_kind text,p_request uuid,p_fingerprint text,p_action text default 'consume',p_receipt uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.profiles; snap jsonb; r public.export_credit_receipts; n integer; restored integer; stamp timestamptz; usage_key bigint;
begin
  select * into strict p from public.profiles where id=p_user for update;
  if p_action not in ('consume','saved','refund') or p_kind not in ('png','tiff') or p_request is null or p_fingerprint is null or length(p_fingerprint)>200 or length(p_fingerprint)<8 then
    raise exception 'Invalid export request' using errcode='22023';
  end if;
  snap=public.ssb_credit_snapshot(p_user); stamp=clock_timestamp();
  -- Finalization/refund is always restricted to the original authenticated user.
  if p_action in ('saved','refund') then
    select * into r from public.export_credit_receipts where id=p_receipt and user_id=p_user and request_key=p_request and export_kind=p_kind and fingerprint=p_fingerprint for update;
    if not found then raise exception 'Export receipt not found' using errcode='42501'; end if;
    if p_action='saved' and r.state='ready' then
      update public.export_credit_receipts set state='saved' where id=r.id;
    elsif p_action='refund' and r.state='ready' then
      -- Saved receipts cannot be refunded; repeated failure callbacks are no-ops.
      update public.export_credit_receipts set state='refunded' where id=r.id;
      update public.usage_exports set voided_at=stamp where id=r.usage_id;
      if r.charged then
        select least(1,2-balance) into restored from public.free_export_credits where user_id=p_user;
        update public.free_export_credits set balance=least(2,balance+1),refill_from=case when balance+1>=2 then null else refill_from end where user_id=p_user returning balance into n;
        insert into public.credit_ledger(user_id,delta,reason,metadata) values(p_user,restored,'export_refunded',jsonb_build_object('receipt',r.id,'balance',n,'reason','save_failed'));
        update public.profiles set exports_used=greatest(0,exports_used-1) where id=p_user returning * into p;
      end if;
      snap=public.ssb_credit_snapshot(p_user);
    end if;
    return jsonb_build_object('allowed',true,'credits',snap,'profile',to_jsonb(p));
  end if;
  if p.status='blocked' then return jsonb_build_object('allowed',false,'reason','account_blocked','message','This account is suspended. Contact support.','credits',snap,'profile',to_jsonb(p)); end if;
  if not exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null) then
    return jsonb_build_object('allowed',false,'reason','email_unverified','message','Verify your email before exporting.','credits',snap,'profile',to_jsonb(p));
  end if;
  select * into r from public.export_credit_receipts where user_id=p_user and request_key=p_request;
  if found then
    if r.export_kind<>p_kind or r.fingerprint<>p_fingerprint or r.state='refunded' or r.created_at<stamp-interval '2 minutes' then
      return jsonb_build_object('allowed',false,'reason','retry_expired','message','Start a new export attempt.','credits',snap,'profile',to_jsonb(p));
    end if;
    return jsonb_build_object('allowed',true,'duplicate',true,'receipt',r.id,'credits',snap,'profile',to_jsonb(p));
  end if;
  if not public.ssb_unlimited(p) and (snap->>'balance')::integer=0 then
    return jsonb_build_object('allowed',false,'reason','credits_empty','message','You’ve used your available free export credits.','credits',snap,'profile',to_jsonb(p));
  end if;
  insert into public.usage_exports(user_id,export_kind) values(p_user,p_kind) returning id into usage_key;
  insert into public.export_credit_receipts(user_id,request_key,fingerprint,export_kind,charged,usage_id)
  values(p_user,p_request,p_fingerprint,p_kind,not public.ssb_unlimited(p),usage_key) returning * into r;
  if r.charged then
    update public.free_export_credits set balance=balance-1,refill_from=coalesce(refill_from,stamp) where user_id=p_user returning balance into n;
    insert into public.credit_ledger(user_id,delta,reason,metadata) values(p_user,-1,'export_consumed',jsonb_build_object('receipt',r.id,'format',p_kind,'balance',n));
    update public.profiles set exports_used=exports_used+1 where id=p_user returning * into p;
    snap=public.ssb_credit_snapshot(p_user);
  end if;
  return jsonb_build_object('allowed',true,'duplicate',false,'receipt',r.id,'credits',snap,'profile',to_jsonb(p));
end $$;

-- Keep existing access/profile history; failed deliveries are no longer exports.
create or replace function public.ssb_admin_user(p_actor uuid,p_target uuid,p_offset integer default 0)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result jsonb; snap jsonb;
begin
  perform public.ssb_require_owner(p_actor);
  snap=public.ssb_credit_snapshot(p_target);
  select to_jsonb(p)||jsonb_build_object('email',u.email,'registered_at',u.created_at,'last_sign_in_at',u.last_sign_in_at,
    'email_confirmed_at',u.email_confirmed_at,'account_status',case when p.status='blocked' then 'suspended' when u.email_confirmed_at is null then 'pending_email_verification' else 'active' end,
    'export_access',case when public.ssb_unlimited(p) then 'unlimited' else 'standard' end,
    'remaining',snap->'balance',
    'can_manage_design_library',p.is_super_admin and p.status='active' and u.email_confirmed_at is not null,
    'recorded_exports',(select count(*) from public.usage_exports where user_id=p.id and voided_at is null)) into result
  from public.profiles p join auth.users u on u.id=p.id where p.id=p_target;
  if result is null then raise exception 'User not found' using errcode='P0002'; end if;
  return jsonb_build_object('user',result,'history',coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc,h.sort_key desc) from (
    select * from (
      select 'audit-'||a.id as sort_key,a.event,a.old_value,a.new_value,a.created_at,a.actor_id,au.email as actor_email
      from public.user_access_history a left join auth.users au on au.id=a.actor_id where a.user_id=p_target
      union all
      select 'export-'||e.id,'export',null,jsonb_build_object('format',e.export_kind),e.counted_at,e.user_id,null
      from public.usage_exports e where e.user_id=p_target and e.voided_at is null
    ) events order by created_at desc,sort_key desc limit 30 offset greatest(0,least(p_offset,1000000))
  ) h),'[]'::jsonb));
end $$;

create or replace function public.ssb_credit_history(p_actor uuid,p_target uuid,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare snap jsonb;
begin
  if p_actor<>p_target then perform public.ssb_require_owner(p_actor); end if;
  if p_actor is null or p_target is null then raise exception 'User required' using errcode='42501'; end if;
  snap=public.ssb_credit_snapshot(p_target);
  return jsonb_build_object('credits',snap,'history',coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id desc) from
    (select id,delta,reason,metadata,created_at from public.credit_ledger where user_id=p_target order by created_at desc,id desc limit 30 offset greatest(0,least(p_offset,1000000))) h),'[]'::jsonb));
end $$;

revoke all on function public.ssb_credit_snapshot(uuid),public.ssb_initial_free_credits(),public.ssb_credit_export(uuid,text,uuid,text,text,uuid),public.ssb_credit_history(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.ssb_credit_snapshot(uuid),public.ssb_credit_export(uuid,text,uuid,text,text,uuid),public.ssb_credit_history(uuid,uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
