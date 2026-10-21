const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { chromium } = require('playwright'), { NextRequest } = require('next/server');
const { fixture, load } = require('./export-enforcement.test.cjs');
const base = process.env.SMART_SHEET_TEST_URL || 'http://localhost:3114';
(async () => {
  const f = await fixture(), browser = await chromium.launch({channel:'chrome',headless:true});
  const output = fs.mkdtempSync(path.join(os.tmpdir(),'ssb-cross-device-'));
  try {
    process.env.SMART_SHEET_SITE_URL = base;
    for (const file of ['supabase-password-recovery-v1.sql','supabase-auth-callback-v1.sql']) await f.db.exec(fs.readFileSync(file,'utf8'));
    const before = await f.one('select * from profiles where id=$1',[f.users.basic.id]);
    const dbFetch = global.fetch, calls = [], initialCookies = [];
    let recoveryToken, recoveryUser, savedPassword, writes=0;
    const response = (body,status=200) => Response.json(body,{status});
    const session = (token,user) => ({access_token:token,refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user});
    global.fetch = async (url,options={}) => {
      const u = new URL(url), body = options.body ? JSON.parse(options.body) : null;
      const auth = new Headers(options.headers).get('authorization');
      calls.push({path:u.pathname,query:u.searchParams,body,auth});
      if (u.pathname === '/auth/v1/recover') {
        assert.deepEqual(Object.keys(body),['email'],'cross-device emails have no PKCE challenge');
        recoveryUser = {...f.users.basic,recovery_sent_at:new Date().toISOString()};
        const now=Math.floor(Date.now()/1000);
        recoveryToken = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:recoveryUser.id,session_id:'cross-device-recovery',exp:now+3600,amr:[{method:'otp',timestamp:now}]})).toString('base64url')+'.'+Buffer.alloc(32,2).toString('base64url');
        return response({});
      }
      if (u.pathname === '/auth/v1/user') {
        if (auth !== 'Bearer '+recoveryToken) return response({message:'Invalid session'},401);
        if (options.method === 'PUT') { savedPassword=body.password; writes++; }
        return response(recoveryUser);
      }
      if (u.pathname === '/auth/v1/logout') return response({});
      if (u.pathname === '/rest/v1/password_recovery_tickets') return response((await f.q('select id,expires_at from password_recovery_tickets where id=$1 and user_id=$2 and used_at is null',[u.searchParams.get('id').slice(3),u.searchParams.get('user_id').slice(3)])).rows);
      if (u.pathname === '/auth/v1/token') {
        assert.equal(u.searchParams.get('grant_type'),'password','no PKCE exchange is needed on the receiving device');
        return body.email===recoveryUser.email && body.password===savedPassword ? response(session('signed-in-after-reset',recoveryUser)) : response({message:'Invalid credentials'},400);
      }
      return dbFetch(url,options);
    };
    const handlers = Object.fromEntries(['request','verify','reset'].map(name=>['/api/auth/password/'+name,load('app/api/auth/password/'+name+'/route.js')]));
    handlers['/api/auth/login']=load('app/api/auth/login/route.js');
    async function isolatedDevice() {
      const context=await browser.newContext(), page=await context.newPage({viewport:{width:1100,height:800}});
      await page.route('**/api/auth/**',async route=>{
        const request=route.request(), url=new URL(request.url()), headers=await request.allHeaders();
        if(url.pathname==='/api/auth/password/verify' && request.postDataJSON()?.access_token) initialCookies.push(headers.cookie || '');
        const handler=handlers[url.pathname];
        if(!handler) return route.fulfill({status:404,json:{message:'Not part of recovery test'}});
        const result=await handler.POST(new NextRequest(request.url(),{method:'POST',headers,body:request.postDataBuffer()}));
        await route.fulfill({status:result.status,headers:Object.fromEntries(result.headers),body:Buffer.from(await result.arrayBuffer())});
      });
      return {context,page};
    }
    const sender=await isolatedDevice(), receiver=await isolatedDevice();
    await sender.page.goto(base+'/reset-password');
    await sender.page.getByRole('button',{name:'Request a new reset link',exact:true}).click();
    await sender.page.getByLabel('Email address',{exact:true}).fill(f.users.basic.email);
    await sender.page.getByRole('button',{name:'Send reset link',exact:true}).click();
    await sender.page.getByText('If an account exists for this email, we sent a password reset link. Please check your inbox and spam folder.',{exact:true}).waitFor();
    assert((await sender.context.cookies()).some(c=>c.name==='ssb-password-recovery'));
    assert.equal((await receiver.context.cookies()).length,0,'receiving PC starts with no requester cookies');
    const link=base+'/reset-password#'+new URLSearchParams({access_token:recoveryToken,refresh_token:'fixture-refresh',type:'recovery',expires_in:'3600',token_type:'bearer'});
    await receiver.page.goto(link);
    await receiver.page.getByRole('heading',{name:'Set new password',exact:true}).waitFor();
    assert.equal(initialCookies[0],'','the emailed recovery proof must work with no sender cookie');
    assert.equal(new URL(receiver.page.url()).hash,'');
    assert.equal(new URL(receiver.page.url()).search,'');
    assert.deepEqual(await receiver.page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}})),{local:{},session:{}},'recovery tokens are not stored in browser storage');
    await receiver.page.screenshot({path:path.join(output,'receiver-ready-no-sender-cookie.png')});
    await receiver.page.reload();
    await receiver.page.getByRole('heading',{name:'Set new password',exact:true}).waitFor();
    const replay=await isolatedDevice();await replay.page.goto(link);
    await replay.page.getByRole('button',{name:'Request a new reset link',exact:true}).waitFor();
    assert.equal(await replay.page.getByLabel('New password',{exact:true}).count(),0,'same email session cannot create a second reset ticket on another device');
    await receiver.page.getByLabel('New password',{exact:true}).fill('fixture-only-new-password');
    await receiver.page.getByLabel('Confirm password',{exact:true}).fill('fixture-only-new-password');
    await receiver.page.getByRole('button',{name:'Save password',exact:true}).click();
    await receiver.page.getByText('Password changed successfully',{exact:true}).waitFor();
    assert.equal(writes,1);
    assert.deepEqual(await f.one('select * from profiles where id=$1',[f.users.basic.id]),before,'reset cannot change profile/role/access/usage');
    // Keep fixture credentials inside the isolated Auth boundary.
    const signedIn=await handlers['/api/auth/login'].POST(new NextRequest(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:recoveryUser.email,password:'fixture-only-new-password'})}));
    assert.equal(signedIn.status,200);assert.equal((await signedIn.json()).session.user.id,recoveryUser.id);
    await receiver.page.goto(base);await receiver.page.goto(link);
    await receiver.page.getByRole('button',{name:'Request a new reset link',exact:true}).waitFor();
    assert.equal(writes,1,'reopening a used link cannot write another password');
    assert.equal(calls.filter(c=>c.path==='/auth/v1/token'&&c.query.get('grant_type')==='pkce').length,0);
    console.log('PASS: isolated Browser A requests / Browser B with no cookies opens recovery; real SDK + APIs + SQL, URL scrub, reload, single-use/replay rejection, password update/new-password login, unchanged profile/access/usage. Screenshots:',output);
  } finally {await browser.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
