/* Full-resolution edits live only in this modal until its Apply callback succeeds. */
(function(){
  'use strict';
  // Read-only, chunked selection. No component is deleted merely for being small.
  // Only the border-connected colour field can be selected automatically.
  async function outsideMask(image, w, h, settings, protectedPixels, cancelled) {
    var data=image.data, count=w*h, mask=new Uint8Array(count), queue=new Uint32Array(count), end=0, head=0;
    var bins=new Map(), samples=0;
    function sample(p) {
      var i=p*4;if((settings.original?settings.original[i+3]:data[i+3])<250)return;
      var key=(data[i]>>4)+':'+(data[i+1]>>4)+':'+(data[i+2]>>4), bin=bins.get(key)||[0,0,0,0];
      bin[0]+=data[i];bin[1]+=data[i+1];bin[2]+=data[i+2];bin[3]++;bins.set(key,bin);samples++;
    }
    for(var x=0;x<w;x++){sample(x);sample((h-1)*w+x);}
    for(var y=1;y<h-1;y++){sample(y*w);sample(y*w+w-1);}
    var dominant=null;bins.forEach(function(bin){if(!dominant||bin[3]>dominant[3])dominant=bin;});
    if(!dominant||dominant[3]<Math.max(3,samples*.5))return {mask:mask,selected:0,reason:'No reliable, uniform outside background was found. Use Magic Wand or a brush.'};
    var bg=dominant.slice(0,3).map(function(v){return v/dominant[3];}), tolerance=settings.tolerance;
    var protect=settings.protection, cleanup=settings.cleanup, seen=new Uint8Array(count);
    function distance(p){var i=p*4;return Math.hypot(data[i]-bg[0],data[i+1]-bg[1],data[i+2]-bg[2])/Math.sqrt(3);}
    function visit(p) {
      if(seen[p])return;seen[p]=1;
      if(protectedPixels&&protectedPixels[p])return;
      var i=p*4, a=data[i+3];
      if(a===0){queue[end++]=p;return;}
      var d=distance(p);if(d>tolerance)return;
      // Keep deliberate translucent edges/shadows. Do not propagate a fill
      // through near-colour anti-alias pixels into enclosed artwork.
      if(a<250&&d>1&&(!settings.original||settings.original[i+3]<250))return;
      var px=p%w, nearForeground=false, boundary=protect==='strong'?1.15:protect==='low'?2:1.5;
      if(protect!=='low'&&d>Math.max(2,tolerance*.18)){
        if(px>0&&distance(p-1)>Math.max(tolerance*boundary,24))nearForeground=true;
        if(px<w-1&&distance(p+1)>Math.max(tolerance*boundary,24))nearForeground=true;
        if(p>=w&&distance(p-w)>Math.max(tolerance*boundary,24))nearForeground=true;
        if(p<count-w&&distance(p+w)>Math.max(tolerance*boundary,24))nearForeground=true;
      }
      if(nearForeground&&!(cleanup==='strong'&&d<=tolerance*.35))return;
      queue[end++]=p;
      // Standard/Strong fully clear selected outside dirt, never global islands.
      var fraction=cleanup==='off'?.65:cleanup==='light'?.85:1;
      mask[p]=nearForeground?Math.max(1,Math.round(255*(1-d/(tolerance+1)))):d<=tolerance*fraction?255:Math.max(1,Math.round(255*(1-d/(tolerance+1))));
    }
    for(var sx=0;sx<w;sx++){visit(sx);visit((h-1)*w+sx);}
    for(var sy=1;sy<h-1;sy++){visit(sy*w);visit(sy*w+w-1);}
    while(head<end){
      var stop=Math.min(end,head+32768);
      while(head<stop){var p=queue[head++],px=p%w;if(px>0)visit(p-1);if(px<w-1)visit(p+1);if(p>=w)visit(p-w);if(p<count-w)visit(p+w);}
      await new Promise(function(resolve){setTimeout(resolve,0);});
      if(cancelled())return null;
    }
    var selected=0;for(var n=0;n<count;n++)if(mask[n])selected++;
    return {mask:mask,selected:selected};
  }
  window.SmartSheetBackgroundMask={select:outsideMask};
  window.openBackgroundEditor = function(options) {
    if (document.querySelector('.bg-editor')) return;
    var w = options.canvas.width, h = options.canvas.height, count = w * h;
    var focusBefore = document.activeElement, pageScroll = {x:window.scrollX, y:window.scrollY}, dialog = document.createElement('dialog');
    dialog.className = 'bg-editor'; dialog.setAttribute('aria-labelledby', 'bg-title');
    dialog.innerHTML = '<header><div><span class="bg-brand">MASTER PRINTLAB · BACKGROUND STUDIO</span><h2 id="bg-title">Refine Background</h2><p class="bg-name"></p></div><button type="button" class="bg-close" data-action="close" aria-label="Close Background Editor" title="Close editor">×</button></header>' +
      '<div class="bg-body"><aside class="bg-tool-rail" aria-label="Editor tools"><button type="button" data-tool="wand" aria-pressed="true" title="Magic Wand"><span aria-hidden="true">✦</span><span>Magic Wand</span></button><button type="button" data-tool="erase" aria-pressed="false" title="Erase Brush"><span aria-hidden="true">⌫</span><span>Erase Brush</span></button><button type="button" data-tool="restore" aria-pressed="false" title="Restore Brush"><span aria-hidden="true">↶</span><span>Restore Brush</span></button><button type="button" data-tool="pan" aria-pressed="false" title="Pan canvas"><span aria-hidden="true">✋</span><span>Pan</span></button></aside>' +
      '<aside class="bg-options" aria-label="Tool options"><section class="bg-tool-panel is-active" data-tool-panel="wand"><h3>Magic Wand</h3><p class="bg-tool-copy">Click a visible background color to preview a selection. Click again to add more colors.</p><label>Tolerance <output id="bg-tolerance-value">32</output><input id="bg-tolerance" type="range" min="0" max="255" value="32"></label><label><input id="bg-contiguous" type="checkbox" checked>Contiguous</label><label><input id="bg-antialias" type="checkbox" checked>Anti-alias</label><label>Selection mode<select id="bg-mode"><option value="add">Add to selection</option><option value="subtract">Subtract from selection</option></select></label><div class="bg-option-actions"><button type="button" data-action="erase-selection">Erase selection</button><button type="button" data-action="clear">Clear selection</button></div></section>' +
      '<section class="bg-tool-panel" data-tool-panel="erase"><h3>Erase Brush</h3><p class="bg-tool-copy">Paint directly on unwanted pixels. The soft edge protects anti-aliased artwork.</p><label>Brush size <output id="bg-size-value">40</output><input id="bg-size" type="range" min="1" max="500" value="40"></label><p class="bg-option-note">Soft edge is automatic and scales with the selected brush size.</p></section>' +
      '<section class="bg-tool-panel" data-tool-panel="restore"><h3>Restore Brush</h3><p class="bg-tool-copy">Paint back pixels from the original uploaded image without changing its print size.</p><label>Brush size <output class="bg-size-mirror">40</output><input class="bg-size-mirror-input" type="range" min="1" max="500" value="40"></label><p class="bg-option-note">Restore recovers color and transparency from the untouched source.</p></section>' +
      '<section class="bg-tool-panel" data-tool-panel="pan"><h3>Pan canvas</h3><p class="bg-tool-copy">Drag the canvas to inspect details. Use zoom controls above, or arrow keys while the canvas is focused.</p></section>' +
      '<details class="bg-advanced"><summary>Automatic background removal</summary><div><label>Background tolerance <output id="bg-auto-tolerance-value">24</output><input id="bg-auto-tolerance" type="range" min="0" max="110" step="1" value="24"></label><label>Edge protection<select id="bg-edge-protection"><option value="low">Low</option><option value="balanced" selected>Balanced</option><option value="strong">Strong</option></select></label><label>Background cleanup<select id="bg-cleanup"><option value="off">Off</option><option value="light">Light</option><option value="standard" selected>Standard</option><option value="strong">Strong</option></select></label><p class="bg-option-note">Tolerance selects only the connected outside colour. Stronger protection keeps more edges; stronger cleanup clears more selected residue. Enclosed areas and protected brush strokes stay untouched. Similar-colour artwork touching the outside may need Protect / Restore first.</p><button type="button" data-action="auto-edge">Auto-remove edge background</button><button type="button" data-action="tiny-specks">Clean outside residue</button><p class="bg-option-note">Review the blue selection before Apply. Small detached artwork is never removed just because of its size.</p></div></details><p id="bg-history-note"></p></aside>' +
      '<section class="bg-view" aria-label="Image editor"><div class="bg-viewbar"><button type="button" data-action="undo">Undo</button><button type="button" data-action="redo">Redo</button><button type="button" data-action="reset">Reset editor changes</button><button type="button" data-action="out" aria-label="Zoom out">−</button><output id="bg-zoom">100%</output><button type="button" data-action="in" aria-label="Zoom in">+</button><button type="button" data-action="fit">Fit</button><small id="bg-resolution"></small></div><div class="bg-viewport"><div class="bg-stage" tabindex="0" role="application" aria-label="Image editing canvas. Arrow keys move the cursor; Enter uses the selected tool. Use Pan and arrow keys to scroll."><canvas class="bg-image"></canvas><canvas class="bg-overlay"></canvas></div></div></section></div>' +
      '<footer><p class="bg-status" role="status" aria-live="polite">Select a background area to preview a selection. Changes stay here until Apply.</p><div class="bg-actions"><button type="button" data-action="cancel">Cancel</button><button type="button" data-action="apply" class="bg-primary">Apply background removal</button></div></footer>';
    var $ = function(sel){ return dialog.querySelector(sel); };
    var button = function(name){ return $('[data-action="' + name + '"]'); };
    $('#bg-tolerance').title = 'Maximum color distance from the clicked pixel. A higher value selects more similar colors.';
    $('#bg-contiguous').title = 'Select only connected colors; switch off to match similar colors throughout the canvas.';
    $('#bg-antialias').title = 'Feather the selection across near-matching colors instead of using a hard color cutoff.';
    $('#bg-size').title = 'Brush diameter measured in full-resolution image pixels, independent of view zoom.';
    $('#bg-auto-tolerance').value = '24';
    $('#bg-auto-tolerance-value').textContent = $('#bg-auto-tolerance').value;
    var stage = $('.bg-stage'), viewport = $('.bg-viewport'), display = $('.bg-image'), overlay = $('.bg-overlay');
    var cursorEl = document.createElement('span'); cursorEl.className = 'bg-cursor'; cursorEl.setAttribute('aria-hidden','true');stage.appendChild(cursorEl);
    var statusEl = $('.bg-status'), closed = false, busy = false, generation = 0, tool = 'wand', zoom = 1;
    var stroke = null, cursor = {x:Math.floor(w/2), y:Math.floor(h/2)}, frame = 0;
    var history = [], future = [], lastWand = null;
    function notifyHost(type) {
      if (window.parent && window.parent !== window) window.parent.postMessage({type:type}, window.location.origin);
    }
    // History contains compact masks, never duplicated colour/source images.
    var historyLimit = Math.max(1,Math.min(16,Math.floor(96*1024*1024/(count*4))));
    var scratch = display, viewScale=Math.min(1,1600/Math.max(w,h));
    scratch.width=Math.max(1,Math.round(w*viewScale));scratch.height=Math.max(1,Math.round(h*viewScale));
    var context = scratch.getContext('2d', {willReadFrequently:true});
    var pixels, original, opening, selection=new Uint8Array(count), alpha=new Uint8Array(count), protectedPixels=new Uint8Array(count), restoreMix=new Uint8Array(count), autoSelection=false;
    var viewbar=$('.bg-viewbar'), inspect=document.createElement('div');inspect.className='bg-inspect';
    inspect.innerHTML='<label>Preview background <select id="bg-preview-background"><option value="checker">Checkerboard</option><option value="black">Black</option><option value="white">White</option></select></label><label>Compare <select id="bg-compare"><option value="edited">Edited</option><option value="original">Original</option></select></label>';
    viewbar.appendChild(inspect);
    $('[data-tool="restore"]').title='Protect / Restore brush: restore artwork and protect it from automatic removal';
    $('[data-tool-panel="restore"] h3').textContent='Protect / Restore';
    $('[data-tool-panel="restore"] .bg-tool-copy').textContent='Restore original artwork and protect each stroke from later automatic removal. Reset clears protection.';
    function status(message, error) { statusEl.textContent = message; statusEl.classList.toggle('error', !!error); }
    function close() {
      if (closed) return;
      closed = true; generation++; cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keyboard, true);
      dialog.close(); dialog.remove();
      document.documentElement.classList.remove('bg-editor-open'); document.body.classList.remove('bg-editor-open');
      notifyHost('SMART_SHEET_BACKGROUND_EDITOR_CLOSE');
      scratch.width = scratch.height = overlay.width = overlay.height = 0;
      pixels = original = opening = selection = alpha = protectedPixels = restoreMix = null; history = []; future = []; lastWand = null;
      window.requestAnimationFrame(function(){ window.scrollTo(pageScroll.x, pageScroll.y); });
      if (focusBefore && focusBefore.isConnected) focusBefore.focus({preventScroll:true});
    }
    try {
      pixels = options.canvas.getContext('2d', {willReadFrequently:true}).getImageData(0,0,w,h);
      opening=pixels.data.slice();
      // Restore Brush maps the full untouched upload to the current crop/resolution.
      var r = options.sourceRect;
      var restoreCanvas=document.createElement('canvas');restoreCanvas.width=w;restoreCanvas.height=h;
      var restoreContext=restoreCanvas.getContext('2d',{willReadFrequently:true});
      restoreContext.drawImage(options.original, r.x,r.y,r.w,r.h, 0,0,w,h);
      original = restoreContext.getImageData(0,0,w,h);restoreCanvas.width=restoreCanvas.height=0;
      for(var a=0;a<count;a++)alpha[a]=pixels.data[a*4+3];
      $('.bg-name').textContent = options.name;
      $('#bg-resolution').textContent = w + ' × ' + h + ' px source · full-resolution mask · screen preview ≤1600 px';
      $('#bg-history-note').textContent = 'Mask Undo / Redo: up to ' + historyLimit + ' steps for this image. Reset restores the original artwork at current bounds. Print dimensions stay unchanged. Screen preview never replaces the full-resolution Apply source.';
      document.documentElement.classList.add('bg-editor-open'); document.body.classList.add('bg-editor-open');
      document.body.appendChild(dialog); dialog.showModal();
      notifyHost('SMART_SHEET_BACKGROUND_EDITOR_OPEN');
      document.addEventListener('keydown', keyboard, true);
      render(); fit(); $('[data-tool="wand"]').focus();
    } catch(error) { close(); throw error; }

    function snapshot() { return {alpha:alpha.slice(), selection:selection.slice(), protection:protectedPixels.slice(), mix:restoreMix.slice(), automatic:autoSelection}; }
    function remember() {
      future = []; if (history.length >= historyLimit) history.shift();
      history.push(snapshot()); lastWand = null;
    }
    function compose(start,end) {for(var p=start||0;p<(end==null?count:end);p++){var i=p*4,t=restoreMix[p]/255;for(var c=0;c<3;c++)pixels.data[i+c]=Math.round(opening[i+c]*(1-t)+original.data[i+c]*t);pixels.data[i+3]=alpha[p];}}
    async function prepareNative(){for(var p=0;p<count;p+=262144){if(closed)return false;compose(p,Math.min(count,p+262144));if(count>262144)await new Promise(function(resolve){setTimeout(resolve,0);});}return !closed;}
    function load(state) { alpha.set(state.alpha);selection.set(state.selection);protectedPixels.set(state.protection);restoreMix.set(state.mix);autoSelection=state.automatic;lastWand = null;render(); }
    function controls() {
      dialog.setAttribute('aria-busy', String(busy));
      dialog.querySelectorAll('button,input,select').forEach(function(el){ el.disabled = busy && el !== button('close') && el !== button('cancel'); });
      if (!busy) { button('undo').disabled = !history.length; button('redo').disabled = !future.length; }
    }
    function setTool(nextTool, announce) {
      tool = nextTool; stage.dataset.tool = tool;
      dialog.querySelectorAll('button[data-tool]').forEach(function(buttonEl){ buttonEl.setAttribute('aria-pressed',String(buttonEl.dataset.tool===tool)); });
      dialog.querySelectorAll('[data-tool-panel]').forEach(function(panel){ panel.classList.toggle('is-active',panel.dataset.toolPanel===tool); });
      if (announce && tool === 'wand') status('Click a visible background color to preview a selection.');
      if (announce && tool === 'erase') status('Paint over pixels to erase them. Restore Brush can recover them.');
      if (announce && tool === 'restore') status('Paint to restore pixels from the original uploaded image.');
      if (announce && tool === 'pan') status('Drag the canvas to pan. Use the toolbar to zoom or fit it.');
      render();
    }
    function render() {
      if (closed) return;
      if(viewScale===1)compose();
      var compare=$('#bg-compare').value==='original', shown=compare?original.data:pixels.data;
      var preview=context.createImageData(scratch.width,scratch.height);
      for(var vy=0;vy<scratch.height;vy++)for(var vx=0;vx<scratch.width;vx++){
        var src=(Math.min(h-1,Math.floor(vy/viewScale))*w+Math.min(w-1,Math.floor(vx/viewScale)))*4,dst=(vy*scratch.width+vx)*4;
        if(compare||viewScale===1)preview.data.set(shown.subarray(src,src+4),dst);
        else {var blend=restoreMix[src/4]/255;for(var c=0;c<3;c++)preview.data[dst+c]=Math.round(opening[src+c]*(1-blend)+original.data[src+c]*blend);preview.data[dst+3]=alpha[src/4];}
      }
      context.putImageData(preview,0,0);
      // Both display layers are bounded proxies; native masks/source stay separate.
      var scale = viewScale;
      overlay.width = Math.max(1,Math.round(w*scale));
      overlay.height = Math.max(1,Math.round(h*scale));
      var ctx = overlay.getContext('2d'), mask = ctx.createImageData(overlay.width,overlay.height), n = 0;
      for (var p=0;p<count;p++) if (selection[p]) n++;
      for (var y=0;y<overlay.height;y++) for (var x=0;x<overlay.width;x++) {
        var i=(y*overlay.width+x)*4, a=selection[Math.min(h-1,Math.floor(y/scale))*w+Math.min(w-1,Math.floor(x/scale))];
        mask.data[i]=0; mask.data[i+1]=193; mask.data[i+2]=230; mask.data[i+3]=compare?0:Math.round(a*.55);
      }
      ctx.putImageData(mask,0,0);
      drawCursor();
      overlay.dataset.selectedPixels = n;
      controls();
    }
    function queueRender() { if (!frame) frame=requestAnimationFrame(function(){frame=0;render();}); }
    function drawCursor() {
      var size=tool==='erase'||tool==='restore'?Number($('#bg-size').value)*zoom:10;
      cursorEl.style.cssText='left:'+cursor.x/w*100+'%;top:'+cursor.y/h*100+'%;width:'+size+'px;height:'+size+'px;display:'+(tool==='pan'?'none':'block');
    }
    function setZoom(value) {
      var old=zoom; zoom=Math.max(.02,Math.min(8,value));
      var cx=(viewport.scrollLeft+viewport.clientWidth/2)/old, cy=(viewport.scrollTop+viewport.clientHeight/2)/old;
      stage.style.width=w*zoom+'px'; stage.style.height=h*zoom+'px';
      viewport.scrollLeft=cx*zoom-viewport.clientWidth/2; viewport.scrollTop=cy*zoom-viewport.clientHeight/2;
      $('#bg-zoom').textContent=Math.round(zoom*100)+'%';
      drawCursor();
    }
    function fit(){setZoom(Math.min(4,(viewport.clientWidth-48)/w,(viewport.clientHeight-48)/h));viewport.scrollLeft=viewport.scrollTop=0;}
    function point(event) {
      var rect=stage.getBoundingClientRect();
      return {x:Math.max(0,Math.min(w-1,(event.clientX-rect.left)*w/rect.width)), y:Math.max(0,Math.min(h-1,(event.clientY-rect.top)*h/rect.height))};
    }
    function coverage(distance,tolerance,aa) {
      if(distance<=tolerance) return 255;
      if(!aa || distance>=tolerance+12) return 0;
      var t=1-(distance-tolerance)/12; return Math.round(255*t*t*(3-2*t));
    }
    async function wand(at, base) {
      if(busy || closed) return;
      var seed=Math.floor(at.y)*w+Math.floor(at.x), data=pixels.data;
      if(!data[seed*4+3]) {status('Click a visible background pixel to select its color.');return;}
      var initial=base || selection.slice();
      remember(); lastWand={at:at,base:initial};
      autoSelection=false;
      var token=++generation, tolerance=Number($('#bg-tolerance').value), aa=$('#bg-antialias').checked;
      var contiguous=$('#bg-contiguous').checked, subtract=$('#bg-mode').value==='subtract';
      var visited=new Uint8Array(count), queue=contiguous?new Uint32Array(count):null;
      var start=0,end=contiguous?1:count;
      if(contiguous){queue[0]=seed;visited[seed]=1;}
      var red=data[seed*4], green=data[seed*4+1], blue=data[seed*4+2];
      busy=true; controls(); status('Selecting background colors… Cancel remains available.');
      try {
        selection.set(initial);
        while(start<end) {
          var steps=0;
          while(start<end && steps++<32768) {
            var p=contiguous?queue[start++]:start++, i=p*4;
            var amount=coverage(Math.hypot(data[i]-red,data[i+1]-green,data[i+2]-blue)/Math.sqrt(3),tolerance,aa);
            if(!data[i+3]) amount=0;
            if(!amount) continue;
            selection[p]=subtract?Math.round(initial[p]*(1-amount/255)):Math.max(initial[p],amount);
            if(contiguous) {
              var px=p%w;
              if(px>0) visit(p-1); if(px<w-1) visit(p+1); if(p>=w) visit(p-w); if(p<count-w) visit(p+w);
            }
          }
          await new Promise(function(resolve){setTimeout(resolve,0);});
          if(closed || token!==generation) return;
        }
        status('Selection preview ready. Click more colors, Erase selection, or Apply to remove it.');
      } catch(error) { if(!closed) {selection.set(initial);status(error.message,true);} }
      finally {if(!closed){busy=false;render();}}
      function visit(p){if(!visited[p]){visited[p]=1;queue[end++]=p;}}
    }
    function applySelection(target) {
      var feather=$('#bg-antialias').checked;
      for(var p=0;p<count;p++) {
        var amount=selection[p];if(!amount)continue;
        if(autoSelection){target[p*4+3]=Math.round(target[p*4+3]*(1-amount/255));continue;}
        var boundary=false;
        // Mask membership, not color similarity, determines removal. Fractional
        // wand coverage inside the selected background must not leave residue.
        // Feather only the immediate (one-pixel) unselected foreground border.
        if(feather&&amount<255){
          var x=p%w,y=Math.floor(p/w);
          for(var dy=-1;dy<=1&&!boundary;dy++)for(var dx=-1;dx<=1&&!boundary;dx++){
            var nx=x+dx,ny=y+dy;
            if(nx<0||nx>=w||ny<0||ny>=h)continue;
            var next=ny*w+nx;
            if(!selection[next]&&pixels.data[next*4+3]>0)boundary=true;
          }
        }
        target[p*4+3]=boundary?Math.round(target[p*4+3]*(1-amount/255)):0;
      }
    }
    function eraseSelection() {
      compose();
      applySelection(pixels.data);
      for(var p=0;p<count;p++)alpha[p]=pixels.data[p*4+3];
      selection.fill(0);lastWand=null;autoSelection=false;
    }
    async function cleanup() {
      if(busy||closed)return;
      var token=++generation;busy=true;controls();status('Analyzing outside-connected background at '+w+' × '+h+' px… Cancel remains available.');
      try {
        await new Promise(function(resolve){setTimeout(resolve,0);});if(closed)return;
        if(!await prepareNative())return;
        var result=await outsideMask(pixels,w,h,{tolerance:Number($('#bg-auto-tolerance').value),protection:$('#bg-edge-protection').value,cleanup:$('#bg-cleanup').value,original:opening},protectedPixels,function(){return closed||token!==generation;});
        if(!result||closed)return;
        if(!result.selected){status(result.reason||'No outside-connected background remains within tolerance. Use Remove brush for isolated residue.');return;}
        remember();selection.set(result.mask);autoSelection=true;
        status('Outside-connected background selection ready: '+result.selected.toLocaleString()+' pixels. Review the blue preview, then Apply or Erase selection. Enclosed details are protected.');
      }catch(error){if(!closed)status('Background selection failed: '+error.message+'. No changes applied. Retry or use a brush.',true);}
      finally{if(!closed){busy=false;render();}}
    }
    function dab(at, from) {
      var radius=Number($('#bg-size').value)/2, feather=Math.min(1,radius/2), data=pixels.data;
      for(var y=Math.max(0,Math.floor(at.y-radius));y<=Math.min(h-1,Math.ceil(at.y+radius));y++) {
        for(var x=Math.max(0,Math.floor(at.x-radius));x<=Math.min(w-1,Math.ceil(at.x+radius));x++) {
          var amount=Math.max(0,Math.min(1,(radius-Math.hypot(x+.5-at.x,y+.5-at.y))/feather));
          if(!amount) continue;
          var p=y*w+x, i=p*4;
          if(tool==='restore') {
            var strength=Math.round(amount*255);
            if(stroke && stroke.coverage[p]>=strength)continue;
            if(stroke)stroke.coverage[p]=strength;
            var priorMix=stroke?history[history.length-1].mix[p]:restoreMix[p];
            restoreMix[p]=Math.round(priorMix*(1-amount)+255*amount);
            alpha[p]=Math.round(from[p]*(1-amount)+original.data[i+3]*amount);
            protectedPixels[p]=255;
            var selectedBefore=stroke?history[history.length-1].selection[p]:selection[p];
            selection[p]=Math.round(selectedBefore*(1-amount));
          } else {alpha[p]=Math.min(alpha[p],Math.round(from[p]*(1-amount)));selection[p]=0;protectedPixels[p]=0;}
        }
      }
    }
    function paint(at) {
      var distance=Math.hypot(at.x-stroke.last.x,at.y-stroke.last.y), steps=Math.max(1,Math.ceil(distance/Math.max(.5,Number($('#bg-size').value)/5)));
      for(var s=1;s<=steps;s++) dab({x:stroke.last.x+(at.x-stroke.last.x)*s/steps,y:stroke.last.y+(at.y-stroke.last.y)*s/steps},history[history.length-1].alpha);
      stroke.last=at;cursor=at;queueRender();
    }
    stage.onpointerdown=function(e){
      if(busy || e.button!==0) return; e.preventDefault();stage.focus();cursor=point(e);
      if($('#bg-compare').value==='original'){status('Switch Compare to Edited before making corrections.');return;}
      if(tool==='wand'){wand(cursor);return;}
      stage.setPointerCapture(e.pointerId);
      if(tool==='pan') stroke={id:e.pointerId,x:e.clientX,y:e.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};
      else {remember();stroke={id:e.pointerId,last:cursor,coverage:tool==='restore'?new Uint8Array(count):null};paint(cursor);}
    };
    stage.onpointermove=function(e){
      if(!stroke){cursor=point(e);drawCursor();return;}
      if(tool==='pan'){viewport.scrollLeft=stroke.left+stroke.x-e.clientX;viewport.scrollTop=stroke.top+stroke.y-e.clientY;}
      else paint(point(e));
    };
    function endStroke(){if(stroke){stroke=null;render();status('Brush stroke recorded. Undo or Apply when ready.');}}
    stage.onpointerup=endStroke;stage.onpointercancel=endStroke;stage.onlostpointercapture=endStroke;
    function keyboard(e) {
      if(closed) return;
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();return;}
      if(!busy&&(e.ctrlKey||e.metaKey)&&!e.target.closest('input,textarea,select,[contenteditable=true]')&&(e.key.toLowerCase()==='z'||e.key.toLowerCase()==='y')){
        e.preventDefault();e.stopImmediatePropagation();button(e.shiftKey||e.key.toLowerCase()==='y'?'redo':'undo').click();return;
      }
      if(e.key==='Tab') {
        var focusables=Array.from(dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]'));
        var first=focusables[0],last=focusables[focusables.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
      if(document.activeElement!==stage || busy) return;
      var delta=e.shiftKey?20:1;
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
        e.preventDefault();var dx=e.key==='ArrowLeft'?-delta:e.key==='ArrowRight'?delta:0,dy=e.key==='ArrowUp'?-delta:e.key==='ArrowDown'?delta:0;
        if(tool==='pan'){viewport.scrollLeft+=dx*20;viewport.scrollTop+=dy*20;}
        else {cursor.x=Math.max(0,Math.min(w-1,cursor.x+dx));cursor.y=Math.max(0,Math.min(h-1,cursor.y+dy));render();}
      }
      if(e.key==='Enter'||e.key===' '){e.preventDefault();if($('#bg-compare').value==='original')return;if(tool==='wand')wand(cursor);else if(tool!=='pan'){remember();dab(cursor,history[history.length-1].alpha);render();}}
    }
    dialog.addEventListener('cancel',function(e){e.preventDefault();close();});
    dialog.querySelectorAll('button[data-tool]').forEach(function(b){b.onclick=function(){setTool(b.dataset.tool, true);};});
    function updateBrushSize(value) {
      $('#bg-size').value = value; $('#bg-size-value').textContent = value;
      dialog.querySelectorAll('.bg-size-mirror').forEach(function(output){ output.textContent = value; });
      dialog.querySelectorAll('.bg-size-mirror-input').forEach(function(input){ input.value = value; });
      drawCursor();
    }
    $('#bg-size').oninput=function(){updateBrushSize(this.value);};
    dialog.querySelectorAll('.bg-size-mirror-input').forEach(function(input){input.oninput=function(){updateBrushSize(this.value);};});
    $('#bg-auto-tolerance').oninput=function(){$('#bg-auto-tolerance-value').textContent=this.value;};
    ['#bg-auto-tolerance','#bg-edge-protection','#bg-cleanup'].forEach(function(id){$(id).onchange=function(){if(autoSelection)status('Automatic settings changed. Click Auto-remove edge background to update the selection before Apply.');};});
    $('#bg-tolerance').oninput=function(){$('#bg-tolerance-value').textContent=this.value;};
    ['#bg-tolerance','#bg-contiguous','#bg-antialias','#bg-mode'].forEach(function(id){$(id).onchange=function(){if(lastWand)wand(lastWand.at,lastWand.base);};});
    function hasUnappliedEdits() { return history.length > 0 || selection.some(function(value){ return value > 0; }); }
    button('close').onclick=function(){ if (!hasUnappliedEdits() || window.confirm('Discard unapplied background edits?')) close(); };
    button('cancel').onclick=close;
    button('in').onclick=function(){setZoom(zoom*1.25);};button('out').onclick=function(){setZoom(zoom/1.25);};button('fit').onclick=fit;
    button('undo').onclick=function(){if(history.length){future.push(snapshot());load(history.pop());status('Undone.');}};
    button('redo').onclick=function(){if(future.length){history.push(snapshot());load(future.pop());status('Redone.');}};
    button('reset').onclick=function(){remember();for(var p=0;p<count;p++){alpha[p]=original.data[p*4+3];restoreMix[p]=255;}protectedPixels.fill(0);selection.fill(0);autoSelection=false;render();status('Restored the original uploaded artwork at the current source bounds. Print dimensions unchanged.');};
    button('clear').onclick=function(){remember();selection.fill(0);render();status('Selection cleared.');};
    button('erase-selection').onclick=function(){remember();eraseSelection();render();status('Selected pixels erased in the editor. Restore Brush can recover them.');};
    button('auto-edge').onclick=cleanup;
    button('tiny-specks').onclick=cleanup;
    $('#bg-preview-background').onchange=function(){stage.dataset.background=this.value;};
    $('#bg-compare').onchange=function(){render();status(this.value==='original'?'Showing original upload. Switch to Edited to make corrections.':'Showing edited mask result.');};
    button('apply').onclick=async function(){
      if(busy||closed)return;busy=true;controls();status('Applying the confirmed mask to the full-resolution source…');
      try {
        await new Promise(function(resolve){setTimeout(resolve,0);});if(closed)return;
        if(!await prepareNative())return;
        // Apply pending selection to a separate result so a rejected Apply can be corrected.
        var result=document.createElement('canvas');result.width=w;result.height=h;
        var output=new ImageData(pixels.data.slice(),w,h);
        applySelection(output.data);
        var baseline=options.canvas.getContext('2d').getImageData(0,0,w,h).data;
        if(output.data.every(function(value,index){return value===baseline[index];})){close();return;}
        result.getContext('2d').putImageData(output,0,0);
        options.apply(result);close();
      } catch(error){status(error.message,true);}
      finally{if(!closed){busy=false;controls();}}
    };
  };
})();
