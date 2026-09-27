const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,load}=require('./export-enforcement.test.cjs'),{NextRequest}=require('next/server');
const req=(path,body,cookie)=>new NextRequest('https://builder.test/api/auth/'+path,{method:'POST',headers:{origin:'https://builder.test',...(cookie?{cookie}:{})},body:JSON.stringify(body)});
const cookieOf=r=>r.headers.get('set-cookie')?.split(';')[0];
(async()=>{const f=await fixture();try{
 process.env.SMART_SHEET_SITE_URL='https://builder.test';
 for(const file of ['supabase-password-recovery-v1.sql','supabase-auth-callback-v1.sql','supabase-auth-callback-v1.sql'])await f.db.exec(fs.readFileSync(file,'utf8'));
 const originalProfile=await f.one('select role,exports_unlimited,status from profiles where id=$1',[f.users.basic.id]);
 const dbFetch=global.fetch,calls=[],validTokens=new Set(),used=new Set();let offline=false;
 const user={...f.users.basic,recovery_sent_at:new Date().toISOString()};
 const response=(data,status=200)=>new Response(JSON.stringify(data),{status});
 global.fetch=async(url,options={})=>{
  const u=new URL(url),body=options.body?JSON.parse(options.body):null;calls.push({path:u.pathname,query:u.searchParams,body});
  if(offline)throw new TypeError('fetch failed');
  if(u.pathname==='/auth/v1/signup'||u.pathname==='/auth/v1/resend')return response({user});
  if(u.pathname==='/auth/v1/verify'){
   if(!['s'.repeat(64),'r'.repeat(64)].includes(body.token_hash)||used.has(body.token_hash))return response({message:'expired'},403);
   used.add(body.token_hash);return response({access_token:'fresh',user});
  }
  if(u.pathname==='/auth/v1/token')return body.auth_code==='good-code'&&body.code_verifier?response({access_token:'fresh',user}):response({message:'bad code'},400);
  if(u.pathname==='/auth/v1/user')return validTokens.has(options.headers.Authorization?.slice(7))||options.headers.Authorization==='Bearer fresh'?response(user):response({message:'invalid signature'},401);
  if(u.pathname==='/auth/v1/logout')return response({});
  return dbFetch(url,options);
 };
 const register=load('app/api/auth/register/route.js'),confirm=load('app/api/auth/confirm/route.js'),resend=load('app/api/auth/confirmation/request/route.js'),verify=load('app/api/auth/password/verify/route.js');
 const signup=await register.POST(req('register',{email:user.email,password:'test-password',profile:{full_name:'Test User'}}));assert.equal(signup.status,202);const proof=cookieOf(signup);
 assert.equal(calls.at(-1).query.get('redirect_to'),'https://builder.test/auth/callback');assert(calls.at(-1).body.code_challenge);
 assert.equal((await confirm.POST(req('confirm',{code:'good-code'},proof))).status,200);
 assert.equal((await confirm.POST(req('confirm',{code:'good-code'}))).status,400);
 assert.equal((await confirm.POST(req('confirm',{token_hash:'s'.repeat(64)}))).status,200);
 assert.equal((await confirm.POST(req('confirm',{token_hash:'s'.repeat(64)}))).status,400);
 validTokens.add('confirmed-implicit');assert.equal((await confirm.POST(req('confirm',{access_token:'confirmed-implicit'}))).status,200);
 assert.equal((await confirm.POST(req('confirm',{access_token:'forged'}))).status,400);
 let publicMessage;
 for(const email of [user.email,'unknown@example.test']){const r=await resend.POST(req('confirmation/request',{email})),d=await r.json();publicMessage ||= d.message;assert.equal(d.message,publicMessage);assert.equal(calls.at(-1).query.get('redirect_to'),'https://builder.test/auth/callback');const before=calls.length;await resend.POST(req('confirmation/request',{email},cookieOf(r)));assert.equal(calls.length,before);}
 assert.equal((await verify.POST(req('password/verify',{token_hash:'r'.repeat(64)}))).status,200);
 const now=Math.floor(Date.now()/1000);
 function jwt(method,time=now){const token='header.'+Buffer.from(JSON.stringify({sub:user.id,session_id:'auth-session-'+method,exp:now+3600,amr:[{method,timestamp:time}]})).toString('base64url')+'.signature';validTokens.add(token);return token;}
 assert.equal((await verify.POST(req('password/verify',{access_token:jwt('password')}))).status,401,'normal password session cannot reset without current password');
 assert.equal((await verify.POST(req('password/verify',{access_token:jwt('otp',now-1000)}))).status,401,'stale OTP cannot become recovery');
 const token=jwt('otp'),r=await verify.POST(req('password/verify',{access_token:token}));assert.equal(r.status,200);assert.deepEqual(await r.json(),{ready:true});assert(cookieOf(r));
 assert.equal((await verify.POST(req('password/verify',{access_token:token}))).status,401,'implicit email session cannot mint repeated tickets');
 assert.equal((await f.one('select count(*)::int n from password_recovery_tickets where implicit_proof is not null')).n,1);
 await f.db.exec('set role authenticated');await assert.rejects(()=>f.q("select ssb_create_implicit_password_recovery($1,$2)",[user.id,'a'.repeat(64)]));await f.db.exec('reset role');
 offline=true;assert.equal((await confirm.POST(req('confirm',{access_token:'confirmed-implicit'}))).status,503);
 const snapshot=await f.one('select role,exports_unlimited,status from profiles where id=$1',[user.id]);assert.deepEqual(snapshot,originalProfile);
 console.log('PASS: actual confirmation/recovery APIs + SQL; PKCE, token hash, implicit verified session, invalid/used links, ordinary/stale/forged JWT rejected, one-use tickets, cooldown, privacy, RLS, no role/quota writes.');
}finally{await f.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
