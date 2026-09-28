// Browser pages + actual API handlers/SQL; only external Supabase Auth is mocked.
const {chromium}=require('playwright'),{fixture,load}=require('./export-enforcement.test.cjs');
const {NextRequest}=require('next/server'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const base=process.env.SMART_SHEET_TEST_URL||'http://localhost:3112';
async function usageText(page){await page.locator('.access-reveal-handle').hover();await page.locator('.usage-card').waitFor({state:'visible'});return page.locator('.usage-card').innerText();}
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),f=await fixture();try{
 process.env.SMART_SHEET_SITE_URL=base;
 for(const file of ['supabase-password-recovery-v1.sql','supabase-auth-callback-v1.sql'])await f.db.exec(fs.readFileSync(file,'utf8'));
 const user={...f.users.basic,recovery_sent_at:new Date().toISOString()},now=Math.floor(Date.now()/1000),used=new Set();
 const jwt=method=>Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:user.id,session_id:method+'-session',exp:now+3600,amr:[{method,timestamp:now}]})).toString('base64url')+'.dGVzdA';
 const authSession={access_token:jwt('password'),refresh_token:'fresh-refresh',expires_in:3600,token_type:'bearer',user};
 const dbFetch=global.fetch;let authCalls=0,confirmCalls=0;
 global.fetch=async(url,options={})=>{
  const u=new URL(url),body=options.body?JSON.parse(options.body):{},ok=d=>new Response(JSON.stringify(d),{status:200});
  if(u.pathname==='/auth/v1/token'){authCalls++;return body.password==='test-password-123'?ok(authSession):new Response(JSON.stringify({message:'Invalid login credentials'}),{status:400});}
  if(u.pathname==='/auth/v1/user')return ok(user);
  if(u.pathname==='/auth/v1/logout'||u.pathname==='/auth/v1/recover'||u.pathname==='/auth/v1/resend')return ok({});
  if(u.pathname==='/auth/v1/verify'){
   if(!['c'.repeat(64),'r'.repeat(64)].includes(body.token_hash)||used.has(body.token_hash))return new Response(JSON.stringify({message:'Expired'}),{status:403});
   used.add(body.token_hash);return ok({...authSession,access_token:jwt('otp')});
  }
  return dbFetch(url,options);
 };
 const routes={'/api/auth/confirm':load('app/api/auth/confirm/route.js'),'/api/auth/login':load('app/api/auth/login/route.js'),'/api/auth/me':f.me,'/api/export/status':f.status};
 for(const name of ['verify','request','reset'])routes['/api/auth/password/'+name]=load('app/api/auth/password/'+name+'/route.js');
 routes['/api/auth/confirmation/request']=load('app/api/auth/confirmation/request/route.js');
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>console.log('NETWORK DEBUG',new URL(r.url()).origin+new URL(r.url()).pathname,r.failure()?.errorText));let sdkCalls=0;
 await page.route('**/auth/v1/**',r=>{sdkCalls++;const path=new URL(r.request().url()).pathname;assert(['/auth/v1/user','/auth/v1/logout'].includes(path),'SDK normalizes configured /rest/v1/ suffix');return r.fulfill({json:path.endsWith('/logout')?{}:user});});
 await page.route('**/api/**',async r=>{const q=r.request(),u=new URL(q.url()),handler=routes[u.pathname];if(!handler)return r.fulfill({json:{profile:{full_name:'Test'},history:[]}});if(u.pathname==='/api/auth/confirm')confirmCalls++;
  const req=new NextRequest(q.url(),{method:q.method(),headers:await q.allHeaders(),...(q.postData()?{body:q.postData()}:{})}),res=await handler[q.method()](req);
  return r.fulfill({status:res.status,headers:Object.fromEntries(res.headers),body:await res.text()});
 });
 await page.goto(base+'/?signin=1');await page.locator('.auth-form input[type=email]').fill(user.email);await page.locator('.auth-form input[type=password]').fill('test-password-123');await page.locator('.auth-form button[type=submit]').click();await page.waitForFunction(()=>!document.querySelector('.access-modal'),null,{timeout:10000}).catch(async e=>{console.log('LOGIN DEBUG',await page.locator('.access-modal').innerText(),{authCalls,sdkCalls});throw e;});assert(authCalls>0&&sdkCalls>0,'real login route and SDK adoption completed');assert.match(await usageText(page),/basic@test.example/);
 await page.goto(base+'/auth/callback?token_hash='+'c'.repeat(64)+'&type=signup');await page.getByRole('heading',{name:'Email confirmed',exact:true}).waitFor();assert.equal(confirmCalls,1,'StrictMode single exchange');assert.equal(new URL(page.url()).search,'');await page.getByText('Your Smart Sheet Builder account is ready.',{exact:true}).waitFor();
 const output=fs.mkdtempSync(path.join(os.tmpdir(),'ssb-callback-ui-'));await page.screenshot({path:path.join(output,'confirmed.png')});
 await page.goto(base+'/auth/callback?token_hash='+'c'.repeat(64)+'&type=signup');await page.getByRole('button',{name:'Send a new confirmation email'}).waitFor();await page.getByLabel('Email address').fill(user.email);await page.getByRole('button',{name:'Send a new confirmation email'}).click();await page.getByRole('button',{name:/Resend in/}).waitFor();assert(await page.getByRole('button',{name:/Resend in/}).isDisabled());
 await page.goto(base+'/reset-password?token_hash='+'r'.repeat(64)+'&type=recovery');await page.getByRole('button',{name:'Set new password'}).waitFor();await page.getByLabel('New password',{exact:true}).fill('new-password-123');await page.getByLabel('Confirm new password',{exact:true}).fill('new-password-123');await page.screenshot({path:path.join(output,'reset.png')});await page.getByRole('button',{name:'Set new password'}).click();await page.getByText('Password updated successfully',{exact:true}).waitFor();
 await page.goto(base+'/reset-password?token_hash='+'r'.repeat(64)+'&type=recovery');await page.getByRole('button',{name:'Request a new reset link'}).waitFor();
 await page.goto(base+'/#access_token='+jwt('otp')+'&type=recovery');await page.getByRole('button',{name:'Set new password'}).waitFor();assert.equal(new URL(page.url()).pathname,'/reset-password');assert.equal(new URL(page.url()).hash,'');
 await page.goto(base+'/reset-password#error=access_denied&error_description=private-detail');await page.getByRole('button',{name:'Request a new reset link'}).waitFor();assert(!(await page.locator('body').innerText()).includes('private-detail'));await page.screenshot({path:path.join(output,'expired.png')});
 assert.deepEqual(errors,[]);console.log('PASS: Chrome login using real route + SDK with malformed legacy URL normalized; confirmation success/used/resend; reset success/used; legacy root recovery redirect; mobile, token scrubbing, no blank pages. Screenshots: '+output);
}finally{await browser.close();await f.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
