-- Read-only deployment audit. Run in the Supabase SQL Editor for the app project.
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in
 ('client_portals','client_jobs','client_job_rates','client_job_exports');

select tablename,indexname,indexdef from pg_indexes
where schemaname='public' and tablename in
 ('client_portals','client_jobs','client_job_rates','client_job_exports');

select p.proname, p.prosecdef as security_definer,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
 has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute,
 case when p.proname='ssb_client_jobs' then
  position('P0403' in pg_get_functiondef(p.oid))>0 end as has_disabled_link_fix
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('ssb_client_jobs','ssb_client_job_export');

select policyname,permissive,roles,cmd,qual,with_check from pg_policies
where (schemaname='public' and tablename in
 ('client_portals','client_jobs','client_job_rates','client_job_exports'))
or (schemaname='storage' and tablename='objects' and policyname='client_job_sources_private');

select id,public,file_size_limit,allowed_mime_types from storage.buckets
where id='client-job-sources';
select count(*) as portals, count(*) filter(where enabled) as enabled_portals from public.client_portals;
