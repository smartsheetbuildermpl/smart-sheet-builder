/* The iframe owns the designs, instances and sheets. This adapter only changes the view
   and performs transactional edits against that existing state. */
window.installSheetWorkspace = function(b) {
  'use strict';
  var opened = false, activeSheet = 0, zoom = 1, drag = null, importing = false;
  var savedScroll = [0, 0], importEpoch = 0;
  var toolbar = document.createElement('section');
  toolbar.className = 'sheet-workspace-tools';
  toolbar.innerHTML = '<div class="sw-top"><div><span class="sw-eyebrow">LIVE GANG SHEET</span><h2>Your print, coming together.</h2></div><button id="sw-arrange" type="button">Auto-arrange</button></div>' +
    '<div class="sw-view"><label>Sheet<select id="sw-sheet" aria-label="Active sheet"></select></label><label>View zoom<select id="sw-zoom"><option value="0.5">50%</option><option value="1" selected>Fit</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option></select></label><span id="sw-summary"></span></div>' +
    '<form id="sw-selection"><p id="sw-name">Select a design on the sheet to edit it</p><fieldset id="sw-fields" disabled><label>Width <span class="sw-unit"></span><input id="sw-width" type="number" min="0.001" step="any" required></label><label>Height <span class="sw-unit"></span><input id="sw-height" type="number" min="0.001" step="any" required></label><label>Quantity<input id="sw-quantity" type="number" min="1" max="1000" step="1" required></label><label class="sw-lock"><input id="sw-lock" type="checkbox" checked>Lock ratio</label><button type="submit">Apply</button><button id="sw-rotate" type="button">Rotate 90°</button><button id="sw-remove" type="button">Remove</button></fieldset><small id="sw-ppi"></small></form><p id="sw-status" role="status">Drag a design onto the sheet, or choose Add to sheet.</p>';
  document.querySelector('.container').prepend(toolbar);
  var el = function(id){ return document.getElementById('sw-' + id); };
  var entry = document.createElement('button');
  entry.id = 'openDesignLibrary'; entry.className = 'library-sidebar-entry'; entry.type = 'button';
  entry.innerHTML = '<span class="library-entry-icon" aria-hidden="true">✦</span><span><strong>Design Library</strong><small>Discover. Place. Make it yours.</small></span><span aria-hidden="true">↗</span>';
  document.getElementById('fileInput').closest('.card').before(entry);
  function tell(type, detail) { if (window.parent !== window) window.parent.postMessage(Object.assign({ type: type }, detail || {}), location.origin); }
  entry.onclick = function(){ tell('SMART_SHEET_LIBRARY_OPEN'); };
  function status(message, bad) { el('status').textContent = message; el('status').classList.toggle('error', !!bad); }
  function previewSheet() {
    var s = b.settings();
    return { widthPx: s.sheetWidthPx, heightPx: s.sheetLengthPx, headerHeightPx: s.headerHeightPx, gapPx: s.gapPx, placements: [] };
  }
  function gapFor(sheet) { return sheet.gapPx == null ? b.settings().gapPx : sheet.gapPx; }
  function valid(p, sheet, ignore) {
    if (![p.x,p.y,p.w,p.h].every(Number.isFinite) || p.w <= 0 || p.h <= 0 || p.x < 0 || p.y < (sheet.headerHeightPx || 0) || p.x + p.w > sheet.widthPx + 1e-7 || p.y + p.h > sheet.heightPx + 1e-7) return false;
    var gap = gapFor(sheet);
    return sheet.placements.every(function(q){
      return q === ignore || q === p || p.x + p.w + gap <= q.x + 1e-7 || q.x + q.w + gap <= p.x + 1e-7 || p.y + p.h + gap <= q.y + 1e-7 || q.y + q.h + gap <= p.y + 1e-7;
    });
  }
  function selected() {
    if (b.selected.size !== 1) return null;
    for (var i = 0; i < b.sheets.length; i++) {
      var p = b.sheets[i].placements.find(function(p){ return b.selected.has(p.inst.id); });
      if (p) return { p: p, sheet: b.sheets[i], index: i, design: b.designs.find(function(d){ return d.id === p.inst.designId; }) };
    }
    return null;
  }
  function syncSelection() {
    var s = selected();
    el('fields').disabled = !s;
    el('name').textContent = s ? s.design.file.name : 'Select a design on the sheet to edit it';
    if (!s) { el('ppi').textContent = ''; return; }
    el('width').value = b.format(s.p.inst.baseW / b.dpi);
    el('height').value = b.format(s.p.inst.baseH / b.dpi);
    el('quantity').value = b.instances.filter(function(i){ return i.designId === s.design.id; }).length;
    document.querySelectorAll('.sw-unit').forEach(function(e){ e.textContent = '(' + b.unit() + ')'; });
    el('ppi').textContent = 'Active source ' + s.design.trimmed.w + ' × ' + s.design.trimmed.h + ' px · ' + Math.round(b.quality(s.p).ppi) + ' source PPI · sizes before rotation';
  }
  function refreshView() {
    activeSheet = Math.max(0, Math.min(activeSheet, Math.max(0, b.sheets.length - 1)));
    el('sheet').innerHTML = '';
    for (var i = 0; i < Math.max(1, b.sheets.length); i++) {
      var option = document.createElement('option'); option.value = i; option.textContent = 'Sheet ' + (i + 1) + ' of ' + Math.max(1, b.sheets.length); el('sheet').appendChild(option);
    }
    el('sheet').value = activeSheet;
    el('summary').textContent = b.sheets.reduce(function(n,s){ return n + s.placements.length; }, 0) + ' pieces · original resolution';
    document.querySelectorAll('.sheet-block').forEach(function(block, index){
      block.hidden = opened && index !== activeSheet;
      var wrap = block.querySelector('.canvas-wrap'), frame = block.querySelector('.sheet-ruler-frame');
      if (opened && wrap && frame) frame.style.width = Math.max(120, (wrap.clientWidth - 32) * zoom) + 'px';
      else if (frame) frame.style.width = '';
      if (wrap) wrap.style.maxHeight = opened ? Math.max(220, innerHeight - wrap.getBoundingClientRect().top - 24) + 'px' : '';
      var stage = block.querySelector('.canvas-stage');
      if (stage && !stage.dataset.workspaceDrop) {
        stage.dataset.workspaceDrop = 'true';
        stage.addEventListener('dragover', function(e){ dragOver(e, stage, index); });
        stage.addEventListener('drop', function(e){ drop(e, stage, index); });
        stage.addEventListener('dragleave', function(e){ if (!stage.contains(e.relatedTarget)) clearOutline(); });
      }
    });
    syncSelection();
  }
  function finish(message) {
    b.manual(); b.renderDesigns(); b.renderSheets(); b.stats(); b.qualityRefresh();
    refreshView(); if (message) status(message, false);
  }
  // Existing MaxRects packing, seeded with occupied rectangles, preserves manual placements.
  function placeAutomatically(inst, planned) {
    var settings = b.settings(), start = Math.min(activeSheet, planned.length - 1);
    var order = planned.map(function(_,i){ return i; });
    if (start >= 0) { order.splice(start, 1); order.unshift(start); }
    for (var k = 0; k <= order.length; k++) {
      var index = order[k], fresh = index == null;
      if (fresh && planned.length && !settings.autoExtend) break;
      var sheet = fresh ? previewSheet() : planned[index];
      var header = sheet.headerHeightPx || 0;
      var occupied = sheet.placements.map(function(p){ return { x:p.x, y:p.y-header, w:p.w, h:p.h }; });
      var packed = b.pack([inst], sheet.widthPx, Math.max(0, sheet.heightPx-header), gapFor(sheet), settings.allowRotation, occupied);
      if (packed.placements.length) {
        var p = packed.placements[0]; p.y += header;
        if (!valid(p, sheet)) continue;
        if (fresh) { index = planned.length; planned.push(sheet); }
        sheet.placements.push(p); return { p:p, index:index };
      }
    }
    throw new Error('No space at this print size. Enable another sheet, change the size yourself, or choose Auto-arrange.');
  }
  function copySheets() { return b.sheets.map(function(s){ return Object.assign({}, s, { placements:s.placements.slice() }); }); }
  async function addFile(file, point) {
    if (importing) throw new Error('An image is already loading. Please wait.');
    importing = true; status('Loading full-resolution PNG…');
    var epoch = importEpoch;
    try {
      var d = await b.decodeFile(file), inst = b.makeInstances(d, b.sheets.length ? b.dpi : b.settings().dpi)[0];
      if (epoch !== importEpoch) throw new Error('Import cancelled.');
      var planned = copySheets(), placed;
      if (point) {
        var sheet = planned[point.sheetIndex] || (!planned.length && point.sheetIndex === 0 ? previewSheet() : null);
        var p = { inst:inst, x:point.x, y:point.y, w:inst.baseW, h:inst.baseH };
        if (!sheet || !valid(p, sheet)) throw new Error('Invalid placement: keep the full design inside the sheet and leave the configured spacing.');
        if (!planned.length) planned.push(sheet);
        sheet.placements.push(p); placed = { p:p, index:point.sheetIndex };
      } else placed = placeAutomatically(inst, planned);
      // Publish only after image decoding and all placement checks succeed.
      b.designs.push(d); b.instances.push(inst); b.sheets = planned;
      inst.manualX = placed.p.x; inst.manualY = placed.p.y;
      b.selected.clear(); b.selected.add(inst.id); activeSheet = placed.index;
      finish('Added one piece. Drag to move it, or edit its print size below.');
      return { instanceId:inst.id, sheetIndex:activeSheet };
    } catch (error) { status(error.message, true); throw error; }
    finally { importing = false; }
  }
  function clearOutline() { document.querySelectorAll('.library-drop-outline').forEach(function(e){ e.remove(); }); }
  function dragPosition(e, stage, index) {
    if (!drag || !opened || importing) return null;
    var canvas = stage.querySelector('canvas'), rect = canvas.getBoundingClientRect();
    var sheet = b.sheets[index] || previewSheet(), dpi = b.sheets.length ? b.dpi : b.settings().dpi;
    var w = drag.widthPx, h = drag.heightPx;
    if (!(w > 0 && h > 0)) return null;
    // Native initial print size = source pixels / selected export DPI. No fit-to-sheet resize.
    var point = { x:Math.round((e.clientX-rect.left) * sheet.widthPx/rect.width - w/2), y:Math.round((e.clientY-rect.top) * sheet.heightPx/rect.height - h/2), w:w, h:h, sheetIndex:index };
    point.valid = valid(point, sheet); point.dpi = dpi; return point;
  }
  function dragOver(e, stage, index) {
    if (!drag || !opened) return;
    e.preventDefault(); var p = dragPosition(e, stage, index); clearOutline();
    if (!p) { status('Image dimensions are loading. Use Add to sheet when ready.', true); return; }
    e.dataTransfer.dropEffect = p.valid ? 'copy' : 'none';
    var sheet = b.sheets[index] || previewSheet(), outline = document.createElement('div');
    outline.className = 'library-drop-outline ' + (p.valid ? 'valid' : 'invalid');
    outline.style.cssText = 'left:'+(p.x/sheet.widthPx*100)+'%;top:'+(p.y/sheet.heightPx*100)+'%;width:'+(p.w/sheet.widthPx*100)+'%;height:'+(p.h/sheet.heightPx*100)+'%';
    outline.textContent = (p.valid ? 'Place' : 'Cannot place') + ' · ' + (p.w/p.dpi).toFixed(2) + ' × ' + (p.h/p.dpi).toFixed(2) + ' in';
    stage.appendChild(outline);
    status(p.valid ? 'Release to place one piece here.' : 'Outside the sheet or too close to another design.', !p.valid);
  }
  function drop(e, stage, index) {
    if (!drag || !opened) return;
    e.preventDefault(); var p = dragPosition(e, stage, index), id = drag.id;
    clearOutline(); drag = null;
    if (!p || !p.valid) { status('Drop cancelled. The layout has not changed.', true); return; }
    tell('SMART_SHEET_LIBRARY_DROP', { libraryId:id, point:{sheetIndex:index,x:p.x,y:p.y} });
  }
  function applySelected(event) {
    event.preventDefault(); var s = selected(); if (!s) return;
    try {
      var w = Math.round(b.readMeasure(el('width')) * b.dpi), h = Math.round(b.readMeasure(el('height')) * b.dpi), count = Number(el('quantity').value);
      if (!Number.isInteger(count) || count < 1 || count > 1000 || w < 1 || h < 1) throw new Error('Enter a positive size and a whole quantity from 1 to 1,000.');
      var planned = copySheets(), nextInst = Object.assign({},s.p.inst,{baseW:w,baseH:h});
      var next = Object.assign({},s.p,{ inst:nextInst, w:nextInst.rotation%180 ? h:w, h:nextInst.rotation%180 ? w:h });
      var sheet = planned[s.index];
      sheet.placements = sheet.placements.filter(function(p){return p !== s.p;});
      if (!valid(next,sheet)) throw new Error('That size overlaps another piece or goes outside the sheet.');
      sheet.placements.push(next);
      var current = b.instances.filter(function(i){return i.designId === s.design.id;});
      var removedIds = new Set(current.filter(function(i){return i.id !== nextInst.id;}).slice(Math.max(0,count-1)).map(function(i){return i.id;}));
      planned.forEach(function(sheet){sheet.placements=sheet.placements.filter(function(p){return !removedIds.has(p.inst.id);});});
      var added = [];
      for (var n=current.length; n<count; n++) {
        var clone = b.makeInstances(Object.assign({},s.design,{qty:1,widthIn:w/b.dpi,heightIn:h/b.dpi}),b.dpi)[0];
        placeAutomatically(clone,planned); added.push(clone);
      }
      b.instances = b.instances.filter(function(i){return !removedIds.has(i.id);}).map(function(i){return i.id === nextInst.id ? nextInst:i;}).concat(added);
      b.sheets = planned;
      s.design.widthIn=w/b.dpi; s.design.heightIn=h/b.dpi; s.design.qty=count;
      finish('Print size and quantity updated. Existing pieces kept their positions.');
    } catch(error) { status(error.message,true); syncSelection(); }
  }
  el('selection').onsubmit=applySelected;
  el('width').oninput=function(){var s=selected();if(s && el('lock').checked)el('height').value=Number(el('width').value)*s.p.inst.baseH/s.p.inst.baseW;};
  el('height').oninput=function(){var s=selected();if(s && el('lock').checked)el('width').value=Number(el('height').value)*s.p.inst.baseW/s.p.inst.baseH;};
  el('rotate').onclick=function(){var s=selected();if(!s)return; if(b.rotate(s.p,s.sheet))finish('Rotated 90°.');else status('Rotation needs more space at this position.',true);};
  el('remove').onclick=function(){
    var s=selected();if(!s)return;
    s.sheet.placements=s.sheet.placements.filter(function(p){return p!==s.p;});
    b.instances=b.instances.filter(function(i){return i.id!==s.p.inst.id;});
    s.design.qty=b.instances.filter(function(i){return i.designId===s.design.id;}).length;
    if(!s.design.qty)b.designs=b.designs.filter(function(d){return d!==s.design;});
    b.selected.clear();finish('Removed one piece.');
  };
  el('arrange').onclick=function(){
    try { b.autoArrange(); refreshView(); status('All pieces arranged using your spacing and rotation settings.'); } catch(error){status(error.message,true);}
  };
  el('sheet').onchange=function(){activeSheet=Number(this.value);refreshView();};
  el('zoom').onchange=function(){zoom=Number(this.value);refreshView();};
  document.addEventListener('keydown',function(e){
    if(!opened)return;
    if(e.key==='Escape'){e.preventDefault();tell('SMART_SHEET_WORKSPACE_ESCAPE');}
    if(e.key==='Tab'){
      var controls=Array.from(document.querySelectorAll('button,input,select,[tabindex="0"]')).filter(function(n){return !n.disabled && n.getClientRects().length;});
      if((e.shiftKey && document.activeElement===controls[0])||(!e.shiftKey && document.activeElement===controls[controls.length-1])){e.preventDefault();tell('SMART_SHEET_WORKSPACE_FOCUS',{backwards:e.shiftKey});}
    }
  });
  window.addEventListener('resize',refreshView);
  var api = {
    get opened(){return opened;},
    setOpen:function(value){
      if(value===opened)return;
      if(value)savedScroll=[scrollX,scrollY];
      else importEpoch++;
      opened=value; document.body.classList.toggle('in-library-workspace',value);
      clearOutline();drag=null;refreshView();
      if(value)scrollTo(0,0);else{scrollTo(savedScroll[0],savedScroll[1]);entry.focus({preventScroll:true});}
    },
    addFile:addFile, syncSelection:syncSelection, refresh:refreshView,
    beginDrag:function(item){drag=item;},endDrag:function(){drag=null;clearOutline();},
    validate:function(p,sheet,ignore){return valid(p,sheet,ignore);},
    showStatus:status,
    // Read-only snapshot for UI diagnostics; these values never drive the layout.
    snapshot:function(){return {dpi:b.dpi,sheets:b.sheets.map(function(s){return {width:s.widthPx,height:s.heightPx,gap:gapFor(s),placements:s.placements.map(function(p){return {id:p.inst.id,designId:p.inst.designId,x:p.x,y:p.y,w:p.w,h:p.h,rotation:p.inst.rotation,sourceWidth:p.inst.canvas.width,sourceHeight:p.inst.canvas.height};})};}),selected:Array.from(b.selected)};}
  };
  window.smartSheetWorkspace=api;refreshView();return api;
};
