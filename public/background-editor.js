/* Full-resolution edits live only in this modal until its Apply callback succeeds. */
(function(){
  'use strict';
  window.openBackgroundEditor = function(options) {
    if (document.querySelector('.bg-editor')) return;
    var w = options.canvas.width, h = options.canvas.height, count = w * h;
    var focusBefore = document.activeElement, dialog = document.createElement('dialog');
    dialog.className = 'bg-editor'; dialog.setAttribute('aria-labelledby', 'bg-title');
    dialog.innerHTML = '<header><div><span class="bg-brand">MASTER PRINTLAB · BACKGROUND STUDIO</span><h2 id="bg-title">Refine Background</h2><p class="bg-name"></p></div><button type="button" data-action="close" aria-label="Close Background Editor">Close</button></header>' +
      '<div class="bg-body"><aside class="bg-tools"><fieldset><legend>Tools</legend><button type="button" data-tool="wand" aria-pressed="true">Magic Wand</button><button type="button" data-tool="erase" aria-pressed="false">Erase Brush</button><button type="button" data-tool="restore" aria-pressed="false">Restore Brush</button><button type="button" data-tool="pan" aria-pressed="false">Pan</button></fieldset>' +
      '<fieldset><legend>Magic Wand selection</legend><label>Tolerance <output id="bg-tolerance-value">32</output><input id="bg-tolerance" type="range" min="0" max="255" value="32"></label><label><input id="bg-contiguous" type="checkbox" checked>Contiguous</label><label><input id="bg-antialias" type="checkbox" checked>Anti-alias</label><label>Selection mode<select id="bg-mode"><option value="add">Add to selection</option><option value="subtract">Subtract from selection</option></select></label><button type="button" data-action="erase-selection">Erase selection</button><button type="button" data-action="clear">Clear selection</button></fieldset>' +
      '<fieldset><legend>Brush</legend><label>Brush size (source pixels) <output id="bg-size-value">40</output><input id="bg-size" type="range" min="1" max="500" value="40"></label></fieldset>' +
      '<fieldset class="bg-advanced"><legend>Advanced cleanup</legend><label>Edge cleanup sensitivity <output id="bg-auto-tolerance-value">42</output><input id="bg-auto-tolerance" type="range" min="16" max="110" step="2" value="42"></label><button type="button" data-action="auto-edge">Auto-remove edge background</button><button type="button" data-action="tiny-specks">Remove tiny specks</button></fieldset>' +
      '<p>Cyan marks selected pixels; it is not part of the image. Click additional colors to select uneven or gradient backgrounds. Erase selection to inspect removal, then use Restore Brush to recover original pixels.</p><p id="bg-history-note"></p></aside>' +
      '<section class="bg-view" aria-label="Image editor"><div class="bg-viewbar"><button type="button" data-action="undo">Undo</button><button type="button" data-action="redo">Redo</button><button type="button" data-action="reset">Reset editor changes</button><button type="button" data-action="out" aria-label="Zoom out">−</button><output id="bg-zoom">100%</output><button type="button" data-action="in" aria-label="Zoom in">+</button><button type="button" data-action="fit">Fit</button><small id="bg-resolution"></small></div><div class="bg-viewport"><div class="bg-stage" tabindex="0" role="application" aria-label="Image editing canvas. Arrow keys move the cursor; Enter uses the selected tool. Use Pan and arrow keys to scroll."><canvas class="bg-image"></canvas><canvas class="bg-overlay"></canvas></div></div></section></div>' +
      '<footer><p class="bg-status" role="status" aria-live="polite">Select a background area to preview a selection. Changes stay here until Apply.</p><div class="bg-actions"><button type="button" data-action="cancel">Cancel</button><button type="button" data-action="apply" class="bg-primary">Apply background removal</button></div></footer>';
    var $ = function(sel){ return dialog.querySelector(sel); };
    var button = function(name){ return $('[data-action="' + name + '"]'); };
    $('#bg-tolerance').title = 'Maximum color distance from the clicked pixel. A higher value selects more similar colors.';
    $('#bg-contiguous').title = 'Select only connected colors; switch off to match similar colors throughout the canvas.';
    $('#bg-antialias').title = 'Feather the selection across near-matching colors instead of using a hard color cutoff.';
    $('#bg-size').title = 'Brush diameter measured in full-resolution image pixels, independent of view zoom.';
    $('#bg-auto-tolerance').value = String(options.autoTolerance == null ? 42 : options.autoTolerance);
    $('#bg-auto-tolerance-value').textContent = $('#bg-auto-tolerance').value;
    var stage = $('.bg-stage'), viewport = $('.bg-viewport'), display = $('.bg-image'), overlay = $('.bg-overlay');
    var cursorEl = document.createElement('span'); cursorEl.className = 'bg-cursor'; cursorEl.setAttribute('aria-hidden','true');stage.appendChild(cursorEl);
    var statusEl = $('.bg-status'), closed = false, busy = false, generation = 0, tool = 'wand', zoom = 1;
    var stroke = null, cursor = {x:Math.floor(w/2), y:Math.floor(h/2)}, frame = 0;
    var history = [], future = [], lastWand = null;
    // Fixed RGBA+selection snapshots are capped by both count and byte budget.
    var historyLimit = Math.min(16, Math.floor(48 * 1024 * 1024 / (count * 5)));
    if (historyLimit < 2) throw new Error('This image is too large for the manual editor memory budget. Use a smaller source for manual editing.');
    var scratch = display; scratch.width = w; scratch.height = h;
    var context = scratch.getContext('2d', {willReadFrequently:true});
    var pixels, original, selection = new Uint8Array(count);
    function status(message, error) { statusEl.textContent = message; statusEl.classList.toggle('error', !!error); }
    function close() {
      if (closed) return;
      closed = true; generation++; cancelAnimationFrame(frame);
      document.removeEventListener('keydown', keyboard, true);
      dialog.close(); dialog.remove();
      scratch.width = scratch.height = overlay.width = overlay.height = 0;
      pixels = original = selection = null; history = []; future = []; lastWand = null;
      if (focusBefore && focusBefore.isConnected) focusBefore.focus({preventScroll:true});
    }
    try {
      pixels = options.canvas.getContext('2d', {willReadFrequently:true}).getImageData(0,0,w,h);
      // Restore Brush maps the full untouched upload to the current crop/resolution.
      var r = options.sourceRect;
      context.drawImage(options.original, r.x,r.y,r.w,r.h, 0,0,w,h);
      original = context.getImageData(0,0,w,h);
      context.putImageData(pixels,0,0);
      $('.bg-name').textContent = options.name;
      $('#bg-resolution').textContent = w + ' × ' + h + ' px · full resolution';
      $('#bg-history-note').textContent = 'Undo history: up to ' + historyLimit + ' steps for this image. Reset returns to the image at editor opening. Print dimensions stay unchanged.';
      document.body.appendChild(dialog); dialog.showModal();
      document.addEventListener('keydown', keyboard, true);
      render(); fit(); $('[data-tool="wand"]').focus();
    } catch(error) { close(); throw error; }

    function snapshot() { return {data:pixels.data.slice(), selection:selection.slice()}; }
    function remember() {
      future = []; if (history.length >= historyLimit) history.shift();
      history.push(snapshot()); lastWand = null;
    }
    function load(state) { pixels.data.set(state.data); selection.set(state.selection); lastWand = null; render(); }
    function controls() {
      dialog.setAttribute('aria-busy', String(busy));
      dialog.querySelectorAll('button,input,select').forEach(function(el){ el.disabled = busy && el !== button('close') && el !== button('cancel'); });
      if (!busy) { button('undo').disabled = !history.length; button('redo').disabled = !future.length; }
    }
    function render() {
      if (closed) return;
      context.putImageData(pixels,0,0);
      // Artwork stays full resolution even when zoomed. Only the selection tint is scaled.
      var scale = Math.min(1, 1800 / Math.max(w,h));
      overlay.width = Math.max(1,Math.round(w*scale));
      overlay.height = Math.max(1,Math.round(h*scale));
      var ctx = overlay.getContext('2d'), mask = ctx.createImageData(overlay.width,overlay.height), n = 0;
      for (var p=0;p<count;p++) if (selection[p]) n++;
      for (var y=0;y<overlay.height;y++) for (var x=0;x<overlay.width;x++) {
        var i=(y*overlay.width+x)*4, a=selection[Math.min(h-1,Math.floor(y/scale))*w+Math.min(w-1,Math.floor(x/scale))];
        mask.data[i]=0; mask.data[i+1]=193; mask.data[i+2]=230; mask.data[i+3]=Math.round(a*.55);
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
    function eraseSelection() {
      for(var p=0;p<count;p++) pixels.data[p*4+3]=Math.round(pixels.data[p*4+3]*(1-selection[p]/255));
      selection.fill(0);lastWand=null;
    }
    function cleanup(action, label) {
      if (busy || !action) return;
      try {
        remember();
        var input = document.createElement('canvas'); input.width = w; input.height = h;
        input.getContext('2d').putImageData(pixels, 0, 0);
        var result = action(input);
        if (!result || result.noChange) { history.pop(); status('No image changes from ' + label + '.'); render(); return; }
        pixels = result.canvas.getContext('2d', {willReadFrequently:true}).getImageData(0, 0, w, h);
        selection.fill(0); lastWand = null; status(label + ' applied in the editor. Undo or Reset is available before Apply.'); render();
      } catch(error) { status(error.message, true); }
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
            for(var c=0;c<4;c++) data[i+c]=Math.round(from[i+c]*(1-amount)+original.data[i+c]*amount);
            var selectedBefore=stroke?history[history.length-1].selection[p]:selection[p];
            selection[p]=Math.round(selectedBefore*(1-amount));
          } else data[i+3]=Math.min(data[i+3],Math.round(from[i+3]*(1-amount)));
        }
      }
    }
    function paint(at) {
      var distance=Math.hypot(at.x-stroke.last.x,at.y-stroke.last.y), steps=Math.max(1,Math.ceil(distance/Math.max(.5,Number($('#bg-size').value)/5)));
      for(var s=1;s<=steps;s++) dab({x:stroke.last.x+(at.x-stroke.last.x)*s/steps,y:stroke.last.y+(at.y-stroke.last.y)*s/steps},history[history.length-1].data);
      stroke.last=at;cursor=at;queueRender();
    }
    stage.onpointerdown=function(e){
      if(busy || e.button!==0) return; e.preventDefault();stage.focus();cursor=point(e);
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
      if(e.key==='Enter'||e.key===' '){e.preventDefault();if(tool==='wand')wand(cursor);else if(tool!=='pan'){remember();dab(cursor,history[history.length-1].data);render();}}
    }
    dialog.addEventListener('cancel',function(e){e.preventDefault();close();});
    dialog.querySelectorAll('button[data-tool]').forEach(function(b){b.onclick=function(){tool=b.dataset.tool;stage.dataset.tool=tool;dialog.querySelectorAll('button[data-tool]').forEach(function(t){t.setAttribute('aria-pressed',String(t===b));});render();};});
    $('#bg-size').oninput=function(){$('#bg-size-value').textContent=this.value;drawCursor();};
    $('#bg-auto-tolerance').oninput=function(){$('#bg-auto-tolerance-value').textContent=this.value;};
    $('#bg-tolerance').oninput=function(){$('#bg-tolerance-value').textContent=this.value;};
    ['#bg-tolerance','#bg-contiguous','#bg-antialias','#bg-mode'].forEach(function(id){$(id).onchange=function(){if(lastWand)wand(lastWand.at,lastWand.base);};});
    button('close').onclick=button('cancel').onclick=close;
    button('in').onclick=function(){setZoom(zoom*1.25);};button('out').onclick=function(){setZoom(zoom/1.25);};button('fit').onclick=fit;
    button('undo').onclick=function(){if(history.length){future.push(snapshot());load(history.pop());status('Undone.');}};
    button('redo').onclick=function(){if(future.length){history.push(snapshot());load(future.pop());status('Redone.');}};
    button('reset').onclick=function(){remember();pixels=options.canvas.getContext('2d').getImageData(0,0,w,h);selection.fill(0);render();status('Returned to the image at editor opening.');};
    button('clear').onclick=function(){remember();selection.fill(0);render();status('Selection cleared.');};
    button('erase-selection').onclick=function(){remember();eraseSelection();render();status('Selected pixels erased in the editor. Restore Brush can recover them.');};
    button('auto-edge').onclick=function(){cleanup(function(canvas){ return options.autoRemove && options.autoRemove(canvas, Number($('#bg-auto-tolerance').value)); }, 'Automatic edge background cleanup');};
    button('tiny-specks').onclick=function(){cleanup(function(canvas){ return options.removeTinySpecks && options.removeTinySpecks(canvas); }, 'Tiny speck cleanup');};
    button('apply').onclick=function(){
      try {
        // Apply pending selection to a separate result so a rejected Apply can be corrected.
        var result=document.createElement('canvas');result.width=w;result.height=h;
        var output=new ImageData(pixels.data.slice(),w,h);
        for(var p=0;p<count;p++) output.data[p*4+3]=Math.round(output.data[p*4+3]*(1-selection[p]/255));
        var baseline=options.canvas.getContext('2d').getImageData(0,0,w,h).data;
        if(output.data.every(function(value,index){return value===baseline[index];})){close();return;}
        result.getContext('2d').putImageData(output,0,0);
        options.apply(result);close();
      } catch(error){status(error.message,true);}
    };
  };
})();
