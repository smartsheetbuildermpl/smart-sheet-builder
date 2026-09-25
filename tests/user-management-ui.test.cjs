const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const base = process.env.SMART_SHEET_TEST_URL || 'http://localhost:3000';
const sessionKey = 'smart-sheet-builder-v53b-session';
const output = fs.mkdtempSync(path.join(os.tmpdir(),'ssb-user-management-'));
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  const errors=[];
  try {
    let identity='guest',registerBody,updates=[],profile={full_name:'Test User',business_name:'Shop',mobile:'',city:'',country:'',machine_type:'DTF',monthly_usage:''};
    let record={...profile,id:'00000000-0000-4000-8000-000000000002',email:'basic@example.test',role:'user',status:'active',account_status:'active',export_access:'standard',is_super_admin:false,can_manage_design_library:false,recorded_exports:0,exports_used:0,remaining:5,registered_at:'2026-09-01T00:00:00Z',created_at:'2026-09-01T00:00:00Z',email_confirmed_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-01T00:00:00Z'};
    const owner={...record,id:'00000000-0000-4000-8000-000000000001',full_name:'Owner',email:'masterprintlabcorp@gmail.com',is_super_admin:true,export_access:'unlimited',remaining:null,can_manage_design_library:true};
    let history=[];
    const page=await browser.newPage({viewport:{width:1280,height:900}});page.on('pageerror',e=>errors.push(e.message));
    const usage=()=>({signedIn:identity!=='guest',email:identity==='owner'?owner.email:record.email,label:identity==='owner'?'Admin':'Free account',isAdmin:identity==='owner',isSuperAdmin:identity==='owner',canManageLibrary:identity==='owner',unlimited:identity==='owner',used:0,remaining:identity==='owner'?null:identity==='guest'?2:5,limit:identity==='guest'?2:5});
    await page.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url()),body=req.postDataJSON();
      if(url.pathname==='/api/auth/register'){registerBody=body;return route.fulfill({status:202,json:{configured:true,message:'Check your email to finish registration, then sign in.'}});}
      if(url.pathname==='/api/auth/login'){identity='basic';return route.fulfill({json:{session:{accessToken:'basic',user:{email:record.email}},usage:usage()}});}
      if(url.pathname==='/api/auth/me'||url.pathname==='/api/export/status') return route.fulfill({json:{configured:true,usage:usage()}});
      if(url.pathname==='/api/auth/profile') {if(req.method()==='PATCH'){profile={...profile,...body};return route.fulfill({json:{message:'Profile saved.'}});}return route.fulfill({json:{profile}});}
      if(url.pathname==='/api/admin/users') {
        if(identity!=='owner')return route.fulfill({status:403,json:{message:'Super Admin required.'}});
        const rows=[record,owner].filter(u=>(!url.searchParams.get('search')||`${u.full_name} ${u.email}`.toLowerCase().includes(url.searchParams.get('search').toLowerCase()))&&(!url.searchParams.get('status')||u.account_status===url.searchParams.get('status'))&&(!url.searchParams.get('access')||u.export_access===url.searchParams.get('access')));
        return route.fulfill({json:{users:rows,total:rows.length}});
      }
      if(url.pathname.startsWith('/api/admin/users/')) {
        const u=url.pathname.endsWith(owner.id)?owner:record;
        if(req.method()==='PATCH'){
          updates.push(body);const previous=body.field==='status'?record.status:record.export_access;
          if(body.field==='status'){record.status=body.value;record.account_status=body.value==='blocked'?'suspended':'active';}else{record.export_access=body.value;record.remaining=body.value==='unlimited'?null:5;}
          history.unshift({sort_key:`audit-${updates.length}`,event:'admin_access_change',old_value:{[body.field]:previous},new_value:{[body.field]:body.value},actor_id:owner.id,actor_email:owner.email,created_at:new Date().toISOString()});
          return route.fulfill({json:{message:'Account updated. Change recorded in history.'}});
        }
        return route.fulfill({json:{user:u,history:u===owner?[]:history}});
      }
      return route.fulfill({json:{configured:true,designs:[],categories:[]}});
    });
    const reveal=async()=>{await page.locator('.access-reveal-handle').hover();await page.locator('.access-bar.is-open').waitFor();};
    await page.goto(base);await reveal();await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('tab',{name:'Create account',exact:true}).click();
    await page.setViewportSize({width:375,height:812});
    await page.getByLabel('Full name',{exact:true}).fill('Test User');await page.getByLabel('Email',{exact:true}).fill(record.email);await page.getByLabel('Password',{exact:true}).fill('test-password');
    await page.getByText('Business & printing details (optional)',{exact:true}).click();await page.getByLabel('Business / shop name').fill('Shop');await page.getByLabel('Printing use / machine type').selectOption('DTF');
    assert(await page.locator('.access-modal-card').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'registration no horizontal overflow at 375px');
    await page.screenshot({path:path.join(output,'registration-mobile.png')});
    await page.locator('.auth-form button[type=submit]').click();await page.getByRole('status').filter({hasText:'Check your email'}).waitFor();
    assert.equal(registerBody.profile.full_name,'Test User');assert.equal(registerBody.profile.business_name,'Shop');assert.equal(registerBody.profile.machine_type,'DTF');
    assert.equal(await page.evaluate(k=>localStorage.getItem(k),sessionKey),null,'confirmation must not invent a session');
    await page.getByRole('tab',{name:'Sign in',exact:true}).click();await page.getByLabel('Password',{exact:true}).fill('test-password');await page.locator('.auth-form button[type=submit]').click();await page.locator('.access-modal').waitFor({state:'detached'});await reveal();
    assert.equal(await page.getByRole('button',{name:'Users & Registrations',exact:true}).count(),0,'Basic cannot see admin area');
    await page.getByRole('button',{name:'Account',exact:true}).click();await page.getByLabel('Full name',{exact:true}).fill('Updated User');await page.getByRole('button',{name:'Save profile'}).click();await page.getByText('Profile saved.',{exact:true}).waitFor();assert.equal(profile.full_name,'Updated User');await page.getByRole('button',{name:'Close account'}).click();
    identity='owner';await page.evaluate(k=>localStorage.setItem(k,JSON.stringify({accessToken:'owner',user:{email:'masterprintlabcorp@gmail.com'}})),sessionKey);await page.reload();await page.setViewportSize({width:1280,height:900});await reveal();
    await page.getByRole('button',{name:'Users & Registrations',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Users & Registrations'});await dialog.waitFor();await page.getByRole('button',{name:/Test User.*basic@example/}).click();await page.getByText(/No activity recorded yet/).waitFor();
    assert.equal(await page.getByRole('button',{name:'Set Unlimited access'}).count(),1);
    page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Set Unlimited access'}).click();assert.equal(updates.length,0,'cancel confirmation performs no mutation');
    page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Set Unlimited access'}).click();await page.getByRole('button',{name:'Set Standard access'}).waitFor();assert.equal(updates.length,1);assert.equal(record.role,'user');
    page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Suspend account'}).click();await page.getByRole('button',{name:'Reactivate account'}).waitFor();assert.equal(record.status,'blocked');
    page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Reactivate account'}).click();await page.getByRole('button',{name:'Suspend account'}).waitFor();assert.equal(record.status,'active');
    await page.screenshot({path:path.join(output,'users-desktop.png')});
    await page.getByLabel('Search name or email').fill('nobody');await page.getByText('No users match these filters.',{exact:true}).waitFor();await page.getByLabel('Search name or email').fill('');await page.getByRole('button',{name:/Owner.*masterprintlabcorp/}).click();await page.getByText(/Owner critical access is protected/).waitFor();assert.equal(await page.getByRole('button',{name:'Suspend account'}).count(),0);
    await page.setViewportSize({width:375,height:812});assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'admin no mobile horizontal overflow');
    await page.screenshot({path:path.join(output,'users-mobile.png')});
    await page.getByRole('button',{name:'Close Users & Registrations'}).focus();await page.keyboard.press('Shift+Tab');assert(await page.evaluate(()=>document.querySelector('.users-dialog').contains(document.activeElement)),'native dialog traps focus');await page.keyboard.press('Escape');await dialog.waitFor({state:'detached'});
    assert.deepEqual(errors,[]);console.log(`PASS: registration confirmation, profile update, Basic UI isolation, owner list/details, empty/search, confirmed/cancelled access and suspension, owner protection, mobile geometry, focus/Escape. Screenshots: ${output}`);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
