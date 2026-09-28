const {chromium}=require('playwright'), assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const base=process.env.SMART_SHEET_TEST_URL||'http://localhost:3108', output=fs.mkdtempSync(path.join(os.tmpdir(),'ssb-credits-'));
const hook=`window.creditTest={seed:function(){var c=document.createElement('canvas');c.width=8;c.height=8;c.getContext('2d').fillRect(2,2,4,4);window.creditSheet={renderCanvas:c,widthPx:8,heightPx:8,placements:[],headerHeightPx:0,exportUi:{progress:document.createElement('p')}};sheets=[creditSheet];},png:function(){return downloadPng(creditSheet,0)},tiff:function(){return downloadTiff(creditSheet,0,getExportProfile('rgb'))},change:function(){creditSheet.renderCanvas._ssbExportRecipe=[crypto.randomUUID()]},failEncode:function(){creditSheet.renderCanvas.toBlob=function(cb){cb(null)}}};
var realSave=saveExportBlob;exportDelivery=SmartSheetExportDelivery.create({gate:requestExportAccess,save:function(){if(window.diskFailure)throw new Error('Disk full');return realSave.apply(null,arguments)}});`;
const html=fs.readFileSync('public/builder.html','utf8').replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],requests=[], receipts=new Map();
    page.on('pageerror',e=>errors.push(e.message));
    let balance=2, serverEpoch=Date.parse('2026-09-26T12:00:00Z'), due=serverEpoch+10800000, refill=false, refundOffline=false;
    const usage=()=>({signedIn:true,email:'standard@test.example',label:'Free account',creditMode:true,remaining:balance,limit:2,used:120,unlimited:false,isSuperAdmin:false,canManageLibrary:false,serverTime:new Date(serverEpoch).toISOString(),nextCreditAt:balance<2?new Date(due).toISOString():null});
    await page.addInitScript(()=>{localStorage.setItem('smart-sheet-builder-v53b-session',JSON.stringify({accessToken:'standard',user:{email:'standard@test.example'}}));Date.now=()=>Date.parse('2099-01-01');});
    await page.route('**/builder.html',r=>r.fulfill({body:html,contentType:'text/html'}));
    await page.route('**/api/**',async r=>{
      const req=r.request(),u=new URL(req.url()),body=req.postDataJSON();requests.push({path:u.pathname,body});
      if(u.pathname==='/api/export/consume'){
        if(body.action==='prepare')return r.fulfill({json:balance?{allowed:true,authorization:'mock-signed-authorization',usage:usage()}:{allowed:false,reason:'credits_empty',message:'You’ve used your available free export credits.',usage:usage()}});
        let receipt=receipts.get(body.requestKey);
        if(body.action==='refund'){if(refundOffline)return r.fulfill({status:503,json:{message:'Temporarily unavailable'}});if(receipt&&!receipt.refunded){balance++;receipt.refunded=true;}return r.fulfill({json:{allowed:true,usage:usage()}});}
        if(body.action==='saved')return r.fulfill({json:{allowed:true,usage:usage()}});
        if(receipt)return r.fulfill({json:{allowed:true,receipt:receipt.id,duplicate:true,usage:usage()}});
        if(!balance)return r.fulfill({json:{allowed:false,reason:'credits_empty',message:'You’ve used your available free export credits.',usage:usage()}});
        balance--;receipt={id:require('node:crypto').randomUUID()};receipts.set(body.requestKey,receipt);
        return r.fulfill({json:{allowed:true,receipt:receipt.id,usage:usage()}});
      }
      if(u.pathname==='/api/export/status'&&refill){balance=1;serverEpoch=due;due=serverEpoch+10800000;refill=false;}
      if(u.pathname==='/api/auth/profile')return r.fulfill({json:{profile:{full_name:'Standard user'}}});
      if(u.pathname==='/api/export/credits')return r.fulfill({json:{credits:{balance},history:[]}});
      return r.fulfill({json:{configured:true,usage:usage()}});
    });
    await page.goto(base); await page.locator('.usage-card').getByText('Free Export Credits: 2 / 2',{exact:true}).waitFor();
    await page.locator('.access-reveal-handle').hover();await page.getByRole('button',{name:'Account & exports',exact:true}).click();
    assert(await page.locator('.access-modal').getByRole('button',{name:'Buy Export Credits — Coming Soon'}).isDisabled());
    await page.getByRole('button',{name:'Close account'}).click();
    const frame=page.frames().find(f=>f.url().includes('/builder.html'));await frame.evaluate(()=>creditTest.seed());
    assert.equal(requests.filter(r=>r.path.includes('/consume')).length,0,'preview/upload/render never consumes');
    let download=page.waitForEvent('download');await frame.evaluate(()=>creditTest.png());await download;
    assert.equal(balance,1);
    download=page.waitForEvent('download');await frame.evaluate(()=>creditTest.tiff());await download;assert.equal(balance,0,'TIFF is a distinct output');
    await frame.evaluate(()=>{creditTest.change();return creditTest.png()});
    await page.getByRole('button',{name:'Wait for free credit'}).waitFor();
    assert.match(await page.locator('.access-modal-card').innerText(),/3h 0m/,'countdown uses server epoch, despite browser date 2099');
    await page.setViewportSize({width:375,height:812});
    assert(await page.locator('.access-modal-card').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await page.screenshot({path:path.join(output,'zero-credits-mobile.png')});
    assert(await page.locator('.access-modal').getByRole('button',{name:'Buy Export Credits — Coming Soon'}).isDisabled());
    await page.getByRole('button',{name:'Wait for free credit'}).click();assert.equal(await page.locator('.access-modal').count(),0);
    // Server changes the next-refill deadline; reaching zero refreshes the server,
    // never grants a balance optimistically from browser time.
    due=serverEpoch+2000;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelector('.usage-card').textContent.includes('0h 0m'));
    refill=true;await page.locator('.usage-card').getByText('Free Export Credits: 1 / 2',{exact:true}).waitFor({timeout:10000});
    balance=2;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.locator('.usage-card').getByText('Free Export Credits: 2 / 2',{exact:true}).waitFor();
    await frame.evaluate(()=>{creditTest.change();window.diskFailure=true;return creditTest.png()});assert.equal(balance,2,'disk write failure refunds credit');assert.equal(requests.at(-1).body.action,'refund');
    refundOffline=true;
    await frame.evaluate(()=>{creditTest.change();return creditTest.png()});assert.equal(balance,1);
    assert(await page.evaluate(()=>JSON.parse(localStorage.getItem('ssb-export-delivery-outbox-v1')).some(i=>i.operation.action==='refund')),'interrupted refund is durably queued without storing a token');
    refundOffline=false;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.locator('.usage-card').getByText('Free Export Credits: 2 / 2',{exact:true}).waitFor();
    assert.equal(balance,2);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('ssb-export-delivery-outbox-v1')).length),0);
    const count=requests.filter(r=>r.body?.action==='consume').length;
    await frame.evaluate(()=>{window.diskFailure=false;creditTest.failEncode();return creditTest.png()});assert.equal(requests.filter(r=>r.body?.action==='consume').length,count,'encoding failure never consumes a credit');
    assert(!requests.some(r=>/checkout|purchase|payment/.test(r.path)));assert.deepEqual(errors,[]);
    console.log(`PASS: real PNG/TIFF delivery integration, unchanged retry, zero-credit modal, server-time live countdown/refill despite wrong browser clock, coming-soon inert, native save failure refund, offline refund queued/retried, encoding failure no debit, mobile. Screenshots: ${output}`);
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
