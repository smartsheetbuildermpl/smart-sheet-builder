// Real route handlers + real PostgreSQL functions. Only the Supabase HTTP boundary is replaced.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite'),{NextRequest}=require('next/server');
const cache=new Map();
function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const src=fs.readFileSync(file,'utf8'),names=[...src.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m=>m[1]);const code=src.replace(/import \{([\s\S]*?)\} from '([^']+)';/g,(_,n,s)=>`const {${n}}=imports(${JSON.stringify(s)});`).replace(/export /g,'');const result=new Function('imports',`${code}\nreturn {${names.join(',')}};`)(s=>s==='next/server'||s.startsWith('node:')?require(s):load(path.resolve(path.dirname(file),s+'.js')));cache.set(file,result);return result;}
async function fixture(){
 const db=new PGlite(),q=(sql,args=[])=>db.query(sql,args),one=async(sql,args)=>(await q(sql,args)).rows[0];
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,created_at timestamptz default now(),last_sign_in_at timestamptz,raw_user_meta_data jsonb);create schema storage;create table storage.buckets(id text primary key,public boolean);create table storage.objects(id uuid,bucket_id text);alter table storage.objects enable row level security;create table design_library_categories(id uuid);create table design_library_designs(id uuid);`);
 for(const name of ['supabase-smart-sheet-v53b.sql','supabase-access-entitlements-v1.sql'])await db.exec(fs.readFileSync(name,'utf8').replace('create extension if not exists pgcrypto;',''));
 const users={};for(const [i,name] of ['owner','basic','unlimited'].entries()){users[name]={id:`00000000-0000-4000-8000-00000000000${i+1}`,email:name==='owner'?'masterprintlabcorp@gmail.com':`${name}@test.example`,email_confirmed_at:new Date().toISOString()};await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[users[name].id,users[name].email]);await q('insert into profiles(id,email,exports_unlimited) values($1,$2,$3)',[users[name].id,users[name].email,name==='unlimited']);}
 for(const name of ['supabase-user-management-v1.sql','supabase-export-credits-v1.sql','supabase-export-enforcement-v1.sql','supabase-export-enforcement-v1.sql'])await db.exec(fs.readFileSync(name,'utf8'));
 const originalFetch=global.fetch;
 Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:'https://supabase.test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'test-anon',SUPABASE_SERVICE_ROLE_KEY:'test-service',SMART_SHEET_TRUSTED_IP_HEADER:'x-test-ingress-ip'});
 const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 let networkDown=false;
 global.fetch=async(url,options={})=>{const u=new URL(url),body=options.body?JSON.parse(options.body):null;
  if(networkDown)return response({message:'Temporary failure'},503);
  if(u.pathname==='/auth/v1/user'){const token=options.headers.Authorization?.slice(7);return users[token]?response(users[token]):response({message:'Invalid token'},401);}
  if(u.pathname==='/rest/v1/profiles')return response((await q('select * from profiles where id=$1',[u.searchParams.get('id').slice(3)])).rows);
  if(u.pathname==='/rest/v1/guest_usage')return response((await q('select * from guest_usage where guest_id=$1',[u.searchParams.get('guest_id').slice(3)])).rows);
  if(u.pathname.startsWith('/rest/v1/rpc/')){const name=u.pathname.split('/').at(-1),keys=Object.keys(body);assert(/^[a-z_]+$/.test(name));assert(keys.every(k=>/^p_[a-z_]+$/.test(k)));try{return response((await one(`select ${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')}) d`,Object.values(body))).d);}catch(e){return response({message:e.message},400);}}
  throw Error('Unexpected boundary '+u.pathname);
 };
 const status=load('app/api/export/status/route.js'),consume=load('app/api/export/consume/route.js'),me=load('app/api/auth/me/route.js');
 const req=(token,cookie,body,ip='203.0.113.9')=>new NextRequest('http://localhost/api/export/test',{method:body?'POST':'GET',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(cookie?{cookie}:{}),'x-test-ingress-ip':ip},...(body?{body:JSON.stringify(body)}:{})});
 const call=async(token,cookie,body)=>(await consume.POST(req(token,cookie,body))).json();
 const prepare=async(token,cookie,kind='png',key=randomUUID())=>{const op={exportKind:kind,requestKey:key,fingerprint:'native-source-complete-image',action:'prepare'};return {op,...await call(token,cookie,op)};};
 return {db,q,one,users,status,consume,me,req,call,prepare,setNetwork:v=>networkDown=v,close:async()=>{global.fetch=originalFetch;await db.close();}};
}
async function run(){const f=await fixture(),{q,one,users,status,me,req,call,prepare}=f;try{
 const previousEnv=process.env.NODE_ENV;process.env.NODE_ENV='production';const initial=await status.GET(req());process.env.NODE_ENV=previousEnv;
 const cookie=initial.headers.get('set-cookie').split(';')[0];assert.match(initial.headers.get('set-cookie'),/Secure/i);assert.match(initial.headers.get('set-cookie'),/HttpOnly/i);assert.match(initial.headers.get('set-cookie'),/SameSite=lax/i);assert.equal((await initial.json()).usage.remaining,2);
 for(const [i,kind] of ['png','tiff'].entries()){
  const p=await prepare(null,cookie,kind);assert(p.allowed);const body={...p.op,action:'consume',authorization:p.authorization};
  const results=await Promise.all(Array.from({length:6},()=>call(null,cookie,body)));assert(results.every(r=>r.allowed));assert.equal(new Set(results.map(r=>r.receipt)).size,1);assert.equal(results[0].usage.remaining,1-i);
  await call(null,cookie,{...body,action:'saved',receipt:results[0].receipt});assert.equal((await call(null,cookie,body)).allowed,false,'completed receipt cannot replay');
  for(let reload=0;reload<3;reload++){const s=await status.GET(req(null,cookie));assert.equal((await s.json()).usage.remaining,1-i);assert.equal(s.headers.get('set-cookie'),null,'same persisted identity after navigation/idle/reload');}
 }
 for(const kind of ['png','tiff'])assert.equal((await prepare(null,cookie,kind)).allowed,false);
 assert.equal((await one('select count(*)::int n from usage_exports where guest_id is not null')).n,2);
 await q("insert into usage_exports(guest_id,export_kind) values('legacy-with-missing-row','tiff')");
 const legacyResponse=await status.GET(new NextRequest('http://localhost/api/export/status?legacyGuestId=legacy-with-missing-row'));
 assert.equal((await legacyResponse.json()).usage.remaining,1,'legacy history carries spent quota forward, even if old PATCH never created usage row');
 assert.equal((await call(null,null,{exportKind:'png',requestKey:randomUUID(),fingerprint:'fake-identity',guestId:randomUUID()})).allowed,false,'client ID is not a guest identity');
 const forged=await status.GET(req(null,cookie+'tampered'));assert.notEqual(forged.headers.get('set-cookie')?.split(';')[0],cookie,'tamper requires new server identity');
 const otherCookie=forged.headers.get('set-cookie').split(';')[0];
 const p=await prepare(null,otherCookie);const ready={...p.op,action:'consume',authorization:p.authorization};
 assert.equal((await call(null,cookie,ready)).allowed,false,'authorization bound to guest cookie');
 const r=await call(null,otherCookie,ready);assert(r.allowed);await call(null,otherCookie,{...ready,action:'refund',receipt:r.receipt});await call(null,otherCookie,{...ready,action:'refund',receipt:r.receipt});assert.equal((await (await status.GET(req(null,otherCookie))).json()).usage.remaining,2);
 await q('update free_export_credits set balance=1,refill_from=clock_timestamp() where user_id=$1',[users.basic.id]);
 const b=await prepare('basic');assert(b.allowed);const consumeBody={...b.op,action:'consume',authorization:b.authorization};
 assert.equal((await call('basic',null,{...consumeBody,authorization:'forged'})).allowed,false);
 assert.equal((await call('unlimited',null,consumeBody)).allowed,false,'token bound to signed-in actor');
 const charged=await call('basic',null,consumeBody);assert(charged.allowed);assert.equal(charged.usage.remaining,0);await call('basic',null,{...consumeBody,action:'saved',receipt:charged.receipt});assert.equal((await call('basic',null,consumeBody)).allowed,false);
 for(const kind of ['png','tiff'])assert.equal((await prepare('basic',null,kind)).allowed,false);
 for(const token of ['owner','unlimited'])for(const kind of ['png','tiff']){const a=await prepare(token,null,kind);const done=await call(token,null,{...a.op,action:'consume',authorization:a.authorization});assert(done.allowed);assert(done.usage.unlimited);assert.equal((await one('select count(*)::int n from credit_ledger where user_id=$1',[users[token].id])).n,0);}
 // Repeated fresh-cookie creation is softly throttled, not existing offices' trials.
 for(let n=0;n<35;n++)await status.GET(req());assert.equal((await status.GET(req())).status,429);assert.equal((await status.GET(req(null,cookie))).status,200);
 await q("update guest_trial_networks set window_start=clock_timestamp()-interval '61 minutes'");assert.equal((await status.GET(req())).status,200);
 assert((await q('select network_hash from guest_trial_networks')).rows.every(r=>!r.network_hash.includes('203.0.113')));
 f.setNetwork(true);assert.equal((await me.GET(req('basic'))).status,503,'outage is not invalid_session');f.setNetwork(false);assert.equal((await me.GET(req('invalid'))).status,401);
 await f.db.exec('set role authenticated');await assert.rejects(()=>q('select * from guest_usage'));await assert.rejects(()=>q("select ssb_create_guest('forged',null)"));await f.db.exec('reset role');
 console.log('PASS: real SQL/API guest 2→1→0, cookie reload persistence, no phantom PATCH, atomic retries, saved replay denied, registered 1→0 PNG/TIFF block, refunds, owner/Unlimited, signed tokens, HMAC network throttle, RLS, outage versus invalid session.');
}finally{await f.close();}}
module.exports={fixture,load};if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
