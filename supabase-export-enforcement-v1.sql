-- Run AFTER supabase-export-credits-v1.sql. Guest identity is issued only by the server.
begin;
create table if not exists public.guest_trial_networks(network_hash text primary key, window_start timestamptz not null, creations integer not null);
create table if not exists public.guest_export_receipts(
  id uuid primary key default gen_random_uuid(), guest_id text not null references public.guest_usage(guest_id),
  request_key uuid not null, fingerprint text not null, export_kind text not null check(export_kind in ('png','tiff')),
  state text not null default 'ready' check(state in ('ready','saved','refunded')),
  usage_id bigint references public.usage_exports(id), created_at timestamptz not null default clock_timestamp(), unique(guest_id,request_key)
);
alter table public.guest_trial_networks enable row level security;
alter table public.guest_export_receipts enable row level security;
revoke all on public.guest_trial_networks,public.guest_export_receipts,public.guest_usage from public,anon,authenticated;
grant all on public.guest_trial_networks,public.guest_export_receipts,public.guest_usage to service_role;

create or replace function public.ssb_create_guest(p_guest text,p_network text default null,p_legacy text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare n integer; spent integer=0; stamp timestamptz=clock_timestamp();
begin
  if p_network is not null then
    insert into guest_trial_networks values(p_network,stamp,1) on conflict(network_hash) do update
      set creations=case when guest_trial_networks.window_start<stamp-interval '1 hour' then 1 else guest_trial_networks.creations+1 end,
          window_start=case when guest_trial_networks.window_start<stamp-interval '1 hour' then stamp else guest_trial_networks.window_start end
      returning creations into n;
    if n>30 then return jsonb_build_object('allowed',false); end if;
    delete from guest_trial_networks where window_start<stamp-interval '24 hours';
  end if;
  if p_legacy is not null then
    select least(2,greatest(coalesce((select exports_used from guest_usage where guest_id=p_legacy),0),
      (select count(*) from usage_exports where guest_id=p_legacy and voided_at is null)))::integer into spent;
  end if;
  insert into guest_usage(guest_id,exports_used) values(p_guest,spent) on conflict do nothing;
  return jsonb_build_object('allowed',true);
end $$;

create or replace function public.ssb_guest_export(p_guest text,p_kind text,p_request uuid,p_fingerprint text,p_action text default 'consume',p_receipt uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare g public.guest_usage; r public.guest_export_receipts; usage_key bigint;
begin
  select * into strict g from guest_usage where guest_id=p_guest for update;
  if p_kind not in ('png','tiff') or p_action not in ('consume','saved','refund') or p_request is null or p_fingerprint is null or length(p_fingerprint) not between 8 and 200 then raise exception 'Invalid export request'; end if;
  if p_action in ('saved','refund') then
    select * into strict r from guest_export_receipts where id=p_receipt and guest_id=p_guest and request_key=p_request and export_kind=p_kind and fingerprint=p_fingerprint for update;
    if r.state='ready' then
      update guest_export_receipts set state=case when p_action='saved' then 'saved' else 'refunded' end where id=r.id;
      if p_action='refund' then
        update guest_usage set exports_used=greatest(0,exports_used-1) where guest_id=p_guest returning * into g;
        update usage_exports set voided_at=clock_timestamp() where id=r.usage_id;
      end if;
    end if;
    return jsonb_build_object('allowed',true,'guest',to_jsonb(g));
  end if;
  select * into r from guest_export_receipts where guest_id=p_guest and request_key=p_request;
  if found then
    if r.export_kind<>p_kind or r.fingerprint<>p_fingerprint or r.state<>'ready' or r.created_at<clock_timestamp()-interval '2 minutes' then
      return jsonb_build_object('allowed',false,'reason','retry_expired','message','Start a new export attempt.','guest',to_jsonb(g));
    end if;
    return jsonb_build_object('allowed',true,'duplicate',true,'receipt',r.id,'guest',to_jsonb(g));
  end if;
  if g.exports_used>=2 then return jsonb_build_object('allowed',false,'reason','limit_reached','message','Guest trial used up. Create a free account for Free Export Credits.','guest',to_jsonb(g)); end if;
  update guest_usage set exports_used=exports_used+1,last_export_at=clock_timestamp() where guest_id=p_guest returning * into g;
  insert into usage_exports(guest_id,export_kind) values(p_guest,p_kind) returning id into usage_key;
  insert into guest_export_receipts(guest_id,request_key,fingerprint,export_kind,usage_id) values(p_guest,p_request,p_fingerprint,p_kind,usage_key) returning * into r;
  return jsonb_build_object('allowed',true,'duplicate',false,'receipt',r.id,'guest',to_jsonb(g));
end $$;
revoke all on function public.ssb_create_guest(text,text,text),public.ssb_guest_export(text,text,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.ssb_create_guest(text,text,text),public.ssb_guest_export(text,text,uuid,text,text,uuid) to service_role;
-- A completed receipt cannot authorize another download at zero balance.
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
    if r.export_kind<>p_kind or r.fingerprint<>p_fingerprint or r.state<>'ready' or r.created_at<stamp-interval '2 minutes' then
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
notify pgrst,'reload schema';
commit;
