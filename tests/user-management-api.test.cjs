const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cache = new Map();
function load(file) {
  file=path.resolve(file); if(cache.has(file)) return cache.get(file);
  const source=fs.readFileSync(file,'utf8'), names=[...source.matchAll(/export (?:async )?(?:function|const) (\w+)/g)].map(m=>m[1]);
  const code=source.replace(/import \{([\s\S]*?)\} from '([^']+)';/g,(_,n,s)=>`const {${n}}=imports(${JSON.stringify(s)});`).replace(/export /g,'');
  const result=new Function('imports',`${code}\nreturn {${names.join(',')}};`)(s=>s==='next/server'?require('next/server'):load(path.resolve(path.dirname(file),s+'.js')));
  cache.set(file,result);return result;
}
const ids=['owner','basic','unlimited','legacy','unverified'].map((key,i)=>[key,`00000000-0000-4000-8000-00000000000${i+1}`]);
const users=Object.fromEntries(ids.map(([key,id])=>[key,{id,email:`${key}@test.example`,email_confirmed_at:key==='unverified'?null:'2026-09-01T00:00:00Z'}]));
const profiles=Object.fromEntries(ids.map(([key,id])=>[id,{id,email:users[key].email,role:key==='legacy'?'admin':'user',plan:'free',status:'active',is_super_admin:key==='owner',exports_unlimited:key==='unlimited',exports_used:0,full_name:`${key} name`,updated_at:'2026-09-01T00:00:00Z'}]));
Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:'https://test.example',NEXT_PUBLIC_SUPABASE_ANON_KEY:'fake-anon',SUPABASE_SERVICE_ROLE_KEY:'fake-service',SMART_SHEET_ADMIN_EMAILS:users.basic.email});
const calls=[]; let confirmedSignup=false, duplicate=false;
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
global.fetch=async(url,options={})=>{
  const u=new URL(url),body=options.body?JSON.parse(options.body):null; calls.push({path:u.pathname,method:options.method,body});
  if(u.pathname==='/auth/v1/user') return users[options.headers.Authorization?.slice(7)]?response(users[options.headers.Authorization.slice(7)]):response({message:'Invalid session'},401);
  if(u.pathname==='/auth/v1/signup') return response(confirmedSignup?{access_token:'basic',user:users.basic}:{user:duplicate?users.owner:users.basic});
  if(u.pathname==='/rest/v1/profiles') {
    const id=u.searchParams.get('id')?.slice(3); if(options.method==='PATCH') Object.assign(profiles[id],body);
    return response(profiles[id]?[profiles[id]]:[]);
  }
  if(u.pathname==='/rest/v1/rpc/ssb_import_guest_usage') return response(profiles[body.p_user]);
  if(u.pathname==='/rest/v1/rpc/ssb_require_owner') return body.p_actor===users.owner.id?response(null):response({code:'42501',message:'Super Admin required'},403);
  if(u.pathname==='/rest/v1/rpc/ssb_admin_users') return response({users:[profiles[users.basic.id]],total:1});
  if(u.pathname==='/rest/v1/rpc/ssb_admin_user') return response({user:profiles[body.p_target],history:[]});
  if(u.pathname==='/rest/v1/rpc/ssb_admin_change') return response(null);
  throw Error(`Unexpected network boundary: ${u.pathname}`);
};
const req=(url,method,token,body)=>new Request(`http://localhost${url}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
(async()=>{
  const list=load('app/api/admin/users/route.js'),details=load('app/api/admin/users/[id]/route.js'),own=load('app/api/auth/profile/route.js'),signup=load('app/api/auth/register/route.js');
  const target={params:{id:users.basic.id}};
  for(const token of [null,'invalid','unverified','basic','unlimited','legacy']) {
    for(const operation of [()=>list.GET(req('/api/admin/users','GET',token)),()=>details.GET(req('/api/admin/users/id','GET',token),target),()=>details.PATCH(req('/api/admin/users/id','PATCH',token,{field:'export_access',value:'unlimited',expectedUpdatedAt:profiles[users.basic.id].updated_at}),target)]) {
      const start=calls.length,r=await operation();assert.equal(r.status,[null,'invalid','unverified'].includes(token)?401:403,`${token} admin denied`);
      assert(!calls.slice(start).some(c=>c.path.includes('/rpc/ssb_admin_')),'deny before data RPC');
    }
  }
  assert.equal((await list.GET(req('/api/admin/users?search=abc&offset=-1','GET','owner'))).status,200);
  assert.equal(calls.at(-1).body.p_offset,0);
  assert.equal((await details.GET(req('/api/admin/users/id','GET','owner'),target)).status,200);
  assert.equal((await details.GET(req('/api/admin/users/id','GET','owner'),{params:{id:'bad-id'}})).status,400);
  assert.equal((await details.PATCH(req('/api/admin/users/id','PATCH','owner',{field:'role',value:'admin',expectedUpdatedAt:profiles[users.basic.id].updated_at}),target)).status,400);
  assert.equal((await details.PATCH(req('/api/admin/users/id','PATCH','owner',{field:'export_access',value:'unlimited',actorId:users.basic.id,expectedUpdatedAt:profiles[users.basic.id].updated_at}),target)).status,400);
  assert.equal((await details.PATCH(req('/api/admin/users/id','PATCH','owner',{field:'export_access',value:'unlimited',expectedUpdatedAt:profiles[users.basic.id].updated_at}),target)).status,200);
  assert.equal(calls.at(-1).body.p_actor,users.owner.id);
  const self=await (await own.GET(req('/api/auth/profile','GET','basic'))).json();
  assert.equal(self.profile.full_name,'basic name'); assert.equal(self.profile.is_super_admin,undefined);
  for(const body of [{role:'admin'},{exports_unlimited:true},{id:users.owner.id},{status:'active'},{is_super_admin:true},{export_access_override:'unlimited'}]) assert.equal((await own.PATCH(req('/api/auth/profile','PATCH','basic',body))).status,400);
  assert.equal((await own.PATCH(req('/api/auth/profile','PATCH','basic',{full_name:'Edited name',city:'Manila'}))).status,200);
  assert.equal(profiles[users.basic.id].full_name,'Edited name');assert.equal(profiles[users.owner.id].full_name,'owner name');
  profiles[users.basic.id].status='blocked';assert.equal((await own.GET(req('/api/auth/profile','GET','basic'))).status,403);profiles[users.basic.id].status='active';
  const registration={email:'new@test.example',password:'test-only-password',profile:{full_name:'New User',business_name:'Shop',machine_type:'DTF',terms_accepted:true}};
  assert.equal((await signup.POST(req('/api/auth/register','POST',null,{...registration,profile:{full_name:''}}))).status,400);
  assert.equal((await signup.POST(req('/api/auth/register','POST',null,{...registration,profile:{...registration.profile,is_super_admin:true}}))).status,400);
  for(duplicate of [false,true]) {
    const start=calls.length,r=await signup.POST(req('/api/auth/register','POST',null,registration)),data=await r.json();
    assert.equal(r.status,202);assert(!data.session);assert(!data.usage);
    assert.equal(calls.length-start,1,'unverified / duplicate signup must not write or expose profile');
    assert.deepEqual(calls.at(-1).body.data,registration.profile);
  }
  confirmedSignup=true;
  const r=await signup.POST(req('/api/auth/register','POST',null,registration)),data=await r.json();
  assert.equal(r.status,200);assert(data.session);assert.equal(data.usage.isSuperAdmin,false);assert.equal(data.usage.unlimited,false);
  assert(!JSON.stringify(data).includes('fake-service'));
  console.log('PASS: actual API handlers, anonymous/unverified/basic/unlimited/legacy denial, owner authorization, own-field whitelist, actor spoofing, signup defaults, confirmation and duplicate privacy.');
})().catch(e=>{console.error(e);process.exitCode=1;});
