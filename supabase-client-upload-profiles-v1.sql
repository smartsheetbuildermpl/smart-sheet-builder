-- Apply AFTER supabase-client-jobs-v1.sql. Additive, rerunnable, service-only.
begin;
create table if not exists public.client_upload_profiles (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references public.profiles(id),
 template_key text, name text not null check(length(btrim(name)) between 1 and 120),
 link_hash text unique not null, link_secret text not null, enabled boolean not null default false,
 settings jsonb not null, updated_at timestamptz not null default clock_timestamp(),
 unique(owner_id,template_key)
);
alter table public.client_upload_profiles enable row level security;
revoke all on public.client_upload_profiles from public,anon,authenticated;
grant all on public.client_upload_profiles to service_role;
insert into public.client_upload_profiles(owner_id,template_key,name,link_hash,link_secret,enabled,settings)
 select owner_id,'legacy','Legacy / Default Profile',link_hash,link_secret,enabled,settings from public.client_portals
 on conflict(owner_id,template_key) do nothing;
alter table public.client_jobs add column if not exists profile_id uuid references public.client_upload_profiles(id);
alter table public.client_jobs add column if not exists profile_name text;
alter table public.client_jobs add column if not exists machine text;
create index if not exists client_jobs_profile_date on public.client_jobs(profile_id,created_at desc);
update public.client_jobs j set profile_id=p.id,profile_name='Legacy / Default Profile',machine=j.manifest->'config'->>'machine'
 from public.client_upload_profiles p where j.link_hash=p.link_hash and j.owner_id=p.owner_id and j.profile_id is null;

-- Retain the original maintenance, export and legacy owner operations exactly.
do $$ begin
 if to_regprocedure('public.ssb_client_jobs_legacy_v1(text,uuid,text,uuid,jsonb)') is null then
  alter function public.ssb_client_jobs(text,uuid,text,uuid,jsonb) rename to ssb_client_jobs_legacy_v1;
 end if;
end $$;
revoke all on function public.ssb_client_jobs_legacy_v1(text,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ssb_client_jobs_legacy_v1(text,uuid,text,uuid,jsonb) to service_role;

create or replace function public.ssb_client_jobs(p_action text,p_owner uuid default null,p_link text default null,p_job uuid default null,p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare portal public.client_upload_profiles; job public.client_jobs; stamp timestamptz:=clock_timestamp(); result jsonb; item jsonb;
begin
 if p_action in('rate','cleanup-list','purged','notifications','notified') then
  return ssb_client_jobs_legacy_v1(p_action,p_owner,p_link,p_job,p_data);
 end if;
 if p_owner is not null then
  if not exists(select 1 from profiles p join auth.users u on u.id=p.id where p.id=p_owner and p.status='active' and u.email_confirmed_at is not null) then raise exception 'Verified active account required' using errcode='42501'; end if;
  if p_action in('portal','portal-create','portal-save') then
   if p_action='portal-save' then perform 1 from client_upload_profiles where owner_id=p_owner and template_key='legacy' for update; end if;
   result:=ssb_client_jobs_legacy_v1(p_action,p_owner,p_link,p_job,p_data);
   if result is not null then
    insert into client_upload_profiles(owner_id,template_key,name,link_hash,link_secret,enabled,settings)
    values(p_owner,'legacy','Legacy / Default Profile',result->>'link_hash',result->>'link_secret',(result->>'enabled')::boolean,result->'settings')
    on conflict(owner_id,template_key) do update set link_hash=excluded.link_hash,link_secret=excluded.link_secret,enabled=excluded.enabled,settings=excluded.settings,updated_at=stamp where p_action='portal-save';
   end if;
   return result;
  elsif p_action='profiles-init' then
   for item in select value from jsonb_array_elements(p_data->'templates') loop
    insert into client_upload_profiles(owner_id,template_key,name,link_hash,link_secret,settings)
    values(p_owner,item->>'key',item->>'name',item->>'hash',item->>'secret',item->'settings') on conflict(owner_id,template_key) do nothing;
   end loop;
  elsif p_action='profile-create' then
   if (select count(*) from client_upload_profiles where owner_id=p_owner)>=50 then raise exception 'Limit: 50 upload profiles per shop. Disable an unused profile instead.' using errcode='22023'; end if;
   insert into client_upload_profiles(owner_id,name,link_hash,link_secret,settings)
    values(p_owner,p_data->>'name',p_data->>'hash',p_data->>'secret',p_data->'settings') returning * into portal;
   return to_jsonb(portal);
  elsif p_action in('profile-get','profile-save') then
   select * into portal from client_upload_profiles where id=(p_data->>'id')::uuid and owner_id=p_owner for update;
   if not found then raise exception 'Upload profile not found' using errcode='42501'; end if;
   if p_action='profile-save' then
    update client_upload_profiles set name=p_data->>'name',settings=p_data->'settings',enabled=(p_data->>'enabled')::boolean,link_hash=p_data->>'hash',link_secret=p_data->>'secret',updated_at=stamp where id=portal.id returning * into portal;
    -- Preserve the legacy API record as well; never alter a job or its old token binding.
    if portal.template_key='legacy' then update client_portals set link_hash=portal.link_hash,link_secret=portal.link_secret,enabled=portal.enabled,settings=portal.settings,updated_at=stamp where owner_id=p_owner; end if;
   end if;
   return to_jsonb(portal);
  end if;
  if p_action in('profiles-init','profiles-list') then
   return coalesce((select jsonb_agg(to_jsonb(p) order by case p.template_key when 'legacy' then 0 when 'dtf' then 1 when 'uvdtf24' then 2 when 'uvdtf12' then 3 when 'tarpaulin' then 4 else 5 end,p.name,p.id) from client_upload_profiles p where owner_id=p_owner),'[]');
  end if;
  if p_action='list' then
   return coalesce((select jsonb_agg(to_jsonb(j)) from (select id,reference,profile_id,profile_name,machine,created_at,confirmed_at,expires_at,design_count,quantity,meters,downloaded_png,downloaded_tiff,purged_at,notification_sent_at from client_jobs where owner_id=p_owner order by created_at desc limit 100) j),'[]');
  end if;
  if p_action<>'get' then raise exception 'Unsupported owner action' using errcode='22023'; end if;
 else
  select * into portal from client_upload_profiles where link_hash=p_link for update;
  if not found then raise exception 'This upload link is invalid or has been replaced. Ask the shop for the current link.' using errcode='P0404'; end if;
  if not portal.enabled then raise exception 'This upload portal is currently disabled.' using errcode='P0403'; end if;
  if not exists(select 1 from profiles p join auth.users u on u.id=p.id where p.id=portal.owner_id and p.status='active' and u.email_confirmed_at is not null) then raise exception 'This shop is not currently accepting uploads.' using errcode='P0423'; end if;
  if p_action='info' then return to_jsonb(portal); end if;
  if p_action='create' then
   if (select count(*) from client_jobs where owner_id=portal.owner_id and expires_at>stamp)>=20 then raise exception 'This shop has reached its temporary submission limit. Please try later.' using errcode='22023'; end if;
   insert into client_jobs(id,owner_id,link_hash,profile_id,profile_name,machine) values(p_job,portal.owner_id,p_link,portal.id,portal.name,portal.settings->>'machine') returning * into job;
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
  if jsonb_array_length(job.assets)>=10 or (select coalesce(sum((a->>'bytes')::bigint),0) from jsonb_array_elements(job.assets) a)+(p_data->>'bytes')::bigint>33554432 then raise exception 'Limit: 10 PNGs and 32 MiB per submission.' using errcode='22023'; end if;
  update client_jobs set assets=assets||jsonb_build_array(p_data),manifest=null,revision=revision+1 where id=p_job;
 elsif p_action='ready' then
  update client_jobs set assets=(select jsonb_agg(case when a->>'id'=p_data->>'id' and coalesce((a->>'deleted')::boolean,false)=false then a||p_data||'{"ready":true}'::jsonb else a end) from jsonb_array_elements(assets) a),revision=revision+1 where id=p_job;
 elsif p_action='remove' then
  update client_jobs set assets=(select jsonb_agg(case when a->>'id'=p_data->>'id' then a||'{"ready":false,"deleted":true}'::jsonb else a end) from jsonb_array_elements(assets) a),manifest=null,revision=revision+1 where id=p_job;
 elsif p_action='preview' then
  if (p_data->>'profileVersion')::timestamptz is distinct from portal.updated_at then raise exception 'The shop updated this upload profile. Generate the preview again.' using errcode='40001'; end if;
  if length(btrim(coalesce(p_data->>'reference',''))) not between 1 and 120 then raise exception 'Enter a Project / Client Name before generating the preview.' using errcode='22023'; end if;
  if job.revision<>(p_data->>'revision')::integer then raise exception 'Submission changed. Generate the preview again.' using errcode='40001'; end if;
  update client_jobs set assets=p_data->'assets',manifest=p_data->'manifest',reference=p_data->>'reference',profile_id=portal.id,profile_name=portal.name,machine=portal.settings->>'machine',design_count=(select count(*) from jsonb_array_elements(p_data->'assets') a where (a->>'ready')::boolean),quantity=(p_data->>'quantity')::integer,meters=(p_data->>'meters')::numeric,revision=revision+1 where id=p_job;
 elsif p_action='confirm' then
  if length(btrim(job.reference)) not between 1 and 120 then raise exception 'Enter a Project / Client Name and generate the preview before confirming.' using errcode='22023'; end if;
  if job.manifest is null or job.revision<>(p_data->>'revision')::integer then raise exception 'Generate and review the current preview before confirming.' using errcode='40001'; end if;
  update client_jobs set confirmed_at=stamp,expires_at=stamp+interval '24 hours',notification=p_data->'notification'||jsonb_build_object('expiresAt',stamp+interval '24 hours') where id=p_job;
 else raise exception 'Unsupported client action' using errcode='22023'; end if;
 if p_action in('ready','remove') then update client_jobs set design_count=(select count(*) from jsonb_array_elements(assets) a where (a->>'ready')::boolean),quantity=(select coalesce(sum((a->>'qty')::integer),0) from jsonb_array_elements(assets) a where (a->>'ready')::boolean) where id=p_job; end if;
 select * into job from client_jobs where id=p_job; return to_jsonb(job);
end $$;
revoke all on function public.ssb_client_jobs(text,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ssb_client_jobs(text,uuid,text,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
