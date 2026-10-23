-- Run after supabase-client-jobs-v1.sql, supabase-client-upload-profiles-v1.sql
-- and supabase-client-upload-limits-v1.sql. Raises only private Client Portal
-- upload limits; it does not modify existing jobs, profiles, expiry or RLS.
begin;

do $$ begin
 if not exists(select 1 from storage.buckets where id='client-job-sources' and public=false) then
  raise exception 'Apply the Client Jobs migration with its private client-job-sources bucket before this migration.';
 end if;
 if not exists(select 1 from pg_class where relname='client_upload_profiles' and relnamespace='public'::regnamespace) then
  raise exception 'Apply supabase-client-upload-profiles-v1.sql before this migration.';
 end if;
end $$;

-- Direct signed uploads are validated by the service-only RPC below. This is
-- a second, private-storage guard; larger existing limits are never reduced.
update storage.buckets
 set file_size_limit=greatest(coalesce(file_size_limit,0),52428800)
 where id='client-job-sources' and public=false;

create or replace function public.ssb_client_upload_reserve(p_link text,p_job uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.client_jobs; portal public.client_upload_profiles; a jsonb;
 file_mib integer:=50; total_mib integer:=150; file_limit bigint; total_limit bigint;
 used_bytes bigint:=0; active_files integer:=0; incoming bigint;
begin
 select * into portal from public.client_upload_profiles where link_hash=p_link for update;
 if not found then raise exception 'This upload link is invalid or has been replaced. Ask the shop for the current link.' using errcode='P0404'; end if;
 if not portal.enabled then raise exception 'This upload portal is currently disabled.' using errcode='P0403'; end if;
 if not exists(select 1 from public.profiles p join auth.users u on u.id=p.id where p.id=portal.owner_id and p.status='active' and u.email_confirmed_at is not null) then
  raise exception 'This shop is not currently accepting uploads.' using errcode='P0423';
 end if;
 if coalesce(portal.settings->>'maxFileMiB','') ~ '^[0-9]+$' then file_mib:=least(100,greatest(1,(portal.settings->>'maxFileMiB')::integer)); end if;
 if coalesce(portal.settings->>'maxTotalMiB','') ~ '^[0-9]+$' then total_mib:=least(300,greatest(file_mib,(portal.settings->>'maxTotalMiB')::integer)); end if;
 file_limit:=file_mib::bigint*1048576; total_limit:=total_mib::bigint*1048576;
 incoming:=coalesce((p_data->>'bytes')::bigint,0);
 if incoming<33 or incoming>file_limit then raise exception 'Upload exceeds this profile''s % MiB per-file limit.',file_mib using errcode='22023'; end if;
 select * into j from public.client_jobs where id=p_job and owner_id=portal.owner_id and link_hash=p_link for update;
 if not found then raise exception 'Client job not found' using errcode='P0002'; end if;
 if j.expires_at<=clock_timestamp() or j.purged_at is not null then raise exception 'This submission session has expired. Start a new submission.' using errcode='P0410'; end if;
 if j.confirmed_at is not null then raise exception 'This submission is locked.' using errcode='22023'; end if;
 select value into a from jsonb_array_elements(j.assets) where value->>'id'=p_data->>'id';
 if a is not null then
  if coalesce((a->>'deleted')::boolean,false) or a->>'bytes' is distinct from p_data->>'bytes' or a->>'name' is distinct from p_data->>'name' then
   raise exception 'Upload reservation does not match this file.' using errcode='22023';
  end if;
  return to_jsonb(j);
 end if;
 select count(*),coalesce(sum((value->>'bytes')::bigint),0) into active_files,used_bytes
  from jsonb_array_elements(j.assets) where coalesce((value->>'deleted')::boolean,false)=false;
 if active_files>=10 then raise exception 'A submission can contain up to 10 PNG files.' using errcode='22023'; end if;
 if used_bytes+incoming>total_limit then raise exception 'Upload exceeds the remaining % MiB submission allowance.',round((total_limit-used_bytes)::numeric/1048576,2) using errcode='22023'; end if;
 update public.client_jobs set assets=assets||jsonb_build_array(p_data),manifest=null,revision=revision+1 where id=p_job returning * into j;
 return to_jsonb(j);
end $$;

revoke all on function public.ssb_client_upload_reserve(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ssb_client_upload_reserve(text,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
