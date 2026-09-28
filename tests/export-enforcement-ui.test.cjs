const {chromium}=require('playwright'),{fixture}=require('./export-enforcement.test.cjs'),{NextRequest}=require('next/server'),assert=require('node:assert/strict'),fs=require('node:fs');
const base=process.env.SMART_SHEET_TEST_URL||'http://localhost:3112';
const inject=`window.exportQA={seed:function(){var c=document.createElement('canvas');c.width=8;c.height=8;c.getContext('2d').fillRect(2,2,4,4);window.qaSheet={renderCanvas:c,widthPx:8,heightPx:8,placements:[],headerHeightPx:0,exportUi:{progress:document.createElement('p')}};sheets=[qaSheet];renderAllSheets();qaSheet.renderCanvas.getContext('2d').fillRect(2,2,4,4);},png:function(){return downloadPng(qaSheet,0)},tiff:function(){return downloadTiff(qaSheet,0,getExportProfile('rgb'))},failEncode:function(){qaSheet.renderCanvas.toBlob=function(cb){cb(null)}}};var realSave=saveExportBlob;exportDelivery=SmartSheetExportDelivery.create({gate:requestExportAccess,save:function(){if(window.diskFailure)throw Error('Disk full');return realSave.apply(null,arguments)}});`;
const html=fs.readFileSync('public/builder.html','utf8').replace(/\}\)\(\);\s*<\/script>/,inject+'})();</script>');
const jwt=(user,exp)=>`${Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify({sub:user.id,exp,iat:exp-3600,role:'authenticated'})).toString('base64url')}.test-signature`;
async function usageText(page){await page.locator('.access-reveal-handle').hover();await page.locator('.usage-card').waitFor({state:'visible'});return page.locator('.usage-card').innerText();}
(async()=>{const browser=await chromium.launch({channel:'chrome',headless:true}),f=await fixture();try{
 const files=[];let downloads=0,refreshes=0,authFailure=false,networkFailure=false,exportOutage=false;const errors=[];
 async function pageFor(name){const context=await browser.newContext(),page=await context.newPage();page.on('download',d=>{downloads++;files.push(d.path().then(p=>{assert(fs.statSync(p).size>0,'downloaded file is nonempty')}));});page.on('pageerror',e=>errors.push(e.message));
  if(name){const user=f.users[name],expired=jwt(user,Math.floor(Date.now()/1000)-3600);await context.addInitScript(({user,expired})=>{if(!sessionStorage.getItem('qa-seeded')){localStorage.setItem('smart-sheet-builder-v53b-session',JSON.stringify({accessToken:expired,refreshToken:'valid-refresh',user}));sessionStorage.setItem('qa-seeded','1');}},{user,expired});}
  await page.route('**/builder.html',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.route('**/auth/v1/**',r=>{const u=new URL(r.request().url());if(u.pathname.endsWith('/token')){refreshes++;if(authFailure)return r.fulfill({status:400,json:{error_code:'refresh_token_not_found',msg:'Invalid Refresh Token: Refresh Token Not Found'}});const user=f.users[name||'basic'];return r.fulfill({json:{access_token:jwt(user,Math.floor(Date.now()/1000)+3600),refresh_token:'refreshed-token-'+refreshes,expires_in:3600,token_type:'bearer',user}});}if(u.pathname.endsWith('/logout'))return r.fulfill({json:{}});return r.fulfill({json:f.users[name||'basic']});});
  await page.route('**/api/**',async r=>{const request=r.request(),url=new URL(request.url()),headers=await request.allHeaders();if(headers.authorization&&name)headers.authorization='Bearer '+name;
   if(exportOutage&&url.pathname==='/api/export/consume')return r.fulfill({status:503,json:{message:'Unavailable'}});
   if(networkFailure&&['/api/auth/me','/api/export/status'].includes(url.pathname))return r.fulfill({status:503,json:{message:'Temporary network failure'}});
   const req=new NextRequest(request.url(),{method:request.method(),headers,...(request.postData()?{body:request.postData()}:{})});let result;
   if(url.pathname==='/api/export/status')result=await f.status.GET(req);
   else if(url.pathname==='/api/export/consume')result=await f.consume.POST(req);
   else if(url.pathname==='/api/auth/me')result=await f.me.GET(req);
   else return r.fulfill({json:{profile:{full_name:'Test user'},credits:{balance:0},history:[]}});
   await r.fulfill({status:result.status,headers:Object.fromEntries(result.headers),body:await result.text()});
  });
  await page.goto(base);await page.waitForFunction(()=>document.querySelector('.usage-card')?.textContent.includes('Server protected'));return {page,context};
 }
 async function blockedClicks(page,frame,title){
 await page.evaluate(()=>{window.pickerCalls=0;window.showSaveFilePicker=async()=>{window.pickerCalls++;throw Error('Denied export opened picker')};});
 await frame.evaluate(()=>{Object.defineProperty(navigator,'webdriver',{configurable:true,get:()=>false});window.encodeCalls=0;const read=CanvasRenderingContext2D.prototype.getImageData,blob=HTMLCanvasElement.prototype.toBlob;CanvasRenderingContext2D.prototype.getImageData=function(){window.encodeCalls++;return read.apply(this,arguments)};HTMLCanvasElement.prototype.toBlob=function(){window.encodeCalls++;return blob.apply(this,arguments)};});
 for(const kind of ['png','tiff']){
  if(kind==='png')await frame.getByRole('button',{name:'PNG backup',exact:true}).click();
  else {await frame.getByRole('button',{name:'Download TIFF',exact:true}).click();}
  await page.getByRole('heading',{name:title,exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>pickerCalls),0,'denied picker never invoked');assert.equal(await frame.evaluate(()=>encodeCalls),0,'no export encoding on denial');
  if(kind==='png')await page.getByRole('button',{name:'Continue editing',exact:true}).click();
 }
 await page.evaluate(()=>{delete window.showSaveFilePicker});await frame.evaluate(()=>Object.defineProperty(navigator,'webdriver',{configurable:true,get:()=>true}));
}
const seed=async page=>{const frame=page.frames().find(f=>f.url().includes('/builder.html'));await frame.waitForFunction(()=>window.exportQA);await frame.evaluate(()=>exportQA.seed());return frame;};
 const guest=await pageFor();let frame=await seed(guest.page);assert.match(await usageText(guest.page),/2 left/);
 const cookies=await guest.context.cookies();const cookie=cookies.find(c=>c.name==='ssb_guest_trial');assert(cookie.httpOnly);assert.equal(cookie.sameSite,'Lax');assert(!await guest.page.evaluate(()=>document.cookie.includes('ssb_guest_trial')));
 await frame.evaluate(()=>Promise.all([exportQA.png(),exportQA.png(),exportQA.tiff()]));assert.equal(downloads,1,'double click saves once');assert.match(await usageText(guest.page),/1 left/);
 await guest.page.reload();await guest.page.waitForFunction(()=>document.querySelector('.usage-card')?.textContent.includes('1 left'));frame=await seed(guest.page);
 await frame.evaluate(()=>exportQA.tiff());assert.equal(downloads,2);assert.match(await usageText(guest.page),/0 left/);
 await guest.page.reload();await guest.page.waitForFunction(()=>document.querySelector('.usage-card')?.textContent.includes('0 left'));frame=await seed(guest.page);
 await blockedClicks(guest.page,frame,'Your guest trial is complete');assert.equal(downloads,2,'guest third PNG/TIFF blocked, no download event');
 assert.equal((await guest.context.cookies()).find(c=>c.name==='ssb_guest_trial').value,cookie.value);
 await Promise.all(files);await guest.context.close();
 const basic=await pageFor('basic');assert(refreshes>0,'expired legacy access token refreshed with real SDK');assert.match(await usageText(basic.page),/basic@test.example/);let before=downloads;
 await f.q('update free_export_credits set balance=1,refill_from=clock_timestamp() where user_id=$1',[f.users.basic.id]);frame=await seed(basic.page);await frame.evaluate(()=>exportQA.png());assert.equal(downloads,before+1);assert.match(await usageText(basic.page),/0 \/ 2/);
 await blockedClicks(basic.page,frame,'No Free Export Credits available');assert.equal(downloads,before+1);await basic.page.locator('.access-modal').getByRole('button',{name:'Wait for free credit'}).waitFor();assert(await basic.page.locator('.access-modal').getByRole('button',{name:'Buy Export Credits — Coming Soon'}).isDisabled());
 await basic.page.reload();await basic.page.waitForFunction(()=>document.querySelector('.usage-card')?.textContent.includes('basic@test.example'));assert(await basic.page.evaluate(()=>Boolean(JSON.parse(localStorage.getItem('ssb-supabase-auth-v1')).refresh_token)));
 networkFailure=true;await basic.page.reload();await basic.page.waitForFunction(()=>document.querySelector('.usage-card')?.textContent.includes('Access check unavailable'));assert.match(await usageText(basic.page),/basic@test.example/,'temporary outage keeps signed-in identity');networkFailure=false;await basic.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await basic.page.waitForFunction(()=>document.querySelector('.usage-card')?.textContent.includes('0 / 2'));
 await f.q('update free_export_credits set balance=1,refill_from=clock_timestamp() where user_id=$1',[f.users.basic.id]);frame=await seed(basic.page);before=downloads;await frame.evaluate(()=>{window.diskFailure=true;return exportQA.png()});assert.equal(downloads,before);assert.equal((await f.one('select balance from free_export_credits where user_id=$1',[f.users.basic.id])).balance,1);
 await frame.evaluate(()=>{window.diskFailure=false;exportQA.failEncode();return exportQA.png()});assert.equal((await f.one('select balance from free_export_credits where user_id=$1',[f.users.basic.id])).balance,1);
 // Simulate a discarded idle tab with an expired access JWT and valid refresh token.
 await basic.page.evaluate(()=>{const k='ssb-supabase-auth-v1',s=JSON.parse(localStorage.getItem(k));s.expires_at=1;localStorage.setItem(k,JSON.stringify(s));});const refreshBefore=refreshes;await basic.page.reload();await basic.page.waitForFunction(()=>document.querySelector('.usage-card')?.textContent.includes('basic@test.example'));assert(refreshes>refreshBefore);
 authFailure=true;await basic.page.evaluate(()=>{const k='ssb-supabase-auth-v1',s=JSON.parse(localStorage.getItem(k));s.expires_at=1;localStorage.setItem(k,JSON.stringify(s));});await basic.page.reload();await basic.page.waitForFunction(()=>document.querySelector('.usage-card')?.textContent.includes('Not signed in'));assert.equal(await basic.page.evaluate(()=>localStorage.getItem('smart-sheet-builder-v53b-session')),null);authFailure=false;await Promise.all(files);await basic.context.close();
 for(const name of ['owner','unlimited']){const user=await pageFor(name);frame=await seed(user.page);before=downloads;await frame.evaluate(()=>exportQA.png());await frame.evaluate(()=>exportQA.tiff());assert.equal(downloads,before+2);assert.match(await usageText(user.page),/Unlimited/);await Promise.all(files);await user.context.close();}
 await Promise.all(files);const outage=await pageFor('owner');frame=await seed(outage.page);before=downloads;exportOutage=true;await blockedClicks(outage.page,frame,'Export unavailable');assert.equal(downloads,before);await outage.page.getByText('Export access is temporarily unavailable. Please refresh and try again.',{exact:true}).waitFor();exportOutage=false;await outage.context.close();assert.deepEqual(errors,[]);console.log('PASS: browser real PNG/TIFF + actual API/SQL gate; guest 2→1→0 across reload; duplicate click; registered 1→0 blocks both; failed encoding/save no charge; real Supabase SDK idle refresh, temporary outage preservation, invalid refresh logout; owner/Unlimited both formats.');
 }finally{await browser.close();await f.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
