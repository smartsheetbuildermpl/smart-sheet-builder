const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {execFileSync}=require('node:child_process'),{chromium}=require('playwright'),{PNG}=require('pngjs');
const source=fs.readFileSync('public/builder.html','utf8');
const sandbox={window:{}};
vm.runInNewContext(source.slice(source.indexOf('// Read-only metadata/geometry analysis.'),source.indexOf('</script>',source.indexOf('// Read-only metadata/geometry analysis.'))),sandbox);
const analyze=sandbox.window.SmartSheetPreflight.analyze;
function data(){return {machine:'DTF',dpi:300,edgePx:30,sheet:{widthPx:1800,heightPx:2400,placements:[{x:90,y:150,w:1500,h:750,inst:{designId:1,canvas:{width:1500,height:750},baseW:1500,baseH:750,rotation:0}}]},sourceInfo:()=>({name:'Design.png'})};}
let input=data(),before=JSON.stringify(input),r=analyze(input);
assert.equal(r.state,'ready');assert.equal(r.details[0].ppi,300);assert.equal(JSON.stringify(input),before,'analysis does not mutate inputs');
input=data();input.sheet.placements[0].inst.baseW=2250;r=analyze(input);assert.equal(r.state,'review');assert.equal(r.details[0].ppi,200);assert(!r.blocking);
input.sheet.placements[0].inst.baseW=3000;r=analyze(input);assert.equal(r.details[0].ppi,150);assert(r.issues.some(i=>i.message.includes('below 200')));
input=data();input.sheet.placements[0].x=0;r=analyze(input);assert.equal(r.state,'ready');assert.equal(r.issues[0].level,'info');assert(!r.blocking);
input=data();input.sheet.placements[0].x=-1;r=analyze(input);assert.equal(r.state,'attention');assert(!r.blocking,'clipping is reviewable, not an impossible export');
input=data();input.sheet.placements.push({...input.sheet.placements[0]});r=analyze(input);assert.equal(r.state,'attention');assert(r.issues.some(i=>i.message.includes('overlapping')));assert.equal(r.usage,1500*750/(1800*2400)*100,'usage uses union, not sum of overlapping rectangles');
input=data();input.processing=['An image is still processing.'];assert.equal(analyze(input).state,'attention');input.processing=['An upload failed.'];assert.equal(analyze(input).state,'attention');
input=data();input.workspace={placed:1,total:2};assert.equal(analyze(input).state,'review');assert(analyze(input).issues.some(i=>i.message.includes('remain unplaced')));
input=data();input.sheet.placements[0].inst.canvas=null;assert(analyze(input).blocking);
input=data();input.sourceInfo=()=>({isPreview:true});assert(analyze(input).blocking,'a proxy is not an export source');
input=data();input.sheet.widthPx=0;assert(analyze(input).blocking);
input=data();input.sourceInfo=()=>({nativeScale:2});assert.equal(analyze(input).details[0].ppi,150,'smooth enhancement does not invent source detail');
input=data();input.sheet.placements[0].inst.rotation=90;input.sheet.placements[0].w=750;input.sheet.placements[0].h=1500;assert.equal(analyze(input).details[0].ppi,300,'rotated source uses unrotated print dimensions');

// Freeze only the fixture's TIFF timestamp so complete-file parity is measurable.
const hook=`tiffDate=function(){return '2026:10:22 08:00:00';};window.preflightQA={
  report:typeof printReadinessReport==='function'?printReadinessReport:null,
  seed:function(state){
    dpiInput.value=300;setSheetSize(6,8);getSheetPixelSettings();edgeAllowanceNumber.value='.1';customerNameInput.value='';
    var c=document.createElement('canvas');c.width=state==='review'?900:1800;c.height=state==='review'?450:900;var ctx=c.getContext('2d');
    ctx.fillStyle='rgba(18,92,166,.75)';ctx.fillRect(20,20,1760,860);ctx.fillStyle='#f89435';ctx.fillRect(600,100,100,600);
    designs=[{id:1,file:{name:'Production artwork.png'},originalCanvas:c,trimmed:{canvas:c,w:c.width,h:c.height},widthIn:5,heightIn:2.5,qty:1,vibrance:0,nativeScale:1,autoTrimApplied:false,previewUrl:thumbnailUrl(c)}];
    instances=[{id:1,designId:1,canvas:c,baseW:1500,baseH:750,rotation:0,vibrance:0}];
    var p={x:90,y:150,w:1500,h:750,inst:instances[0]};
    if(state==='edge')p.x=0;
    if(state==='attention')p.x=-30;
    sheets=[{widthPx:1800,heightPx:2400,autoEdgeAllowancePx:30,headerHeightPx:0,placements:[p]}];
    renderAllDesigns();renderAllSheets();computeStats();window.saved=null;window.allowed=true;window.gates=[];
  },
  export:function(kind){return kind==='png'?downloadPng(sheets[0],0):downloadTiff(sheets[0],0,getExportProfile(kind));},
  savedInfo:async function(){var bytes=await saved.arrayBuffer();return {sha:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).join(','),bytes:bytes.byteLength,head:Array.from(new Uint8Array(bytes,0,Math.min(bytes.byteLength,65536)))};},
  production:function(){return downloadTiff(sheets[0],0);},
  currentReport:function(){return printReadinessReport(sheets[0]);},
  signature:function(){return JSON.stringify({geometry:sheets.map(s=>[s.widthPx,s.heightPx,s.placements.map(p=>[p.x,p.y,p.w,p.h,p.inst.rotation,p.inst.canvas.width,p.inst.canvas.height])]),settings:captureLayoutSettings(),history:layoutHistory.capture()});},
  missing:function(){sheets[0].placements[0].inst.canvas=null;},
  pending:function(){uploadPreflightStatus.pending=1;},
  failure:function(){uploadPreflightStatus.pending=0;uploadPreflightStatus.failed=1;},
  overlap:function(){sheets[0].placements.push({...sheets[0].placements[0],inst:{...instances[0],id:2}});renderAllSheets();}
};exportDelivery=SmartSheetExportDelivery.create({gate:async function(kind,operation){gates.push(operation.action);return {allowed:allowed,authorization:allowed?'fixture-only':null};},save:async function(blob){window.saved=blob;return true;}});`;
function instrument(text){return text.replace(/\}\)\(\);\s*<\/script>/,hook+'})();</script>');}
function tags(bytes){const t={};let at=bytes.readUInt32LE(4);for(let i=0;i<bytes.readUInt16LE(at);i++){const p=at+2+i*12,tag=bytes.readUInt16LE(p),type=bytes.readUInt16LE(p+2),count=bytes.readUInt32LE(p+4),val=bytes.readUInt32LE(p+8);if(count===1)t[tag]=type===5?bytes.readUInt32LE(val)/bytes.readUInt32LE(val+4):type===3?bytes.readUInt16LE(p+8):val;}return t;}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true}),output=fs.mkdtempSync(path.join(os.tmpdir(),'print-preflight-'));
  try {
    const errors=[],page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.setDefaultTimeout(15000);
    page.on('pageerror',e=>errors.push(e.message));
    // Frozen, previously deployed baseline; identical fixture + real encoders.
    const baseline=execFileSync('git',['show','8000b97:public/builder.html'],{encoding:'utf8',maxBuffer:4*1024*1024});
    await page.route('http://localhost:4237/**',route=>{
      const p=new URL(route.request().url()).pathname;
      if(p==='/'||p==='/baseline')return route.fulfill({body:instrument(p==='/baseline'?baseline:source),contentType:'text/html'});
      return route.fulfill({body:fs.readFileSync('public'+p),contentType:p.endsWith('.js')?'text/javascript':'text/css'});
    });
    await page.goto('http://localhost:4237/');
    console.log('Preflight browser loaded');
    const seed=state=>page.evaluate(state=>preflightQA.seed(state),state);
    async function begin(kind){await page.evaluate(kind=>{window.attempt=preflightQA.export(kind);},kind);await page.locator('#printPreflight[open]').waitFor();}
    for(const [state,label] of [['ready','Ready to export'],['review','Review recommended'],['attention','Needs attention']]){
      console.log('Checking '+state);
      await seed(state);const sig=await page.evaluate(()=>preflightQA.signature());
      await begin('png');assert.equal(await page.evaluate(()=>gates.join(',')),'prepare','access gate precedes preflight');assert.equal(await page.evaluate(()=>saved),null);
      await page.locator('#printPreflight').getByText(label,{exact:true}).waitFor();
      await page.locator('#printPreflight details summary').click();
      await page.screenshot({path:path.join(output,state+'.png')});
      assert.equal(await page.evaluate(()=>preflightQA.signature()),sig,'review leaves layout/settings/history/pixel references unchanged');
      await page.getByRole('button',{name:'Back to layout',exact:true}).click();await page.evaluate(()=>attempt);assert.equal(await page.evaluate(()=>saved),null);
    }
    console.log('Checking edge and cancellation');
    await seed('edge');await begin('png');assert.match(await page.locator('#printPreflight').innerText(),/Manual edge placement is allowed/);assert(await page.getByRole('button',{name:'Continue export',exact:true}).isEnabled());await page.keyboard.press('Escape');await page.evaluate(()=>attempt);
    await seed('ready');await page.evaluate(()=>preflightQA.overlap());assert.equal(await page.evaluate(()=>preflightQA.currentReport().state),'attention');
    console.log('Checking processing and missing sources');
    await seed('ready');await page.evaluate(()=>preflightQA.pending());await begin('png');assert.match(await page.locator('#printPreflight').innerText(),/still being prepared/);await page.keyboard.press('Escape');await page.evaluate(()=>attempt);
    await page.evaluate(()=>preflightQA.failure());await begin('png');assert.match(await page.locator('#printPreflight').innerText(),/failed to load/);await page.keyboard.press('Escape');await page.evaluate(()=>attempt);
    await seed('ready');await page.evaluate(()=>preflightQA.missing());await begin('png');assert(await page.getByRole('button',{name:'Continue export',exact:true}).isDisabled());await page.keyboard.press('Escape');await page.evaluate(()=>attempt);
    console.log('Checking denied access');
    await seed('ready');await page.evaluate(()=>{window.allowed=false;});await page.evaluate(()=>preflightQA.export('png'));assert.equal(await page.locator('#printPreflight').count(),0);assert.equal(await page.evaluate(()=>saved),null);
    // Production TIFF color selection still follows the new preflight step.
    console.log('Checking production flow');
    await seed('ready');await page.evaluate(()=>{window.attempt=preflightQA.production();});await page.locator('#printPreflight[open]').waitFor();await page.getByRole('button',{name:'Continue export',exact:true}).click();await page.locator('#dtfCheckOverlay').waitFor({state:'visible'});await page.locator('#dtfCheckCancel').click();await page.evaluate(()=>attempt);
    const results={};
    for(const kind of ['png','rgb','cmyk']){
      console.log('Comparing '+kind+' with baseline');
      await page.goto('http://localhost:4237/baseline');await seed('ready');await page.evaluate(kind=>preflightQA.export(kind),kind);const expected=await page.evaluate(()=>preflightQA.savedInfo());assert(expected.bytes);
      await page.goto('http://localhost:4237/');await seed('ready');await begin(kind);await page.getByRole('button',{name:'Continue export',exact:true}).click();await page.evaluate(()=>attempt);
      const info=await page.evaluate(()=>preflightQA.savedInfo());assert.equal(info.sha,expected.sha,kind+': entire encoded file SHA-256 is identical to deployed baseline');assert.equal(info.bytes,expected.bytes);const actual=Buffer.from(kind==='png'?await page.evaluate(async()=>Array.from(new Uint8Array(await saved.arrayBuffer()))):info.head);
      if(kind==='png'){
        const png=PNG.sync.read(actual);assert.deepEqual([png.width,png.height],[1800,2400]);assert(png.data.some((v,i)=>i%4===3&&v>0&&v<255));assert.equal(png.data[3],0);
        let at=8;while(at<actual.length){const n=actual.readUInt32BE(at);if(actual.toString('ascii',at+4,at+8)==='pHYs')assert.deepEqual([actual.readUInt32BE(at+8),actual.readUInt32BE(at+12),actual[at+16]],[11811,11811,1]);at+=n+12;}
      }else {const t=tags(actual);assert.deepEqual([t[256],t[257],t[282],t[283]],[1800,2400,300,300]);}
      results[kind]={pixels:[1800,2400],inches:[6,8],ppi:300,byteIdentical:true,bytes:info.bytes};
    }
    // Short/mobile modal stays scrollable with reachable actions and no overflow.
    await page.setViewportSize({width:390,height:500});await seed('review');await begin('png');await page.locator('#printPreflight details summary').click();await page.getByRole('button',{name:'Continue export',exact:true}).scrollIntoViewIfNeeded();
    assert(await page.getByRole('button',{name:'Continue export',exact:true}).isVisible());assert(await page.evaluate(()=>{const d=document.querySelector('#printPreflight');return d.scrollWidth<=d.clientWidth+1&&d.getBoundingClientRect().width<=innerWidth;}));
    await page.screenshot({path:path.join(output,'mobile.png')});await page.keyboard.press('Escape');await page.evaluate(()=>attempt);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({unitChecks:'PASS: thresholds, edge info, bounds, overlap/union usage, pending/failed, missing/proxy source, invalid geometry, nativeScale, rotation, immutable inputs',browser:'PASS: guard ordering, read-only review, cancellation, production dialog, disabled impossible export, mobile scroll',exports:results,evidence:output},null,2));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
