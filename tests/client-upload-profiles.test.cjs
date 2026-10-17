const assert = require('node:assert/strict'), fs = require('node:fs'), {randomUUID} = require('node:crypto');
const { fixture, png } = require('./client-jobs.test.cjs');
(async () => {
 const f=await fixture();
 try {
  const get = async user => { const r=await f.owner.GET(f.req('/api/client-jobs',undefined,user||'basic'));assert.equal(r.status,200);return r.json(); };
  const act = async (action,profile,extra={},user='basic') => { const r=await f.owner.POST(f.req('/api/client-jobs',{action,profileId:profile?.id,...extra},user));return {status:r.status,...await r.json()}; };
  const initial=await get();assert.equal(initial.profiles.length,4);assert.equal(new Set(initial.profiles.map(p=>p.url)).size,4);
  assert.deepEqual(initial.profiles.map(p=>p.settings.machine),['dtf','uvdtf24','uvdtf12','tarpaulin']);
  const confirmed=[];
  for (const profile of initial.profiles) {
   assert.equal(profile.settings.gapIn,0.3);assert.equal(profile.settings.edgeIn,0.5);assert.equal(profile.enabled,false);
   const enabled=await act('enable',profile);assert.equal(enabled.status,200,enabled.message);
   const token=profile.url.split('/').at(-1);
   const info=await f.pub.GET(f.req('/api/client-upload/'+token),{params:{token}});const publicInfo=await info.json();
   assert.deepEqual(Object.keys(publicInfo).sort(),['machine','profileName','shopName']);assert.equal(publicInfo.machine,profile.settings.machine);assert.equal(publicInfo.profileName,profile.name);
   const created=await f.call('create',token);const bytes=png(600,300);const uploaded=await f.call('upload',token,created.submission,bytes);
   const quantities=uploaded.job.assets.map(a=>({id:a.id,qty:2,widthIn:1.5,heightIn:0.75}));
   for (const reference of [undefined,'','   ','bad\nname']) assert.equal((await f.call('preview',token,created.submission,{reference,quantities})).status,400);
   assert.equal((await f.call('confirm',token,created.submission,{})).status,400,'blank names rejected on confirmation');
   const preview=await f.call('preview',token,created.submission,{reference:'Mikael – Company Uniform',quantities,
     profileId:initial.profiles.find(p=>p.id!==profile.id).id,settings:{machine:'tarpaulin',widthIn:1,gapIn:0,edgeIn:0}});
   assert.equal(preview.status,200,preview.message);assert.equal(preview.job.machine,profile.settings.machine);
   assert.equal(preview.job.manifest.profile,undefined);assert.equal(preview.job.manifest.config,undefined);
   const stored=await f.one('select * from client_jobs where id=$1',[created.job.id]);
   assert.deepEqual(stored.manifest.config,profile.settings);assert.equal(stored.profile_id,profile.id);assert.equal(stored.profile_name,profile.name);
   assert.equal(stored.manifest.profile.reference,'Mikael – Company Uniform');assert(stored.manifest.sheets.flatMap(s=>s.placements).every(p=>p.baseW===Math.round(1.5*profile.settings.dpi)&&p.baseH===Math.round(0.75*profile.settings.dpi)));
   const profileVersion=(await f.lib.jobs('info',{p_link:f.lib.hash(token)})).updated_at;
   const edited=await act('save',profile,{name:profile.name+' revised',settings:{...profile.settings,gapIn:0.1,edgeIn:0.1,email:'changed@test.example'}});assert.equal(edited.status,200);
   await assert.rejects(()=>f.lib.jobs('preview',{p_link:f.lib.hash(token),p_job:created.job.id,p_data:{revision:stored.revision,profileVersion,reference:stored.reference,assets:stored.assets,manifest:stored.manifest,quantity:stored.quantity,meters:stored.meters}}),e=>e.data?.code==='40001','concurrent settings edit cannot save a mixed recipe');
   const final=await f.call('confirm',token,created.submission,{revision:preview.job.revision});assert.equal(final.status,200,final.message);
   const after=await f.one('select * from client_jobs where id=$1',[created.job.id]);assert.deepEqual(after.manifest,stored.manifest);assert.equal(after.profile_name,profile.name);
   assert.equal(new Date(after.expires_at)-new Date(after.confirmed_at),86400000);
   const email=f.emails.at(-1);assert.match(email.subject,/Mikael – Company Uniform/);assert(email.subject.includes(profile.name));assert(email.text.includes(profile.name));assert.equal(email.to[0],profile.settings.email,'notification uses reviewed snapshot');
   assert.equal((await f.call('confirm',token,created.submission,{revision:preview.job.revision})).status,200);assert.equal(f.emails.length,confirmed.length+1,'confirm retries do not send twice');
   const duplicate=await act('duplicate',profile);assert.equal(duplicate.status,200);const clone=duplicate.profiles.find(p=>p.id===duplicate.selectedProfileId);assert(!clone.enabled);assert.notEqual(clone.url,profile.url);
   assert.equal((await act('disable',profile,{},'unlimited')).status,403);
   assert.equal((await act('disable',profile)).status,200);
   assert.equal((await f.call('create',token)).status,403);
   const owner=await f.owner.GET(f.req('/api/client-jobs?id='+after.id,undefined,'basic'));assert.equal(owner.status,200,'disabled profile keeps owner confirmed history');
   confirmed.push(after);
  }
  const beforeRotate=await get();const chosen=beforeRotate.profiles[0];const rotated=await act('rotate',chosen);assert.equal(rotated.status,200);
  const afterRotate=await get();for(const p of beforeRotate.profiles.filter(p=>p.id!==chosen.id))assert.equal(afterRotate.profiles.find(a=>a.id===p.id).url,p.url,'rotation affects one profile only');
  assert.equal((await f.call('create',chosen.url.split('/').at(-1))).status,404);
  const custom=await act('create',null,{name:'Custom proof',settings:{...initial.profiles[0].settings,widthIn:4,lengthIn:5}});assert.equal(custom.status,200);assert(!custom.profiles.find(p=>p.id===custom.selectedProfileId).enabled);
  // Import a genuine pre-profile token/history, including an unnamed confirmed job.
  const legacy=f.lib.newLink(),id=randomUUID(),manifest={version:1,dpi:300,config:initial.profiles[0].settings,sheets:[]};
  await f.db.query('insert into client_portals(owner_id,link_hash,link_secret,enabled,settings) values($1,$2,$3,true,$4)',[f.users.basic.id,legacy.hash,legacy.secret,initial.profiles[0].settings]);
  await f.db.query("insert into client_jobs(id,owner_id,link_hash,confirmed_at,expires_at,manifest) values($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '24 hours',$4)",[id,f.users.basic.id,legacy.hash,manifest]);
  const migration=fs.readFileSync('supabase-client-upload-profiles-v1.sql','utf8');await f.db.exec(migration);await f.db.exec(migration);
  const history=await get();assert(history.profiles.some(p=>p.template==='legacy'&&p.url.endsWith(legacy.token)));assert(history.jobs.some(j=>j.id===id));
  const oldJob=await f.owner.GET(f.req('/api/client-jobs?id='+id,undefined,'basic'));assert.equal(oldJob.status,200);assert.deepEqual((await oldJob.json()).job.manifest,manifest);
  assert.equal((await f.pub.GET(f.req('/api/client-upload/'+legacy.token),{params:{token:legacy.token}})).status,200);
  assert([...f.objects.values()].some(b=>b.equals(png(600,300))));
  await f.db.exec('set role authenticated');await assert.rejects(()=>f.db.query('select * from client_upload_profiles'),/permission denied/);await f.db.exec('reset role');
  const expiring=confirmed[0];await f.db.query("update client_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[expiring.id]);
  assert.equal((await f.owner.GET(f.req('/api/client-jobs?id='+expiring.id,undefined,'basic'))).status,410);
  console.log('PASS: four isolated machine profiles, required identifier, immutable full-resolution recipes, settings/email snapshots, per-profile rotation/disable/duplicate/create, owner isolation/RLS, legacy migration twice, idempotent confirmation and exact expiry.');
 } finally { await f.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
