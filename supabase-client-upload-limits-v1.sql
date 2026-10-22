-- Portal upload reliability only. No profile, history, expiry, or RLS changes.
begin;
update storage.buckets set file_size_limit=33554432
 where id='client-job-sources' and public=false;

-- Reuse a reservation on retry (including a lost HTTP response). The existing
-- job RPC locks the row and enforces the opaque link, draft state and expiry.
create or replace function public.ssb_client_upload_reserve(p_link text,p_job uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j jsonb; a jsonb;
begin
 j:=public.ssb_client_jobs('get',null,p_link,p_job);
 if j->>'confirmed_at' is not null then raise exception 'This submission is locked.' using errcode='22023'; end if;
 select value into a from jsonb_array_elements(j->'assets') where value->>'id'=p_data->>'id';
 if a is not null then
  if coalesce((a->>'deleted')::boolean,false) or a->>'bytes' is distinct from p_data->>'bytes' or a->>'name' is distinct from p_data->>'name' then
   raise exception 'Upload reservation does not match this file.' using errcode='22023';
  end if;
  return j;
 end if;
 return public.ssb_client_jobs('reserve',null,p_link,p_job,p_data);
end $$;
revoke all on function public.ssb_client_upload_reserve(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.ssb_client_upload_reserve(text,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
