-- Run AFTER user-management, export-credits and export-enforcement migrations.
-- Service-only access: no browser JWT can read portal secrets, sources or manifests.
begin;
create table if not exists public.client_portals (
 owner_id uuid primary key references public.profiles(id), link_hash text unique not null,
 link_secret text not null, enabled boolean not null default false, settings jsonb not null,
 updated_at timestamptz not null default clock_timestamp()
);
create table if not exists public.client_jobs (
 id uuid primary key, owner_id uuid not null references public.profiles(id), link_hash text not null,
 reference text not null default '', created_at timestamptz not null default clock_timestamp(),
 confirmed_at timestamptz, expires_at timestamptz not null default clock_timestamp()+interval '2 hours',
 revision integer not null default 0, assets jsonb not null default '[]', manifest jsonb,
 design_count integer not null default 0, quantity integer not null default 0, meters numeric not null default 0,
 downloaded_png boolean not null default false, downloaded_tiff boolean not null default false,
 purged_at timestamptz, notification jsonb, notification_sent_at timestamptz,
 notification_attempt_at timestamptz
);
create index if not exists client_jobs_owner_date on public.client_jobs(owner_id,created_at desc);
create index if not exists client_jobs_expiry on public.client_jobs(expires_at) where purged_at is null;
create table if not exists public.client_job_rates(key text primary key, window_start timestamptz not null, count integer not null);
create table if not exists public.client_job_exports(request_key uuid primary key, job_id uuid not null references public.client_jobs(id), owner_id uuid not null, kind text not null, fingerprint text not null);
alter table public.client_portals enable row level security;
alter table public.client_jobs enable row level security;
alter table public.client_job_rates enable row level security;
alter table public.client_job_exports enable row level security;
revoke all on public.client_portals,public.client_jobs,public.client_job_rates,public.client_job_exports from anon,authenticated;
grant all on public.client_portals,public.client_jobs,public.client_job_rates,public.client_job_exports to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('client-job-sources','client-job-sources',false,4194304,array['image/png'])
on conflict(id) do update set public=false,file_size_limit=4194304,allowed_mime_types=array['image/png'];
-- No storage.objects policy is granted for this bucket. Sources use checked proxy routes only.
drop policy if exists client_job_sources_private on storage.objects;
create policy client_job_sources_private on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'client-job-sources') with check(bucket_id<>'client-job-sources');

create or replace function public.ssb_client_jobs(p_action text,p_owner uuid default null,p_link text default null,p_job uuid default null,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare portal public.client_portals; job public.client_jobs; stamp timestamptz:=clock_timestamp(); result jsonb; n integer; item jsonb;
begin
 if p_action='rate' then
  insert into client_job_rates values(p_data->>'key',stamp,1) on conflict(key) do update set
    count=case when client_job_rates.window_start<stamp-interval '1 hour' then 1 else client_job_rates.count+1 end,
    window_start=case when client_job_rates.window_start<stamp-interval '1 hour' then stamp else client_job_rates.window_start end returning count into n;
  return jsonb_build_object('allowed',n<=(p_data->>'limit')::integer);
 end if;
 if p_action='cleanup-list' then
  delete from client_job_rates where window_start<stamp-interval '2 hours';
  return coalesce((select jsonb_agg(to_jsonb(j)) from (select id,assets from client_jobs where expires_at<=stamp and purged_at is null order by expires_at limit 100) j),'[]');
 elsif p_action='purged' then
  update client_jobs set assets='[]',manifest=null,notification=null,purged_at=stamp where id=p_job and expires_at<=stamp;
  return '{}';
 elsif p_action='notifications' then
  with candidates as (select id from client_jobs where notification is not null and notification_sent_at is null and expires_at>stamp and (notification_attempt_at is null or notification_attempt_at<stamp-interval '5 minutes') order by confirmed_at for update skip locked limit 3),
  claimed as (update client_jobs set notification_attempt_at=stamp where id in(select id from candidates) returning id,notification)
  select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into result from claimed; return result;
 elsif p_action='notified' then
  update client_jobs set notification_sent_at=stamp,notification=null where id=p_job; return '{}';
 end if;
 if p_owner is not null then
  if not exists(select 1 from profiles p join auth.users u on u.id=p.id where p.id=p_owner and p.status='active' and u.email_confirmed_at is not null) then raise exception 'Verified active account required' using errcode='42501'; end if;
  if p_action='portal-create' then
   insert into client_portals(owner_id,link_hash,link_secret,enabled,settings) values(p_owner,p_data->>'hash',p_data->>'secret',false,p_data->'settings') on conflict(owner_id) do nothing;
  elsif p_action='portal-save' then
   insert into client_portals(owner_id,link_hash,link_secret,enabled,settings) values(p_owner,p_data->>'hash',p_data->>'secret',(p_data->>'enabled')::boolean,p_data->'settings')
   on conflict(owner_id) do update set link_hash=excluded.link_hash,link_secret=excluded.link_secret,enabled=excluded.enabled,settings=excluded.settings,updated_at=stamp;
  end if;
  select * into portal from client_portals where owner_id=p_owner;
  if p_action in('portal','portal-save','portal-create') then return case when portal.owner_id is null then null else to_jsonb(portal) end; end if;
  if p_action='list' then
   return coalesce((select jsonb_agg(to_jsonb(j)) from (select id,reference,created_at,confirmed_at,expires_at,design_count,quantity,meters,downloaded_png,downloaded_tiff,purged_at,notification_sent_at from client_jobs where owner_id=p_owner order by created_at desc limit 100) j),'[]');
  end if;
 else
  -- Lock the portal so rotation/disable and a public mutation cannot race.
  select c.* into portal from client_portals c where c.link_hash=p_link for update of c;
  if not found then raise exception 'This upload link is invalid or has been replaced. Ask the shop for the current link.' using errcode='P0404'; end if;
  if not portal.enabled then raise exception 'This upload portal is currently disabled.' using errcode='P0403'; end if;
  if not exists(select 1 from profiles p join auth.users u on u.id=p.id where p.id=portal.owner_id and p.status='active' and u.email_confirmed_at is not null) then
   raise exception 'This shop is not currently accepting uploads.' using errcode='P0423';
  end if;
  if p_action='info' then return to_jsonb(portal); end if;
  if p_action='create' then
   if (select count(*) from client_jobs where owner_id=portal.owner_id and expires_at>stamp)>=20 then raise exception 'This shop has reached its temporary submission limit. Please try later.' using errcode='22023'; end if;
   insert into client_jobs(id,owner_id,link_hash) values(p_job,portal.owner_id,p_link) returning * into job;
   return to_jsonb(job);
  end if;
 end if;
 select * into job from client_jobs where id=p_job and (case when p_owner is not null then owner_id=p_owner else owner_id=portal.owner_id and link_hash=p_link end) for update;
 if not found then raise exception 'Client job not found' using errcode='P0002'; end if;
 if job.expires_at<=stamp or job.purged_at is not null then raise exception 'This submission session has expired. Start a new submission.' using errcode='P0410'; end if;
 if p_action='get' then return to_jsonb(job); end if;
 if p_owner is not null then raise exception 'Unsupported owner action' using errcode='22023'; end if;
 if p_action='confirm' and job.confirmed_at is not null then return to_jsonb(job); end if;
 if job.confirmed_at is not null then raise exception 'This submission is already locked.' using errcode='22023'; end if;
 if p_action='reserve' then
  if jsonb_array_length(job.assets)>=10 or (select coalesce(sum((a->>'bytes')::bigint),0) from jsonb_array_elements(job.assets) a)+(p_data->>'bytes')::bigint>33554432
    then raise exception 'Limit: 10 PNGs and 32 MiB per submission.' using errcode='22023'; end if;
  update client_jobs set assets=assets||jsonb_build_array(p_data),manifest=null,revision=revision+1 where id=p_job;
 elsif p_action='ready' then
  update client_jobs set assets=(select jsonb_agg(case when a->>'id'=p_data->>'id' and coalesce((a->>'deleted')::boolean,false)=false then a||p_data||'{"ready":true}'::jsonb else a end) from jsonb_array_elements(assets) a),revision=revision+1 where id=p_job;
 elsif p_action='remove' then
  update client_jobs set assets=(select jsonb_agg(case when a->>'id'=p_data->>'id' then a||'{"ready":false,"deleted":true}'::jsonb else a end) from jsonb_array_elements(assets) a),manifest=null,revision=revision+1 where id=p_job;
 elsif p_action='preview' then
  if job.revision<>(p_data->>'revision')::integer then raise exception 'Submission changed. Generate the preview again.' using errcode='40001'; end if;
  update client_jobs set assets=p_data->'assets',manifest=p_data->'manifest',reference=p_data->>'reference',design_count=(select count(*) from jsonb_array_elements(p_data->'assets') a where (a->>'ready')::boolean),quantity=(p_data->>'quantity')::integer,meters=(p_data->>'meters')::numeric,revision=revision+1 where id=p_job;
 elsif p_action='confirm' then
  if job.manifest is null or job.revision<>(p_data->>'revision')::integer then raise exception 'Generate and review the current preview before confirming.' using errcode='40001'; end if;
  update client_jobs set confirmed_at=stamp,expires_at=stamp+interval '24 hours',notification=p_data->'notification'||jsonb_build_object('expiresAt',stamp+interval '24 hours') where id=p_job;
 else raise exception 'Unsupported client action' using errcode='22023'; end if;
 if p_action in('ready','remove') then
  update client_jobs set design_count=(select count(*) from jsonb_array_elements(assets) a where (a->>'ready')::boolean),quantity=(select coalesce(sum((a->>'qty')::integer),0) from jsonb_array_elements(assets) a where (a->>'ready')::boolean) where id=p_job;
 end if;
 select * into job from client_jobs where id=p_job; return to_jsonb(job);
end $$;

-- Quota and expiry checks share one transaction. Finalize/refund may complete after expiry.
create or replace function public.ssb_client_job_export(p_user uuid,p_job uuid,p_kind text,p_request uuid,p_fingerprint text,p_action text,p_receipt uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.client_jobs; r jsonb; binding public.client_job_exports;
begin
 select * into j from client_jobs where id=p_job and owner_id=p_user for update;
 if not found then raise exception 'Client job not found' using errcode='42501'; end if;
 if p_action in('prepare','consume') and (j.confirmed_at is null or j.expires_at<=clock_timestamp() or j.manifest is null) then raise exception 'Client job expired or not confirmed' using errcode='42501'; end if;
 if p_action='prepare' then return jsonb_build_object('allowed',true); end if;
 if p_action='consume' then
  insert into client_job_exports values(p_request,p_job,p_user,p_kind,p_fingerprint) on conflict do nothing;
 end if;
 select * into binding from client_job_exports where request_key=p_request;
 if not found or binding.job_id<>p_job or binding.owner_id<>p_user or binding.kind<>p_kind or binding.fingerprint<>p_fingerprint then raise exception 'Invalid client job export' using errcode='42501'; end if;
 r=ssb_credit_export(p_user,p_kind,p_request,p_fingerprint,p_action,p_receipt);
 if p_action='saved' and (r->>'allowed')::boolean and exists(select 1 from export_credit_receipts where id=p_receipt and state='saved') then
  update client_jobs set downloaded_png=downloaded_png or p_kind='png',downloaded_tiff=downloaded_tiff or p_kind='tiff' where id=p_job;
 end if;
 return r;
end $$;
revoke all on function public.ssb_client_jobs(text,uuid,text,uuid,jsonb),public.ssb_client_job_export(uuid,uuid,text,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.ssb_client_jobs(text,uuid,text,uuid,jsonb),public.ssb_client_job_export(uuid,uuid,text,uuid,text,text,uuid) to service_role;
notify pgrst,'reload schema';
commit;
