const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

const source = fs.readFileSync('public/builder.html', 'utf8');
const hook = "window.incrementalTest={get designs(){return designs},get instances(){return instances},get sheets(){return sheets},add:appendDesignToCurrentLayout,settings:getSheetPixelSettings,plan:planIncrementalBatch,pack:packIncrementalBatch,setState:function(next){designs=next.designs;instances=next.instances;sheets=next.sheets;manualMode=!!next.manualMode;instanceIdCounter=100000;},draw:drawSheetCanvas};";
const html = source.replace(/\}\)\(\);\s*<\/script>/, hook + '})();</script>');
assert.notEqual(html, source, 'test hook inserted');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://localhost:4186/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/builder.html') return route.fulfill({ body: html, contentType: 'text/html' });
      if (/^\/(sheet-workspace|background-editor|print-optimizer)\.(js|css)$/.test(pathname)) {
        return route.fulfill({ body: fs.readFileSync('public' + pathname), contentType: pathname.endsWith('.js') ? 'text/javascript' : 'text/css' });
      }
      return route.fulfill({ body: '<iframe src="/builder.html"></iframe>', contentType: 'text/html' });
    });
    await page.goto('http://localhost:4186');
    const frame = page.frameLocator('iframe');
    await frame.locator('#dpi').waitFor();
    const doc = page.frames().find(item => item.url().endsWith('/builder.html'));
    await doc.evaluate(() => {
      document.getElementById('dpi').value = '10';
      document.getElementById('sheetWidth').value = '10';
      document.getElementById('sheetLength').value = '10';
      document.getElementById('gapNumber').value = '0';
      document.getElementById('edgeAllowanceNumber').value = '0.3';
      document.getElementById('autoExtend').checked = true;
      document.getElementById('autoRotate').checked = true;
    });

    const results = await doc.evaluate(() => {
      const t = incrementalTest;
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 12;
      canvas.getContext('2d').fillRect(0, 0, 12, 12);
      function design(id, name, width, height, qty) {
        return { id, file: { name }, trimmed: { canvas, w: width, h: height }, aspect: width / height,
          widthIn: width / 10, heightIn: height / 10, qty, vibrance: 0, lockAspect: true };
      }
      function instance(id, designId, width, height, rotation = 0) {
        return { id, designId, canvas, baseW: width, baseH: height, rotation, vibrance: 0, manualX: 0, manualY: 0 };
      }
      function sheet(placements) {
        return { placements, widthPx: 100, heightPx: 100, headerHeightPx: 4, gapPx: 0, autoEdgeAllowancePx: 3 };
      }
      function check(ok, message) { if (!ok) throw new Error(message); }
      function assertSafe(sheets) {
        for (const s of sheets) for (const p of s.placements) {
          check(p.x >= 0 && p.y >= 0 && p.x + p.w <= s.widthPx && p.y + p.h <= s.heightPx, 'physical sheet boundary violated');
          for (const q of s.placements) if (p !== q) check(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y, 'overlap found');
        }
      }

      // Large manually placed pieces leave a narrow right-hand gap. New small
      // pieces must occupy it without changing either manual placement.
      const large = design(1, 'large.png', 60, 50, 2);
      const small = design(2, 'small.png', 20, 20, 2);
      const first = instance(1, 1, 60, 50), second = instance(2, 1, 60, 40);
      const original = [{ id: first.id, x: 3, y: 4, w: 60, h: 50, rotation: 0 }, { id: second.id, x: 3, y: 54, w: 60, h: 40, rotation: 0 }];
      t.setState({ designs: [large, small], instances: [first, second], sheets: [sheet([
        { inst: first, x: 3, y: 4, w: 60, h: 50 }, { inst: second, x: 3, y: 54, w: 60, h: 40 }
      ])], manualMode: true });
      const smallResult = t.add(small);
      const afterSmall = t.sheets[0].placements;
      check(smallResult.added === 2 && smallResult.createdSheets.length === 0, 'small pieces should use existing gaps before a new sheet');
      check(JSON.stringify(afterSmall.slice(0, 2).map(p => ({ id: p.inst.id, x: p.x, y: p.y, w: p.w, h: p.h, rotation: p.inst.rotation }))) === JSON.stringify(original), 'existing manual placements moved');
      check(afterSmall.slice(2).every(p => p.x >= 63 && p.x + p.w <= 97 && p.y >= 4 && p.y + p.h <= 97), 'small pieces did not fill the usable right-hand gap');
      assertSafe(t.sheets);

      // A larger piece has no valid remaining gap, so only now may another
      // sheet be created. The original first sheet remains byte-for-byte equal.
      const tooLarge = design(3, 'too-large-for-gap.png', 40, 40, 1);
      const stable = JSON.stringify(t.sheets[0].placements.map(p => ({ id: p.inst.id, x: p.x, y: p.y, w: p.w, h: p.h, rotation: p.inst.rotation })));
      t.designs.push(tooLarge);
      const largeResult = t.add(tooLarge);
      check(largeResult.added === 1 && largeResult.createdSheets.length === 1 && t.sheets.length === 2, 'a new sheet was not created only after all existing gaps failed');
      check(JSON.stringify(t.sheets[0].placements.map(p => ({ id: p.inst.id, x: p.x, y: p.y, w: p.w, h: p.h, rotation: p.inst.rotation }))) === stable, 'adding a large piece reflowed Sheet 1');
      assertSafe(t.sheets);

      // Quantity placement crosses sheets while retaining the automatic 0.30in
      // allowance. No piece is moved to make room for a later copy.
      const batch = design(4, 'batch.png', 40, 40, 12);
      t.setState({ designs: [batch], instances: [], sheets: [], manualMode: false });
      const batchResult = t.add(batch);
      check(batchResult.added === 12 && t.sheets.length >= 3, 'multi-sheet quantity was not placed exactly');
      for (const s of t.sheets) for (const p of s.placements) {
        check(p.x >= 3 && p.y >= 4 && p.x + p.w <= 97 && p.y + p.h <= 97, 'automatic edge allowance was not preserved');
      }
      assertSafe(t.sheets);

      // Rotation is attempted for a real remaining gap when auto-rotate is on.
      const blocker = design(5, 'blocker.png', 64, 93, 1);
      const rotated = design(6, 'rotated.png', 45, 25, 1);
      const blockerInst = instance(50, 5, 64, 93);
      t.setState({ designs: [blocker, rotated], instances: [blockerInst], sheets: [sheet([{ inst: blockerInst, x: 3, y: 4, w: 64, h: 93 }])], manualMode: true });
      const rotateResult = t.add(rotated);
      const rotatedPlacement = t.sheets[0].placements.find(p => p.inst.designId === 6);
      check(rotateResult.added === 1 && t.sheets.length === 1 && rotatedPlacement.inst.rotation === 90 && rotatedPlacement.w === 25 && rotatedPlacement.h === 45, 'auto-rotation did not use the remaining gap');
      assertSafe(t.sheets);

      // A deliberately flush manual placement remains legal and unchanged;
      // the new automatic piece stays within the configured automatic inset.
      const manual = design(7, 'manual.png', 20, 20, 1);
      const next = design(8, 'next.png', 10, 10, 1);
      const manualInst = instance(60, 7, 20, 20);
      t.setState({ designs: [manual, next], instances: [manualInst], sheets: [sheet([{ inst: manualInst, x: 0, y: 0, w: 20, h: 20 }])], manualMode: true });
      t.add(next);
      const fixed = t.sheets[0].placements.find(p => p.inst.id === 60);
      const automatic = t.sheets[0].placements.find(p => p.inst.designId === 8);
      check(fixed.x === 0 && fixed.y === 0, 'manual edge placement changed');
      check(automatic.x >= 3 && automatic.y >= 4 && automatic.x + automatic.w <= 97 && automatic.y + automatic.h <= 97, 'automatic placement ignored the edge allowance');
      assertSafe(t.sheets);

      // The current inter-piece setting applies in addition to the automatic
      // inset, including when the existing piece was placed manually.
      document.getElementById('gapNumber').value = '0.2';
      const spaced = design(9, 'spaced.png', 30, 30, 1);
      const addedWithGap = design(10, 'added-with-gap.png', 10, 10, 1);
      const spacedInst = instance(70, 9, 30, 30);
      t.setState({ designs: [spaced, addedWithGap], instances: [spacedInst], sheets: [sheet([{ inst: spacedInst, x: 3, y: 4, w: 30, h: 30 }])], manualMode: true });
      t.add(addedWithGap);
      const gapPlacement = t.sheets[0].placements.find(p => p.inst.designId === 10);
      const gapPx = 2;
      check(gapPlacement.x + gapPlacement.w + gapPx <= 3 || 3 + 30 + gapPx <= gapPlacement.x || gapPlacement.y + gapPlacement.h + gapPx <= 4 || 4 + 30 + gapPx <= gapPlacement.y, 'configured spacing was not preserved around an existing piece');
      assertSafe(t.sheets);

      const output = document.createElement('canvas');
      t.draw(output, t.sheets[0]);
      check(output.width === 100 && output.height === 100, 'incremental layout changed export sheet dimensions');
      return { smallResult, largeResult, batchResult, rotateResult, output: [output.width, output.height] };
    });
    const batchReport = await doc.evaluate(() => {
      const t = incrementalTest;
      for (const [id, value] of Object.entries({ dpi: 100, sheetWidth: 23, sheetLength: 39, gapNumber: 0.1, edgeAllowanceNumber: 0.3 })) document.getElementById(id).value = value;
      const settings = t.settings();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ab1357'; ctx.fillRect(0,0,100,100);
      const print = { id: 2000, file: { name: 'Print.png' }, qty: 200, widthIn: 1, heightIn: 1, trimmed: { canvas, w: 100, h: 100 }, vibrance: 0 };
      const jersey = { ...print, id: 2001, file: { name: 'Jersey.png' }, qty: 40 };
      // 12 rows × 20 slots, with 40 isolated holes among 200 locked Print
      // pieces. A large lower rectangle can hold all 40 Jerseys as one group.
      const locked = [];
      for (let row = 0; row < 12; row++) for (let col = 0; col < 20; col++) {
        if (row < 10 && [2,7,12,17].includes(col)) continue;
        const inst = { id: 1000 + locked.length, designId: print.id, canvas, baseW: 100, baseH: 100,
          rotation: locked.length % 4 * 90, manualX: 30 + col*110, manualY: 36 + row*110, manualSheet: 0, vibrance: 0 };
        locked.push({ inst, x: inst.manualX, y: inst.manualY, w:100, h:100 });
      }
      const s = { placements: locked, widthPx:2300, heightPx:3900, headerHeightPx:36, gapPx:10 };
      t.setState({ designs:[print,jersey], instances:locked.map(p=>p.inst), sheets:[s], manualMode:true });
      const frozen = JSON.stringify(locked), refs = locked.slice();
      const incoming = Array.from({length:40}, (_,i)=>({ id:100000+i, designId:jersey.id, canvas, baseW:100, baseH:100, rotation:0, vibrance:0 }));
      const baseline = t.plan(incoming, settings, 'single');
      const preview = t.pack(incoming, settings);
      if (JSON.stringify(locked)!==frozen || t.sheets[0]!==s || incoming.some(i=>i.rotation!==0)) throw Error('planning mutated live state');
      const result = t.add(jersey);
      if (locked.length!==200 || result.added!==40 || result.skipped || t.sheets.length!==1) throw Error('200+40 quantity/sheet failure');
      if (JSON.stringify(t.sheets[0].placements.slice(0,200))!==frozen || refs.some((p,i)=>t.sheets[0].placements[i]!==p)) throw Error('locked position/rotation/sheet/object changed');
      if (result.footprint >= baseline.footprint * 0.6) throw Error('batch is still scattered like single-copy BSSF');
      if (result.footprint !== preview.footprint) throw Error('non-deterministic plan');
      const added = t.sheets[0].placements.slice(200);
      const packSnapshot = JSON.stringify(added);
      if (added.some(p=>p.inst.canvas!==canvas || p.w!==100 || p.h!==100)) throw Error('trimmed source or physical size changed');
      for (const p of added) {
        if (p.x<30 || p.y<36 || p.x+p.w>2270 || p.y+p.h>3870) throw Error('automatic edge margin');
        for (const q of t.sheets[0].placements) if (p!==q && !(p.x+p.w+10<=q.x || q.x+q.w+10<=p.x || p.y+p.h+10<=q.y || q.y+q.h+10<=p.y)) throw Error('overlap/spacing');
      }
      const gap = result.largestGaps[0];
      const initialFeedback = jersey.layoutFeedback;
      for (const p of t.sheets[0].placements) if (!(gap.x+gap.w+10<=p.x || p.x+p.w+10<=gap.x || gap.y+gap.h+10<=p.y || p.y+p.h+10<=gap.y)) throw Error('reported gap is occupied');
      // Independent exhaustive coordinate-edge search verifies the reported
      // largest free rectangle, including the inset and spacing.
      const blocks = t.sheets[0].placements.map(p=>({x:p.x-10,y:p.y-10,right:p.x+p.w+10,bottom:p.y+p.h+10}));
      const xs = [...new Set([30,2270,...blocks.flatMap(p=>[Math.max(30,p.x),Math.min(2270,p.right)])])].sort((a,b)=>a-b);
      let area=0;
      for(let a=0;a<xs.length;a++) for(let b=a+1;b<xs.length;b++) {
        const intervals=blocks.filter(p=>p.x<xs[b]&&p.right>xs[a]).map(p=>[Math.max(36,p.y),Math.min(3870,p.bottom)]).sort((a,b)=>a[0]-b[0]);
        let y=36;
        for(const [start,end] of intervals){if(start>y)area=Math.max(area,(xs[b]-xs[a])*(start-y));y=Math.max(y,end);}
        area=Math.max(area,(xs[b]-xs[a])*(3870-y));
      }
      if (area!==gap.w*gap.h) throw Error('largest-gap report is inaccurate');
      const output = document.createElement('canvas'); t.draw(output,t.sheets[0]);
      if(output.width!==2300 || output.height!==3900)throw Error('sheet export dimensions changed');
      const p=added[0];if(output.getContext('2d').getImageData(p.x+50,p.y+50,1,1).data.join()!=='171,19,87,255')throw Error('render source changed');
      // Repeated Add is a truthful no-op, and a second identical plan is stable.
      const again=t.add(jersey);
      if(again.requested!==0 || again.added || JSON.stringify(t.sheets[0].placements.slice(200))!==packSnapshot)throw Error('repeated Add changed the batch');
      window.batchAcceptance={frozen, count:240};
      return {locked:200, added:result.added, sheets:1, singleCopyFootprintIn2:baseline.footprint/10000,
        batchFootprintIn2:result.footprint/10000, largestGapIn:[gap.w/100,gap.h/100], pixels:[output.width,output.height], feedback:initialFeedback};
    });
    const jerseyCard = frame.locator('.design-item[data-design-id="2001"]');
    await jerseyCard.getByRole('button', {name:'Add to layout',exact:true}).click();
    await doc.waitForFunction(()=>incrementalTest.designs[1].layoutFeedback.includes('already on the layout'));
    assert.match(await jerseyCard.locator('[role=status]').innerText(), /Largest remaining usable gap/);
    for(const width of [1440,375]) {
      await page.setViewportSize({width,height:1000});
      // The route wrapper follows the real full-width builder iframe.
      await page.locator('iframe').evaluate(el=>{el.style.width='100%';el.style.height='900px';el.style.border='0';document.body.style.margin='0';});
      await jerseyCard.scrollIntoViewIfNeeded();
      assert.equal(await jerseyCard.evaluate(el=>el.scrollWidth>el.clientWidth+1),false,'batch feedback overflows card');
    }
    const orientationReport = await doc.evaluate(() => {
      const t = incrementalTest;
      for (const [id, value] of Object.entries({ dpi: 100, sheetWidth: 23, sheetLength: 39, gapNumber: 0.1, edgeAllowanceNumber: 0.3 })) document.getElementById(id).value = value;
      document.getElementById('autoRotate').checked = true;
      document.getElementById('autoExtend').checked = true;
      const settings = t.settings();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100;
      const horizontal = { id: 4100, file: { name: 'horizontal.png' }, qty: 20, widthIn: 2.7, heightIn: 1.15,
        trimmed: { canvas, w: 270, h: 115 }, vibrance: 0 };
      t.setState({ designs: [horizontal], instances: [], sheets: [], manualMode: false });
      const result = t.add(horizontal);
      if (result.added !== 20 || result.skipped || t.sheets.length !== 1) throw Error('horizontal batch was not fully placed on one sheet');
      const placements = t.sheets[0].placements;
      if (placements.some(p => p.inst.rotation !== 0 || p.w !== 270 || p.h !== 115)) throw Error('auto-rotate turned a fully fitting horizontal batch');
      const byRow = new Map();
      for (const p of placements) byRow.set(p.y, (byRow.get(p.y) || []).concat(p));
      const rows = [...byRow.values()].sort((a,b) => a[0].y - b[0].y);
      if (rows.length !== 3 || rows[0].length !== 8 || rows[1].length !== 8 || rows[2].length !== 4) throw Error('horizontal batch did not fill across before starting another row');
      for (const row of rows) {
        const xs = row.map(p => p.x).sort((a,b) => a-b);
        for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i-1] !== 280) throw Error('row spacing or left-to-right order changed');
      }
      const usedHeight = (Math.max(...placements.map(p => p.y + p.h)) - Math.min(...placements.map(p => p.y))) / 100;
      if (usedHeight > 4) throw Error('horizontal batch used excessive sheet length: ' + usedHeight + ' in');
      if (placements.some(p => p.x < 30 || p.y < 36 || p.x + p.w > 2270 || p.y + p.h > 3870)) throw Error('horizontal batch ignored automatic edge allowance');
      return { copies: placements.length, rows: rows.map(row => row.length), rotations: placements.filter(p => p.inst.rotation === 90).length, usedHeightIn: usedHeight };
    });
    const extraCases = await doc.evaluate(() => {
      const t=incrementalTest, c=t.designs[0].trimmed.canvas;
      const options={dpi:100,sheetWidthPx:500,sheetLengthPx:500,headerHeightPx:36,autoEdgeAllowancePx:30,gapPx:10,allowRotation:true,autoExtend:true};
      const item=(id,w,h)=>({id,designId:3,canvas:c,baseW:w,baseH:h,rotation:0});
      const makeSheet=(placements=[])=>({placements,widthPx:500,heightPx:500,headerHeightPx:36,gapPx:10});
      const locked={inst:item(20,350,434),x:30,y:36,w:350,h:434};
      t.setState({designs:[],instances:[locked.inst],sheets:[makeSheet([locked]),makeSheet()],manualMode:true});
      const copies=Array.from({length:4},(_,i)=>item(100+i,100,100));
      const later=t.pack(copies,options);
      if(later.createdSheets.length || later.addedBySheet[1]!==4 || later.sheets[0].placements[0]!==locked)throw Error('did not score all existing sheets');
      t.setState({designs:[],instances:[],sheets:[makeSheet()],manualMode:false});
      const mixed=[item(200,80,80),item(201,300,200),item(202,110,220)];
      const sorted=t.pack(mixed,options), reordered=t.pack(mixed.slice().reverse(),options);
      const serialize=p=>JSON.stringify(p.sheets.map(s=>s.placements.map(p=>[p.inst.id,p.x,p.y,p.w,p.h])));
      if(sorted.added!==3 || sorted.createdSheets.length || serialize(sorted)!==serialize(reordered))throw Error('mixed batch order is unstable');
      if(sorted.sheets[0].placements[0].inst.id!==201)throw Error('large pieces not processed first');
      const strip={inst:item(50,340,434),x:30,y:36,w:340,h:434};
      t.setState({designs:[],instances:[strip.inst],sheets:[makeSheet([strip])],manualMode:true});
      const rectangular=[item(300,180,80)];
      const noRotate=t.pack(rectangular,{...options,allowRotation:false,autoExtend:false});
      if(noRotate.added || noRotate.skipped!==1 || noRotate.createdSheets.length)throw Error('rotation/extension disabled ignored');
      const rotate=t.pack(rectangular,{...options,autoExtend:false});
      if(rotate.added!==1 || rotate.addedInstances[0].rotation!==90)throw Error('rotation did not recover a gap');
      // A full request that cannot fit reports its exact shortfall; no empty
      // sheets are created for an oversized piece.
      t.setState({designs:[],instances:[],sheets:[],manualMode:false});
      const partial=t.pack(Array.from({length:6},(_,i)=>item(400+i,200,200)),{...options,autoExtend:false});
      if(partial.added!==4||partial.skipped!==2||partial.largestGaps.length!==1)throw Error('partial quantity reporting');
      const huge=t.pack([item(500,900,900)],options);
      if(huge.added||huge.sheets.length||huge.skipped!==1)throw Error('oversized empty sheet');
      return 'All-sheet best fit, mixed batches independent of source order, rotation/extension limits, partial quantities, and oversized rejection passed.';
    });
    assert.deepEqual(errors, []);
    console.log('Incremental layout passed: locked pieces, grouping, spacing, rotation, margins, exact quantities, UI feedback, and full-sheet rendering.', batchReport);
    console.log('Orientation priority passed:', orientationReport);
    console.log(extraCases);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
