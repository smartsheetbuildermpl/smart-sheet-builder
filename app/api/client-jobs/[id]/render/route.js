import { accountActor, failure } from '../../../_lib/user-management';
import { jobs, uuid, storage, errorReply, rate } from '../../../_lib/client-jobs';
import { validAuthorization } from '../../../_lib/export-security';
import { rollRenderEvents } from '../../../_lib/roll-strip-renderer';
import { outputProblem } from '../../../../lib/client-portal-limits';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// One scratch workspace per warm instance; never multiply native source disk
// allocations through parallel clicks/requests. Separate instances are isolated.
let rendering = false;
export async function POST(request, { params }) {
  try {
    const {user}=await accountActor(request), body=await request.json();
    if(!['png','tiff'].includes(body.exportKind) || body.jobId!==uuid(params.id) || !validAuthorization(body.authorization,`user:${user.id}`,body))
      throw failure('Export authorization expired. Retry from the submission.',403);
    const job=await jobs('get',{p_owner:user.id,p_job:body.jobId});
    if(!job.confirmed_at || job.manifest?.mediaMode!=='continuous' || job.manifest.sheets.length!==1)
      throw failure('Choose a confirmed continuous roll job.',409);
    const issue=outputProblem(job.manifest,0,job.assets);
    if(issue)throw failure(issue,400);
    await rate(request,`roll-render:${user.id}`,20);
    if(rendering) throw failure('Another full-resolution roll is processing on this server. Please retry in a moment.',409);
    rendering=true;
    const expires=Date.parse(job.expires_at), deadline=Date.now()+55000;
    const check=()=>{
      if(request.signal.aborted) throw Error('Print file preparation cancelled.');
      if(Date.now()>=expires) throw Error('Expired — files are no longer available.');
      if(Date.now()>=deadline) throw Error('This server has a 55-second rendering limit. No partial file was saved. Retry once or contact the shop for a larger renderer.');
    };
    async function* events() {
      try {
        check();
        for await(const event of rollRenderEvents(job,body.exportKind,asset=>storage('GET',asset.path),check)) { check(); yield event; }
        // The completion marker authorizes accepting bytes as a complete file.
        // The usual consume/saved RPC still checks expiry/credits at delivery.
        await jobs('get',{p_owner:user.id,p_job:job.id}); check();
        yield {type:'complete'};
      } catch(e) {
        console.error('[client-roll-render]',job.id,e.message);
        yield {type:'error',message:e.code ? 'Private print-file processing could not complete. This server supports 448 MiB of temporary scratch disk per render. Retry or contact the shop; no partial file was saved.' : e.message};
      } finally { rendering=false; }
    }
    const iterator=events(), encoder=new TextEncoder();
    return new Response(new ReadableStream({
      async pull(controller) {
        try { const next=await iterator.next(); if(next.done)controller.close();else controller.enqueue(encoder.encode(JSON.stringify(next.value)+'\n')); }
        catch(e){rendering=false;controller.error(e);}
      },
      async cancel(){ await iterator.return(); rendering=false; }
    }),{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Accel-Buffering':'no'}});
  } catch(e) { return errorReply(e); }
}
