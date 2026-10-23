const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fixture, png, load } = require('./client-jobs.test.cjs');
const { chromium } = require('playwright');
const { NextRequest } = require('next/server');
const base = process.env.SMART_SHEET_TEST_URL || 'http://localhost:3114';
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'client-roll-'));

(async () => {
  const f = await fixture(); let browser;
  try {
    const previous = load('app/api/_lib/client-jobs.js', execFileSync('git', ['show', 'd1c017c:app/api/_lib/client-jobs.js'], { encoding:'utf8' }));
    const fixed = { ...f.lib.defaults, shopName:'Roll test shop', email:'roll@example.test' };
    const source = { id:randomUUID(), ready:true, width:600, height:900, crop:{x:0,y:0,w:600,h:900}, qty:1, widthIn:21.7033, heightIn:38.56 };
    assert.throws(() => f.lib.layout([source], fixed), /cannot fit/);
    assert.throws(() => f.lib.layout([source], {...fixed,mediaMode:'fixed',autoExtend:false}), /cannot fit/, 'explicit fixed mode is independent of the old DTF checkbox');
    for (const machine of ['dtf','uvdtf24','uvdtf12','tarpaulin']) {
      for (const autoExtend of [true,false]) {
        const config = { ...fixed, machine, widthIn:machine === 'uvdtf12' ? 11 : 23, autoExtend };
        const items = [{...source,qty:10,widthIn:4,heightIn:3}];
        assert.deepEqual(f.lib.layout(items, config), previous.layout(items,config), 'legacy layout/manifest stays byte-for-byte equivalent');
      }
    }
    assert.throws(() => f.lib.settings({...fixed,mediaMode:'bogus'}), /Choose Fixed/);
    assert.throws(() => f.lib.settings({...fixed,mediaMode:'continuous',leadIn:-1}), /leadIn/);
    const config = {...fixed,mediaMode:'continuous',leadIn:0.5,trailIn:0.5};
    const roll = f.lib.layout([source],config);
    assert.equal(roll.sheets.length,1); assert.equal(roll.totalPieces,1);
    assert.deepEqual([roll.sheets[0].widthPx,roll.sheets[0].heightPx],[6900,11868]);
    assert.equal(roll.roll.lengthIn,39.56);
    assert(Math.abs(roll.meters-1.004824)<1e-12);
    assert.equal(roll.roll.fullMeters,1);
    assert(Math.abs(roll.roll.nextMeterPercent-0.4824)<1e-10);
    assert.equal(roll.sheets[0].placements[0].rotation,0);
    assert.equal(roll.sheets[0].placements[0].baseW,6511);
    assert.equal(roll.sheets[0].placements[0].baseH,11568);
    for (const machine of ['dtf','uvdtf24','uvdtf12','tarpaulin']) {
      const actualWidth=machine==='uvdtf12'?10.75:machine==='tarpaulin'?61:22.95;
      const result=f.lib.layout([{...source,widthIn:actualWidth-1.1,heightIn:80,qty:2}],{...config,machine,widthIn:actualWidth});
      assert.equal(result.sheets.length,1); assert(result.meters>4);
      assert.equal(result.roll.widthIn,Math.round(actualWidth*300)/300);
      assert(result.sheets[0].placements.every(p=>p.baseH===24000 && p.rotation===0));
    }
    const tall=f.lib.layout([{...source,heightIn:80}],config);
    assert.equal(tall.roll.lengthIn,81,'single artwork crosses virtual meter marks intact');
    assert.throws(()=>f.lib.layout([{...source,widthIn:22.01,heightIn:30}],config),/Maximum allowed artwork width is 22.0000 in/);
    const rotated=f.lib.layout([{...source,widthIn:30,heightIn:20}],config);
    assert.equal(rotated.sheets[0].placements[0].rotation,90,'existing rotation setting remains authoritative');
    assert.throws(()=>f.lib.layout([{...source,widthIn:30,heightIn:20}],{...config,rotate:false}),/Rotation is disabled/);
    const copies=f.lib.layout([{...source,qty:3}],config);
    assert.equal(copies.sheets.length,1); assert.equal(copies.sheets[0].placements.length,3);
    assert.equal(copies.roll.lengthIn,117.28,'lead/trail applied once, two inter-piece gaps only');

    const token=await f.portal('basic',config), draft=await f.call('create',token);
    const original=png(600,900);
    const uploaded=await f.call('upload',token,draft.submission,original);
    assert.equal(uploaded.status,200,uploaded.message);
    const id=uploaded.job.assets[0].id;
    const preview=await f.call('preview',token,draft.submission,{quantities:[{id,qty:3,widthIn:21.7033,heightIn:38.56}]});
    assert.equal(preview.status,200,preview.message);
    assert.equal(preview.job.manifest.mediaMode,'continuous');
    const locked=await f.call('confirm',token,draft.submission,{revision:preview.job.revision});
    assert.equal(locked.status,200,locked.message); assert.equal(f.emails.length,1);
    assert.equal(new Date(locked.job.expires_at)-new Date(locked.job.confirmed_at),86400000);
    const saved=(await f.one('select * from client_jobs where id=$1',[draft.job.id])).manifest;
    await f.portal('basic',{...fixed,mediaMode:'fixed'});
    assert.deepEqual((await f.one('select * from client_jobs where id=$1',[draft.job.id])).manifest,saved);
    const fetched=await f.files.GET(f.req('/',undefined,'basic'),{params:{id:draft.job.id,file:id}});
    assert.equal(fetched.status,200); assert.deepEqual(Buffer.from(await fetched.arrayBuffer()),original);
    assert.equal((await f.owner.GET(f.req(`/?id=${draft.job.id}`,undefined,'unlimited'))).status,404);

    if(process.env.CLIENT_ROLL_BROWSER!=='0') {
      await f.portal('basic',config);
      browser=await chromium.launch({channel:'chrome',headless:true});
      const page=await browser.newPage({viewport:{width:1360,height:950}}), errors=[];
      page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{const make=window.createImageBitmap;window.rollBitmaps=[];window.createImageBitmap=async(...args)=>{const b=await make(...args);window.rollBitmaps.push([b.width,b.height]);return b;};});
      await page.route('**/api/client-upload/**',async route=>{
        const req=route.request();
        const response=await f.pub[req.method()](new NextRequest(req.url(),{method:req.method(),headers:{...req.headers(),'x-test-ingress-ip':'203.0.113.88'},...(req.method()==='POST'?{body:req.postDataBuffer()}:{})}),{params:{token}});
        await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
      });
      await page.goto(`${base}/client-upload/${token}`);
      await page.getByLabel('Project / Client Name *',{exact:true}).fill('Boracay continuous roll');
      await page.locator('input[type=file]').setInputFiles({name:'roll-source.png',mimeType:'image/png',buffer:original});
      await page.getByText('All designs are ready for preview.',{exact:true}).waitFor();
      await page.getByLabel('Lock aspect ratio for roll-source.png',{exact:true}).uncheck();
      await page.getByLabel('Width (in) for roll-source.png',{exact:true}).fill('21.7033');
      await page.getByLabel('Height (in) for roll-source.png',{exact:true}).fill('38.56');
      await page.getByRole('button',{name:'Generate Print Preview',exact:true}).click();
      await page.getByText('Estimated roll usage: 1.004824 m',{exact:true}).waitFor();
      await page.waitForFunction(()=>document.querySelector('.client-preview canvas')&&!document.querySelector('.client-preview[hidden]'));
      assert.equal(await page.locator('.client-meter-marker').innerText(),'Meter 1');
      await page.screenshot({path:path.join(out,'roll-fixture.png'),fullPage:true});
      await page.locator('.client-preview').screenshot({path:path.join(out,'roll-fixture-preview.png')});
      await page.getByRole('spinbutton',{name:'Quantity for roll-source.png',exact:true}).fill('4');
      await page.getByRole('button',{name:'Generate Print Preview',exact:true}).click();
      await page.getByLabel('Roll preview view',{exact:true}).waitFor();
      await page.waitForFunction(()=>document.querySelectorAll('.client-meter-marker').length===2&&!document.querySelector('.client-preview[hidden]'));
      assert.deepEqual(await page.locator('.client-meter-marker').allTextContents(),['Meter 1','Meter 2']);
      await page.screenshot({path:path.join(out,'roll-multiple.png'),fullPage:true});
      await page.getByLabel('Roll preview view',{exact:true}).selectOption('1');
      await page.waitForFunction(()=>Array.from(document.querySelectorAll('.client-meter-marker')).some(m=>m.textContent==='Meter 3')&&!document.querySelector('.client-preview[hidden]'));
      const canvas=await page.locator('.client-preview canvas').evaluate(c=>[c.width,c.height]);
      assert(canvas[0]<=1000&&canvas[1]<=1600,'roll preview always bounded');
      await page.setViewportSize({width:390,height:700});
      await page.screenshot({path:path.join(out,'roll-mobile.png'),fullPage:true});
      await page.getByRole('button',{name:'Confirm & Send to Shop',exact:true}).click();
      await page.getByRole('heading',{name:'Gang sheet submitted',exact:true}).waitFor();
      assert.deepEqual(errors,[]);

      const owner=await browser.newPage({viewport:{width:1280,height:950}});
      const user=f.users.basic;
      const jwt=`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),role:'authenticated'})).toString('base64url')}.test-signature`;
      await owner.addInitScript(({user,jwt})=>localStorage.setItem('smart-sheet-builder-v53b-session',JSON.stringify({accessToken:jwt,refreshToken:'fixture-refresh',user})),{user,jwt});
      await owner.route('**/auth/v1/**',r=>r.fulfill({json:r.request().url().includes('/token')?{access_token:jwt,refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user}:user}));
      await owner.route('**/api/**',async route=>{
        const rr=route.request(),url=new URL(rr.url()),headers={...rr.headers(),authorization:'Bearer basic'};
        const req=new NextRequest(rr.url(),{method:rr.method(),headers,...(rr.method()==='POST'?{body:rr.postDataBuffer()}:{})});
        let response;
        const file=url.pathname.match(/^\/api\/client-jobs\/([^/]+)\/files\/([^/]+)$/);
        if(file)response=await f.files.GET(req,{params:{id:file[1],file:file[2]}});
        else if(url.pathname==='/api/client-jobs')response=await f.owner[rr.method()](req);
        else if(url.pathname==='/api/auth/me')response=await f.me.GET(req);
        else if(url.pathname==='/api/export/status')response=await f.status.GET(req);
        else response=Response.json({history:[],profile:{},credits:{balance:2}});
        await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
      });
      await owner.goto(`${base}/?clientJob=${draft.job.id}`);
      await owner.getByRole('dialog',{name:'Client Portal',exact:true}).waitFor();
      await owner.getByRole('region',{name:'Roll usage estimate',exact:true}).waitFor();
      await owner.getByRole('button',{name:'Shop portal settings',exact:true}).click();
      await owner.locator('.client-profile-row').filter({has:owner.getByRole('heading',{name:'Legacy / Default Profile',exact:true})}).getByRole('button',{name:'Edit',exact:true}).click();
      assert.equal(await owner.getByLabel('Media mode',{exact:true}).inputValue(),'continuous');
      assert.equal(await owner.getByLabel('Printable roll width (in)',{exact:true}).inputValue(),'23');
      assert.equal(await owner.getByLabel('Lead allowance (in)',{exact:true}).inputValue(),'0.5');
      assert.equal(await owner.getByLabel('Trail allowance (in)',{exact:true}).inputValue(),'0.5');
      await owner.screenshot({path:path.join(out,'roll-profile-settings.png'),fullPage:true});
      await owner.getByLabel('Media mode',{exact:true}).selectOption('fixed');
      assert.equal(await owner.getByLabel('Sheet length (in)',{exact:true}).inputValue(),'39');
      await owner.getByRole('button',{name:'Save portal settings',exact:true}).click();
      await owner.getByText('Profile and settings saved.',{exact:true}).first().waitFor();
      const savedProfile=await f.lib.jobs('info',{p_link:f.lib.hash(token)});
      assert.equal(savedProfile.settings.mediaMode,'fixed');
      assert.equal(savedProfile.settings.widthIn,23);
      assert.deepEqual((await f.one('select manifest from client_jobs where id=$1',[draft.job.id])).manifest,saved,'owner mode changes never rewrite confirmed roll');
    }
    await f.q("update client_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[draft.job.id]);
    assert.equal((await f.owner.GET(f.req(`/?id=${draft.job.id}`,undefined,'basic'))).status,410);
    assert.equal((await f.files.GET(f.req('/',undefined,'basic'),{params:{id:draft.job.id,file:id}})).status,410);
    for(const file of ['public/builder.html','public/sheet-packing.js'])assert.equal(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n'),execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8'}).replaceAll('\r\n','\n'),'main builder and export implementation unchanged');
    console.log(`PASS: fixed/legacy manifests identical; four configured machine widths; one roll/no scaling; 23 in / 22 usable; fixture 6900 x 11868 px, 39.56 in = 1.004824 m; width/rotation, allowance/gaps, immutable sources/snapshots, confirmation/email/expiry, bounded meter-marker preview. Screenshots: ${out}`);
  } finally {await browser?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
