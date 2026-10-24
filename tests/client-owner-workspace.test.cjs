const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto'),{execFileSync}=require('node:child_process');
const {chromium}=require('playwright'),{NextRequest}=require('next/server');
const {fixture,png}=require('./client-jobs.test.cjs');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'owner-workspace-'));
const base=process.env.SMART_SHEET_TEST_URL||'http://localhost:3114';
(async()=>{
  const f=await fixture();let browser;
  try{
    const config={...f.lib.defaults,shopName:'Owner workspace test shop',email:'shop@example.test',mediaMode:'continuous',leadIn:.5,trailIn:.5};
    const token=await f.portal('basic',config);
    async function job(name,qty,settings=config){
      const confirmed=await f.confirmed(token,1,png(180,320));
      const old=await f.lib.jobs('get',{p_owner:f.users.basic.id,p_job:confirmed.job.id});
      const assets=old.assets.map(a=>({...a,qty,widthIn:settings.mediaMode==='fixed'?5:21.7,heightIn:settings.mediaMode==='fixed'?8:38.56}));
      const manifest=f.lib.layout(assets,settings);
      await f.q('update client_jobs set reference=$2,assets=$3,manifest=$4,quantity=$5,meters=$6 where id=$1',[old.id,name,JSON.stringify(assets),JSON.stringify(manifest),qty,manifest.meters]);
      return {...old,reference:name,assets,manifest,quantity:qty,meters:manifest.meters};
    }
    const short=await job('Boracay — one meter',1),long=await job('Long roll — four copies',4),fixed=await job('Fixed sheet order',2,{...config,mediaMode:'fixed'});
    assert.equal(short.manifest.meters,1.004824);assert.deepEqual([short.manifest.sheets[0].widthPx,short.manifest.sheets[0].heightPx],[6900,11868]);
    for(let i=0;i<22;i++)await f.q('insert into client_jobs select (jsonb_populate_record(null::client_jobs,to_jsonb(j)||$2::jsonb)).* from client_jobs j where id=$1',[short.id,JSON.stringify({id:randomUUID(),reference:`Client project ${String(i+1).padStart(2,'0')}`})]);
    const snapshots=await f.one('select jsonb_agg(to_jsonb(j) order by id) data from client_jobs j');
    browser=await chromium.launch({channel:'chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:950}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const user=f.users.basic,jwt=`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,iat:Math.floor(Date.now()/1000),role:'authenticated'})).toString('base64url')}.test-signature`;
    await page.addInitScript(({user,jwt})=>{
      localStorage.setItem('smart-sheet-builder-v53b-session',JSON.stringify({accessToken:jwt,refreshToken:'fixture-refresh',user}));
      const make=window.createImageBitmap;window.previewDecodes=0;window.createImageBitmap=(...args)=>{previewDecodes++;return make(...args);};
    },{user,jwt});
    await page.route('**/auth/v1/**',r=>r.fulfill({json:r.request().url().includes('/token')?{access_token:jwt,refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user}:user}));
    let onlyOne=true;
    await page.route('**/api/**',async route=>{
      const r=route.request(),url=new URL(r.url()),req=new NextRequest(r.url(),{method:r.method(),headers:{...r.headers(),authorization:'Bearer basic'},...(r.method()==='POST'?{body:r.postDataBuffer()}:{})});
      let response;const file=url.pathname.match(/^\/api\/client-jobs\/([^/]+)\/files\/([^/]+)$/);
      if(file)response=await f.files.GET(req,{params:{id:file[1],file:file[2]}});
      else if(url.pathname==='/api/client-jobs'){
        response=await f.owner[r.method()](req);
        if(!url.searchParams.has('id')&&onlyOne){const data=await response.json();response=Response.json({...data,jobs:data.jobs.filter(j=>j.id===short.id)});}
      }
      else if(url.pathname==='/api/auth/me')response=await f.me.GET(req);
      else if(url.pathname==='/api/export/status')response=await f.status.GET(req);
      else if(url.pathname==='/api/export/consume')response=await f.consume.POST(req);
      else response=Response.json({history:[],profile:{}});
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    await page.goto(base);
    const bodyBefore=await page.evaluate(()=>[document.body.style.overflow,document.documentElement.style.overflow]);
    await page.getByRole('button',{name:'Show account and export access',exact:true}).click();
    await page.getByRole('button',{name:/^Client Portal/}).click();
    const modal=page.locator('.client-owner-dialog'),list=page.locator('.client-submission-list'),stage=page.getByRole('region',{name:'Print layout preview stage'});
    await page.getByText('Select a submission to review its print layout.',{exact:true}).waitFor();
    assert.equal(await page.locator('.client-submission-row').count(),1);
    assert.deepEqual(await page.evaluate(()=>[document.body.style.overflow,document.documentElement.style.overflow]),['hidden','hidden']);
    async function ready(name){
      await page.getByRole('heading',{name,exact:true}).last().waitFor();
      await page.waitForFunction(()=>document.querySelector('.client-detail-panel .client-preview canvas')&&!document.querySelector('.client-detail-panel .client-preview[hidden]'));
      await page.waitForFunction(()=>document.querySelector('.owner-preview-stage')?.clientHeight>20);
    }
    async function visibleExports(){
      for(const name of ['Download layout PNG','Convert layout to TIFF']){
        const b=await page.getByRole('button',{name,exact:true}).boundingBox();
        const panel=await page.locator('.client-detail-panel').boundingBox();
        assert(b&&b.y>=panel.y&&b.y+b.height<=panel.y+panel.height+1,`${name} remains inside the visible workspace`);
      }
    }
    async function fits(){
      const r=await stage.evaluate(el=>{const c=el.querySelector('canvas').getBoundingClientRect(),v=el.getBoundingClientRect();return {c:{top:c.top,bottom:c.bottom,left:c.left,right:c.right},v:{top:v.top,bottom:v.bottom,left:v.left,right:v.right},scroll:el.scrollHeight,height:el.clientHeight};});
      assert(r.c.top>=r.v.top&&r.c.bottom<=r.v.bottom+1&&r.c.left>=r.v.left&&r.c.right<=r.v.right+1,'Fit displays the complete roll/sheet');
      assert(r.scroll<=r.height+1,'Fit does not create a tall scrolling preview');
    }
    await page.locator('.client-submission-row').first().click();await ready(short.reference);await fits();await visibleExports();
    const left=await page.locator('.client-owner-submissions').boundingBox(),right=await page.locator('.client-detail-panel').boundingBox();
    assert(left.width>=320&&left.width<=380&&right.x>left.x+left.width,'desktop uses the required two panes');
    assert.equal(await modal.evaluate(el=>el.scrollTop),0);
    assert.equal(await page.locator('.client-submission-row.selected').count(),1);
    const beforeZoom=await page.evaluate(()=>previewDecodes);
    await page.getByRole('button',{name:'200%',exact:true}).click();
    const viewport=await stage.boundingBox();
    await page.mouse.move(viewport.x+viewport.width*.7,viewport.y+viewport.height*.7);await page.mouse.down();await page.mouse.move(viewport.x+viewport.width*.3,viewport.y+viewport.height*.3,{steps:5});await page.mouse.up();
    assert(await stage.evaluate(el=>el.scrollTop>0),'zoomed canvas supports pointer panning');
    await visibleExports();assert.equal(await page.evaluate(()=>previewDecodes),beforeZoom,'zoom/pan do not decode or regenerate artwork');
    await page.getByRole('button',{name:'100%',exact:true}).click();await visibleExports();
    await page.getByRole('button',{name:'Fit',exact:true}).click();await fits();
    await page.screenshot({path:path.join(out,'one-submission-desktop.png')});
    await page.getByRole('button',{name:'Close Client Portal',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>[document.body.style.overflow,document.documentElement.style.overflow]),bodyBefore);
    onlyOne=false;
    await page.goto(`${base}/?clientJob=${short.id}`);await ready(short.reference);
    assert.equal(await page.locator('.client-submission-row').count(),25);
    assert(await list.evaluate(el=>el.scrollHeight>el.clientHeight),'many submissions scroll independently');
    async function select(name){
      const row=page.locator('.client-submission-row').filter({has:page.getByRole('heading',{name,exact:true})});
      const position=await modal.evaluate(el=>el.scrollTop);
      await row.getByRole('button',{name:'View details',exact:true}).click();await ready(name);await fits();await visibleExports();
      assert.equal(await modal.evaluate(el=>el.scrollTop),position,'switching jobs does not scroll the modal');
      assert(await row.evaluate(el=>el.classList.contains('selected')));
    }
    await select(long.reference);
    assert.equal(await page.locator('.client-detail-panel .client-meter-marker').count(),Math.floor(long.manifest.meters),'Fit includes every meter marker across the complete long roll');
    assert.equal(await page.getByLabel('Roll preview view',{exact:true}).count(),0,'owner Fit is the entire roll, not a meter-window selector');
    await page.screenshot({path:path.join(out,'many-submissions-long-roll.png')});
    await select(fixed.reference);assert.equal(await page.getByLabel('Sheet summary').count(),1);assert.equal(await page.getByLabel('Export sheet',{exact:true}).count(),1);
    await page.screenshot({path:path.join(out,'fixed-sheet-desktop.png')});
    await select(short.reference);
    for(const [width,height] of [[1024,650],[390,760],[375,667]]){
      await page.setViewportSize({width,height});await fits();await visibleExports();
      const overflow=await modal.evaluate(el=>[el.scrollWidth,el.clientWidth,el.scrollHeight,el.clientHeight]);
      assert(overflow[0]<=overflow[1]+1&&overflow[2]<=overflow[3]+1,`modal fits ${width}×${height} without overflow: ${overflow}`);
      assert.equal(await modal.evaluate(el=>el.scrollTop),0);
      await page.screenshot({path:path.join(out,`workspace-${width}x${height}.png`)});
    }
    await page.setViewportSize({width:1440,height:950});
    await page.getByRole('button',{name:'Shop portal settings',exact:true}).click();
    await page.getByRole('heading',{name:'Shop portal settings',exact:true}).waitFor();
    assert(await page.locator('.client-owner-grid').isHidden());
    await page.getByRole('button',{name:'Done',exact:true}).click();await fits();await visibleExports();
    assert.deepEqual((await f.one('select jsonb_agg(to_jsonb(j) order by id) data from client_jobs j')).data,snapshots.data,'all job dimensions, original sources, estimates, storage and expiry snapshots are unchanged');
    // Exact expiry still clears selected native sources/previews and disables its card.
    const oldCountdown=await page.locator('.client-owner-detail-meta time').innerText();await page.waitForTimeout(1100);assert.notEqual(await page.locator('.client-owner-detail-meta time').innerText(),oldCountdown);
    await f.q("update client_jobs set expires_at=clock_timestamp()-interval '1 second' where id=$1",[short.id]);
    assert.equal((await f.files.GET(f.req('/',undefined,'basic'),{params:{id:short.id,file:short.assets[0].id}})).status,410);
    for(const file of ['public/builder.html','public/client-roll-export.js','public/sheet-packing.js','app/lib/client-roll-layout.js','app/api/_lib/roll-strip-renderer.js','app/api/client-upload/[token]/route.js','app/client-upload/[token]/page.jsx'])assert.equal(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n'),execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8'}).replaceAll('\r\n','\n'),`${file} unchanged`);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({PASS:['one submission/empty state','25 independently scrollable submissions','selected-card and View details actions/no modal jump','1.004824 m fixture unchanged','complete multi-meter Fit/meter markers','fixed-sheet display','Fit/100%/200% + pan without image decoding','visible PNG/TIFF controls at every zoom','desktop/tablet/mobile/no overflow','settings gear/Done/Close and body scroll restoration','countdown/private expiry checks','immutable stored jobs/manifests/sources','Main Builder/upload/export functions unchanged'],artifacts:out},null,2));
  }finally{await browser?.close();await f.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
