/* Local, full-resolution print preparation. No network or AI service. */
(function(){
  'use strict';
  function bounds(data,w,h) {
    var b={x:w,y:h,right:-1,bottom:-1};
    for(var p=0;p<w*h;p++) if(data[p*4+3]) {
      var x=p%w,y=Math.floor(p/w); b.x=Math.min(b.x,x);b.y=Math.min(b.y,y);b.right=Math.max(b.right,x);b.bottom=Math.max(b.bottom,y);
    }
    if(b.right<0) throw new Error('The image is completely transparent.');
    b.w=b.right-b.x+1;b.h=b.bottom-b.y+1;return b;
  }
  function canvasFrom(image) {
    var c=document.createElement('canvas');c.width=image.width;c.height=image.height;c.getContext('2d').putImageData(image,0,0);return c;
  }
  var MEMORY_LIMIT=256*1024*1024,MAX_PIXELS=16*1024*1024;
  function estimateMemory(w,h,strength,factor,forced) {
    factor=factor||1;var n=w*h,ow=Math.round(w*factor),oh=Math.round(h*factor),m=ow*oh;
    // Per-card peak, including the borrowed active canvas. Other cards and
    // export sheets are not working buffers for this operation.
    // Dot classification: source + RGBA + visited byte + uint32 queue (13N).
    // Fringe classification: active + dot candidate + immutable RGBA (12N),
    // shared flags + distance + queue (6N). Queue/distance are released before
    // creating the striped output canvas, so they are not counted together.
    var cleanup=n*(strength==='safe'?13:18);
    // Resampling: active + cleanup + source RGBA (12N), output RGBA + canvas
    // (8M), four Float32 horizontal rows and one output/refinement stripe.
    var resampling=factor>1?12*n+8*m+ow*(4*4*4+128*4)+2*1024*1024:0;
    // 8 MiB bounded comparison rasters, stripe readback and 16 MiB headroom.
    return {bytes:Math.max(cleanup,resampling)+24*1024*1024,w:w,h:h,ow:ow,oh:oh,
      mode:forced?'Force smooth enhance':factor>1?'Optional smooth upscale':({safe:'Safe',balanced:'Balanced',strong:'Strong'}[strength]||'Balanced')+' edge cleanup'};
  }
  function checkMemory(w,h,strength,factor,forced) {
    var estimate=estimateMemory(w,h,strength,factor,forced);
    if(w>8192||h>8192||estimate.ow>8192||estimate.oh>8192||w*h>MAX_PIXELS||estimate.ow*estimate.oh>MAX_PIXELS||estimate.bytes>MEMORY_LIMIT){
      throw new Error(estimate.mode+' cannot process '+w+' × '+h+' px'+(factor>1?' at '+factor+'× ('+estimate.ow+' × '+estimate.oh+' px)':'')+
        ': estimated peak '+Math.ceil(estimate.bytes/1048576)+' MiB; limit 256 MiB, 16,777,216 pixels and 8192 px per side. '+
        (factor>1?'Turn off optional enhancement to retry cleanup at the original resolution.':'Use a smaller original file, or cancel to keep this image unchanged.'));
    }
    return estimate;
  }
  function releaseCanvas(canvas,original){if(canvas&&canvas!==original){canvas.width=0;canvas.height=0;}}
  // Eight-connected components preserve diagonals, thin lines, and every soft
  // pixel connected to artwork. Only isolated dots (up to four pixels) well
  // outside the union of larger components are candidates. No alpha threshold.
  async function clean(source,cancelled) {
    var w=source.width,h=source.height,n=w*h;
    var image=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h),data=image.data;
    var seen=new Uint8Array(n),queue=new Uint32Array(n),dots=[];
    var core={x:w,y:h,right:-1,bottom:-1},removed=0;
    for(var p=0;p<n;p++) {
      if(p%65536===0) { await new Promise(function(r){setTimeout(r,0);});if(cancelled&&cancelled())throw new Error('Cancelled.'); }
      if(seen[p]||!data[p*4+3]) continue;
      var end=1;queue[0]=p;seen[p]=1;
      var box={x:w,y:h,right:-1,bottom:-1};
      for(var start=0;start<end;start++) {
        var cur=queue[start],x=cur%w,y=Math.floor(cur/w);
        box.x=Math.min(box.x,x);box.y=Math.min(box.y,y);box.right=Math.max(box.right,x);box.bottom=Math.max(box.bottom,y);
        for(var dy=-1;dy<=1;dy++) for(var dx=-1;dx<=1;dx++) {
          var nx=x+dx,ny=y+dy,next=ny*w+nx;
          if(nx>=0&&nx<w&&ny>=0&&ny<h&&!seen[next]&&data[next*4+3]){seen[next]=1;queue[end++]=next;}
        }
        if(start && start%65536===0) { await new Promise(function(r){setTimeout(r,0);});if(cancelled&&cancelled())throw new Error('Cancelled.'); }
      }
      if(end<=4 && box.right-box.x<=1 && box.bottom-box.y<=1) dots.push(Array.from(queue.subarray(0,end)));
      else {core.x=Math.min(core.x,box.x);core.y=Math.min(core.y,box.y);core.right=Math.max(core.right,box.right);core.bottom=Math.max(core.bottom,box.bottom);}
      // A field of thousands of detached details may be intentional texture.
      // Preserve it and bound component bookkeeping rather than guessing.
      if(dots.length>=10000)return {canvas:source,removed:0,bounds:bounds(data,w,h),skipped:true};
    }
    var margin=Math.max(3,Math.ceil(Math.min(w,h)*.02));
    if(core.right>=0) dots.forEach(function(dot){
      if(dot.every(function(p){var x=p%w,y=Math.floor(p/w);return x<core.x-margin||x>core.right+margin||y<core.y-margin||y>core.bottom+margin;})) {
        dot.forEach(function(p){data.fill(0,p*4,p*4+4);removed++;});
      }
    });
    var activeBounds=bounds(data,w,h);
    seen=null;queue=null;dots=null;
    return {canvas:removed?canvasFrom(image):source,removed:removed,bounds:activeBounds};
  }
  // Source-pixel exterior rings, not a global alpha cutoff. Balanced widens
  // matte detection; Strong also attenuates broad low-alpha blur tails.
  async function cleanFringe(source,cancelled,strength) {
    strength=['safe','balanced','strong'].includes(strength)?strength:'balanced';
    var strong=strength==='strong',cfg=strong?
      {radius:14,maxAlpha:208,agreement:48,contrast:24,mix:.2,residual:32,slop:12,removeAlpha:64,retain:.1}:
      {radius:8,maxAlpha:160,agreement:40,contrast:36,mix:.35,residual:24,slop:4,removeAlpha:24,retain:.25};
    var w=source.width,h=source.height,n=w*h;
    var original=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h),data=original.data;
    if(strength==='safe'){
      var count=0;for(var p=0;p<n;p++)if(data[p*4+3])count++;
      return {canvas:source,cleaned:0,removed:0,reduced:0,before:count,after:count,strength:strength};
    }
    var seen=new Uint8Array(n),distance=new Uint8Array(n),queue=new Uint32Array(n);
    var end=0,cleaned=0,removed=0,reduced=0,before=0;
    async function pause(){await new Promise(function(r){setTimeout(r,0);});if(cancelled&&cancelled())throw new Error('Cancelled.');}
    function visit(p){if(!seen[p]&&data[p*4+3]===0){seen[p]=1;queue[end++]=p;}}
    function neighbors(p,fn){var x=p%w,y=Math.floor(p/w);for(var dy=-1;dy<=1;dy++)for(var dx=-1;dx<=1;dx++){var nx=x+dx,ny=y+dy;if((dx||dy)&&nx>=0&&nx<w&&ny>=0&&ny<h)fn(ny*w+nx);}}
    // Exterior transparency only: enclosed transparent holes are not seeds.
    for(var x=0;x<w;x++){visit(x);visit((h-1)*w+x);}
    for(var y=0;y<h;y++){visit(y*w);visit(y*w+w-1);}
    for(var start=0;start<end;start++){neighbors(queue[start],visit);if(start%65536===0)await pause();}
    // Exact capped Chebyshev distance to strong alpha, with two linear sweeps.
    // Balanced protects broad shadow components; a few distant connected
    // outliers no longer veto cleanup around an otherwise supported edge.
    for(var p=0;p<n;p++){distance[p]=data[p*4+3]>=240?0:cfg.radius+1;if(data[p*4+3])before++;}
    for(var y=0;y<h;y++){
      for(var x=0;x<w;x++){var p=y*w+x,d=distance[p];if(x)d=Math.min(d,distance[p-1]+1);if(y){d=Math.min(d,distance[p-w]+1);if(x)d=Math.min(d,distance[p-w-1]+1);if(x+1<w)d=Math.min(d,distance[p-w+1]+1);}distance[p]=d;}
      if(y%128===0)await pause();
    }
    for(var y=h-1;y>=0;y--){
      for(var x=w-1;x>=0;x--){var p=y*w+x,d=distance[p];if(x+1<w)d=Math.min(d,distance[p+1]+1);if(y+1<h){d=Math.min(d,distance[p+w]+1);if(x)d=Math.min(d,distance[p+w-1]+1);if(x+1<w)d=Math.min(d,distance[p+w+1]+1);}distance[p]=d;}
      if(y%128===0)await pause();
    }
    function reference(p){
      var x=p%w,y=Math.floor(p/w),alpha=data[p*4+3],best=null,bestStep=cfg.radius+1;
      // Follow a rising-alpha ray into a coherent 2x2 opaque neighborhood.
      // Thin lines and pixels across a transparent gap cannot provide support.
      for(var dy=-1;dy<=1;dy++)for(var dx=-1;dx<=1;dx++){
        if(!dx&&!dy)continue;var last=alpha;
        for(var step=1;step<bestStep;step++){
          var nx=x+dx*step,ny=y+dy*step;if(nx<0||nx>=w||ny<0||ny>=h)break;
          var at=(ny*w+nx)*4,a=data[at+3];if(!a||a+cfg.slop<last)break;last=Math.max(last,a);if(a<240)continue;
          var found=false;
          for(var sy=-1;sy<=1&&!found;sy+=2)for(var sx=-1;sx<=1&&!found;sx+=2){
            if(nx+sx<0||nx+sx>=w||ny+sy<0||ny+sy>=h)continue;
            var support=[at,at+sx*4,at+sy*w*4,at+(sy*w+sx)*4];
            if(support.some(function(i){return data[i+3]<240||Math.max(Math.abs(data[i]-data[at]),Math.abs(data[i+1]-data[at+1]),Math.abs(data[i+2]-data[at+2]))>cfg.agreement;}))continue;
            var ref=[0,0,0];support.forEach(function(i){for(var c=0;c<3;c++)ref[c]+=data[i+c]/4;});
            best=ref;bestStep=step;found=true;
          }
          break;
        }
      }
      return best;
    }
    // Protect narrow ridges and their colored antialiasing (1–3px lines/text).
    // A true exterior fade rises inward; a thin feature falls on BOTH sides.
    function fineFeature(p){
      var x=p%w,y=Math.floor(p/w),at=p*4;
      for(var oy=-1;oy<=1;oy++)for(var ox=-1;ox<=1;ox++){
        var nx=x+ox,ny=y+oy;if(nx<0||nx>=w||ny<0||ny>=h)continue;
        var i=(ny*w+nx)*4,a=data[i+3];
        if(a<data[at+3]||Math.max(Math.abs(data[i]-data[at]),Math.abs(data[i+1]-data[at+1]),Math.abs(data[i+2]-data[at+2]))>24)continue;
        for(var dir of [[1,0],[0,1],[1,1],[1,-1]]){
          var x1=nx-dir[0]*2,y1=ny-dir[1]*2,x2=nx+dir[0]*2,y2=ny+dir[1]*2;
          var a1=x1<0||x1>=w||y1<0||y1>=h?0:data[(y1*w+x1)*4+3];
          var a2=x2<0||x2>=w||y2<0||y2>=h?0:data[(y2*w+x2)*4+3];
          if(a1<a-Math.max(8,a*.1)&&a2<a-Math.max(8,a*.1)){
            // A blurry corner can also look like a local ridge. A real thin
            // line must continue with similar color/coverage along its axis.
            var run=0;
            for(var sign of [-1,1])for(var k=1;k<=4;k++){
              var tx=nx-dir[1]*k*sign,ty=ny+dir[0]*k*sign;
              if(tx<0||tx>=w||ty<0||ty>=h)break;
              var t=(ty*w+tx)*4;
              if(data[t+3]<a*.7||data[t+3]>a*1.3||Math.max(Math.abs(data[t]-data[i]),Math.abs(data[t+1]-data[i+1]),Math.abs(data[t+2]-data[i+2]))>24)break;
              run++;
            }
            if(run>=4)return true;
          }
        }
      }
      return false;
    }
    function matteMatch(p,ref){
      var color=[data[p*4],data[p*4+1],data[p*4+2]];
      if(Math.max.apply(null,color.map(function(v,c){return Math.abs(v-ref[c]);}))<cfg.contrast)return false;
      var chroma=Math.max.apply(null,color)-Math.min.apply(null,color),refChroma=Math.max.apply(null,ref)-Math.min.apply(null,ref);
      // Also admit a mildly tinted matte, not just mathematically neutral RGB.
      if(chroma<=cfg.residual*2&&refChroma>=chroma+48)return true;
      return [0,128,255].some(function(matte){
        var v=ref.map(function(c){return matte-c;}),den=v.reduce(function(s,c){return s+c*c;},0);
        var mix=color.reduce(function(s,c,i){return s+(c-ref[i])*v[i];},0)/den;
        return mix>=cfg.mix&&mix<=1.1&&color.every(function(c,i){return Math.abs(c-(ref[i]+Math.min(1,mix)*v[i]))<=cfg.residual;});
      });
    }
    for(var seed=0;seed<n;seed++){
      if(seed%65536===0)await pause();
      var alpha=data[seed*4+3];if(seen[seed]||!alpha||alpha>cfg.maxAlpha)continue;
      end=1;queue[0]=seed;seen[seed]=2;var exterior=false,wide=0;
      for(var start=0;start<end;start++){
        var p=queue[start];if(distance[p]>cfg.radius)wide++;
        if(p<w||p>=n-w||p%w===0||p%w===w-1)exterior=true;
        neighbors(p,function(next){if(seen[next]===1)exterior=true;var a=data[next*4+3];if(!seen[next]&&a>0&&a<=cfg.maxAlpha){seen[next]=2;queue[end++]=next;}});
        if(start%65536===0)await pause();
      }
      if(!exterior||(!strong&&wide>end*.15))continue;
      var matches=0;
      for(var i=0;i<end;i++){
        var p=queue[i];
        if(distance[p]<=cfg.radius&&!fineFeature(p)){
          var ref=reference(p);
          var tail=strong&&distance[p]>=4&&data[p*4+3]<=64&&ref&&ref.every(function(c,k){return Math.abs(data[p*4+k]-c)<=32;});
          if(ref&&(matteMatch(p,ref)||tail)){seen[p]|=4;matches++;}
        }
        if(i%16384===0)await pause();
      }
      // Isolated low-alpha highlights are too ambiguous for automatic removal.
      if(matches<3)continue;
      for(var i=0;i<end;i++){
        var p=queue[i];if(!(seen[p]&4))continue;
        seen[p]|=8;
        if(data[p*4+3]<=cfg.removeAlpha||(strong&&distance[p]>=4)){seen[p]|=16;removed++;}else reduced++;
        cleaned++;if(i%16384===0)await pause();
      }
    }
    // Classification is complete before writing any pixels. Stream output in
    // stripes from the same immutable source, preserving cross-stripe support.
    var output=null;
    try {
      queue=null;distance=null;
      if(cleaned){
        output=document.createElement('canvas');output.width=w;output.height=h;
        var ctx=output.getContext('2d');
        for(var y=0;y<h;y+=128){
          var rows=Math.min(128,h-y),stripe=new ImageData(new Uint8ClampedArray(data.subarray(y*w*4,(y+rows)*w*4)),w,rows);
          for(var p=y*w;p<(y+rows)*w;p++)if(seen[p]&8){
            var at=(p-y*w)*4,ref=reference(p);
            // The removal decision was retained in the shared flag byte.
            if(seen[p]&16)stripe.data.fill(0,at,at+4);
            else {stripe.data[at+3]=Math.round(data[p*4+3]*cfg.retain);for(var c=0;c<3;c++)stripe.data[at+c]=Math.round(ref[c]);}
          }
          ctx.putImageData(stripe,0,y);stripe=null;await pause();
        }
      }
      return {canvas:output||source,cleaned:cleaned,removed:removed,reduced:reduced,before:before,after:before-removed,strength:strength};
    }catch(error){releaseCanvas(output,source);throw error;}
  }
  async function prepare(source,cancelled,strength){
    var dots=await clean(source,cancelled),edge;
    try {edge=await cleanFringe(dots.canvas,cancelled,strength);return {canvas:edge.canvas,removed:dots.removed,skipped:dots.skipped,fringe:edge};}
    finally {if(!edge||edge.canvas!==dots.canvas)releaseCanvas(dots.canvas,source);}
  }
  function analyze(source,widthIn,heightIn,nativeScale) {
    if(!Number.isFinite(widthIn)||!Number.isFinite(heightIn)||widthIn<=0||heightIn<=0)throw new Error('Enter a valid print width and height before optimizing.');
    var b={x:source.width,y:source.height,right:-1,bottom:-1};
    for(var y=0;y<source.height;y+=128){
      var rows=Math.min(128,source.height-y),data=source.getContext('2d',{willReadFrequently:true}).getImageData(0,y,source.width,rows).data;
      for(var p=0;p<source.width*rows;p++)if(data[p*4+3]){var x=p%source.width,py=y+Math.floor(p/source.width);b.x=Math.min(b.x,x);b.y=Math.min(b.y,py);b.right=Math.max(b.right,x);b.bottom=Math.max(b.bottom,py);}
    }
    if(b.right<0)throw new Error('The image is completely transparent.');
    b.w=b.right-b.x+1;b.h=b.bottom-b.y+1;
    // Artwork occupies this fraction of the selected canvas print size. Empty
    // margins do not invent extra available detail or silently change sizing.
    var physical={w:widthIn*b.w/source.width,h:heightIn*b.h/source.height};
    return {bounds:b,physical:physical,ppi:Math.min(b.w/physical.w,b.h/physical.h)/(nativeScale||1),rasterPpi:Math.min(source.width/widthIn,source.height/heightIn)};
  }
  function lanczos(x) { x=Math.abs(x);if(x===0)return 1;if(x>=2)return 0;return Math.sin(Math.PI*x)*Math.sin(Math.PI*x/2)/(Math.PI*Math.PI*x*x/2); }
  function weights(size,out) {
    return Array.from({length:out},function(_,i){
      var pos=(i+.5)*size/out-.5,result=[],sum=0;
      for(var k=Math.floor(pos)-1;k<=Math.floor(pos)+2;k++){var weight=lanczos(pos-k);sum+=weight;result.push([Math.max(0,Math.min(size-1,k)),weight]);}
      result.forEach(function(v){v[1]/=sum;});return result;
    });
  }
  async function upscale(source,factor,progress,cancelled) {
    var w=source.width,h=source.height,ow=Math.round(w*factor),oh=Math.round(h*factor);
    if(factor<=1||factor>2)throw new Error('Smooth upscale supports factors above 1 and at most 2×.');
    checkMemory(w,h,'balanced',factor,false);
    var data=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data;
    var horizontal=new Map(),wx=weights(w,ow),wy=weights(h,oh);
    // Premultiplied alpha prevents hidden black/white RGB from bleeding into
    // colored edges. Filter color and alpha together, then unpremultiply once.
    function horizontalRow(y) {
      if(horizontal.has(y))return horizontal.get(y);
      var row=new Float32Array(ow*4);
      for(var x=0;x<ow;x++) {
        var at=x*4;
        wx[x].forEach(function(v){var i=(y*w+v[0])*4,a=data[i+3]/255;row[at]+=data[i]*a*v[1];row[at+1]+=data[i+1]*a*v[1];row[at+2]+=data[i+2]*a*v[1];row[at+3]+=data[i+3]*v[1];});
      }
      horizontal.set(y,row);return row;
    }
    var output=new ImageData(ow,oh);
    for(var y=0;y<oh;y++) {
      // Retain only the four source rows supporting this output row. The
      // weights, Float32 rounding and summation order are unchanged.
      var needed=new Set(wy[y].map(function(v){return v[0];}));
      horizontal.forEach(function(_,key){if(!needed.has(key))horizontal.delete(key);});
      var support=wy[y].map(function(v){return [horizontalRow(v[0]),v[1]];});
      for(var x=0;x<ow;x++) {
        var values=[0,0,0,0],at=(y*ow+x)*4;
        support.forEach(function(v){var i=x*4;for(var c=0;c<4;c++)values[c]+=v[0][i+c]*v[1];});
        var alpha=Math.max(0,Math.min(255,values[3]));output.data[at+3]=alpha;
        if(output.data[at+3]) for(var c=0;c<3;c++)output.data[at+c]=Math.max(0,Math.min(255,values[c]*255/Math.max(.0001,values[3])));
      }
      if(y%32===0){if(progress)progress('Smooth upscale: '+Math.round(y/oh*100)+'%');await new Promise(function(r){setTimeout(r,0);});}
      if(cancelled&&cancelled())throw new Error('Cancelled.');
    }
    horizontal.clear();data=null;return canvasFrom(output);
  }
  // Opt-in only. Auto runs native-resolution cleanup without this resampler.
  async function forceEnhance(source,progress,cancelled) {
    checkMemory(source.width,source.height,'balanced',2,true);
    var result=await upscale(source,2,progress,cancelled),w=source.width,h=source.height,ow=result.width,oh=result.height;
    var finalCanvas=null,complete=false;
    try {
    var input=source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data;
    var image=result.getContext('2d',{willReadFrequently:true}).getImageData(0,0,ow,oh),data=image.data;
    releaseCanvas(result,source);result=null;
    // Constrain Lanczos lobes to the local source envelope. Transparent RGB is
    // never a color reference; alpha cannot ring beyond the adjacent coverage.
    for(var y=0;y<oh;y++){
      for(var x=0;x<ow;x++){
        var sx=Math.floor((x+.5)/2-.5),sy=Math.floor((y+.5)/2-.5),lo=[255,255,255,255],hi=[0,0,0,0],at=(y*ow+x)*4,visible=false;
        for(var dy=0;dy<2;dy++)for(var dx=0;dx<2;dx++){
          var i=(Math.max(0,Math.min(h-1,sy+dy))*w+Math.max(0,Math.min(w-1,sx+dx)))*4;
          lo[3]=Math.min(lo[3],input[i+3]);hi[3]=Math.max(hi[3],input[i+3]);
          if(input[i+3]){visible=true;for(var c=0;c<3;c++){lo[c]=Math.min(lo[c],input[i+c]);hi[c]=Math.max(hi[c],input[i+c]);}}
        }
        data[at+3]=Math.max(lo[3],Math.min(hi[3],data[at+3]));
        for(var c=0;c<3;c++)data[at+c]=visible&&data[at+3]?Math.max(lo[c],Math.min(hi[c],data[at+c])):0;
      }
      if(y%64===0){if(progress)progress('Constraining edge overshoot: '+Math.round(y/oh*100)+'%');await new Promise(function(r){setTimeout(r,0);});if(cancelled&&cancelled())throw new Error('Cancelled.');}
    }
    input=null;
    var snapshot=data;
    finalCanvas=document.createElement('canvas');finalCanvas.width=ow;finalCanvas.height=oh;
    var finalContext=finalCanvas.getContext('2d',{willReadFrequently:true});
    // Bounded unsharp refinement, only in low-contrast fully opaque interiors.
    // Never sharpen alpha or transparent/colored high-contrast boundaries.
    for(var top=0;top<oh;top+=128){
      var rows=Math.min(128,oh-top),stripe=new ImageData(new Uint8ClampedArray(snapshot.subarray(top*ow*4,(top+rows)*ow*4)),ow,rows);
    for(var y=Math.max(1,top);y<Math.min(oh-1,top+rows);y++){
      for(var x=1;x<ow-1;x++){
        var at=(y*ow+x)*4,lo=[255,255,255],hi=[0,0,0],sum=[0,0,0],safe=true;
        for(var dy=-1;dy<=1;dy++)for(var dx=-1;dx<=1;dx++){
          var i=((y+dy)*ow+x+dx)*4;if(snapshot[i+3]!==255)safe=false;
          for(var c=0;c<3;c++){lo[c]=Math.min(lo[c],snapshot[i+c]);hi[c]=Math.max(hi[c],snapshot[i+c]);sum[c]+=snapshot[i+c];}
        }
        if(safe&&hi.every(function(v,c){return v-lo[c]<=24;}))for(var c=0;c<3;c++){
          var delta=Math.max(-2,Math.min(2,.12*(snapshot[at+c]-sum[c]/9)));
          stripe.data[at-top*ow*4+c]=Math.max(lo[c],Math.min(hi[c],snapshot[at+c]+delta));
        }
      }
      if(y%64===0){if(progress)progress('Mild edge refinement: '+Math.round(y/oh*100)+'%');await new Promise(function(r){setTimeout(r,0);});if(cancelled&&cancelled())throw new Error('Cancelled.');}
    }
      finalContext.putImageData(stripe,0,top);stripe=null;
    }
    // Keep the candidate readback stable across comparison and Apply.
    complete=true;return finalCanvas;
    } finally {releaseCanvas(result,source);if(!complete)releaseCanvas(finalCanvas,source);}
  }
  async function open(options) {
    if(document.querySelector('.print-optimizer'))return;
    var prior=document.activeElement,dialog=document.createElement('dialog'),closed=false,candidate=null,cleanup=null,info=null,factor=1,changed=false,busy=true;
    var original=options.canvas;
    dialog.className='print-optimizer';dialog.setAttribute('aria-label','Optimize for Print');
    dialog.innerHTML=[
      '<header><h2>Optimize for Print</h2><button type="button" data-close aria-label="Close print optimizer">×</button></header>',
      '<p class="print-result" role="status">Analyzing full-resolution artwork…</p>',
      '<label class="print-edge-strength">Edge cleanup strength <select data-edge-strength aria-describedby="print-edge-hint" disabled><option value="safe">Safe</option><option value="balanced" selected>Balanced</option><option value="strong">Strong</option></select></label>',
      '<p id="print-edge-hint">Safe: isolated dots only. Balanced: likely connected edge halo. Strong: tighter blur/matte cleanup; may reduce soft outer shadows.</p>',
      '<label class="print-edge-strength">Image enhancement <select data-enhancement disabled><option value="auto" selected>Auto / Print-safe</option><option value="force">Force smooth enhance</option></select></label>',
      '<p>Smooth enhancement improves jagged edges but cannot recreate lost original detail.</p>',
      '<p>Auto / Print-safe keeps the active source resolution. Only Force smooth enhance creates a 2× working image.</p>',
      '<p class="print-detail">Scroll or drag to pan both views. Hover or tap to inspect matching pixels; press Enter in a pane to inspect its center. Zoom uses optimized pixels, aligned to the same print area. Smooth upscale does not restore lost detail.</p>',
      '<div class="print-toolbar"><div role="group" aria-label="Comparison mode"><button type="button" data-mode="side" aria-pressed="true">Side by side</button><button type="button" data-mode="swipe" aria-pressed="false">Swipe compare</button></div><div role="group" aria-label="Preview zoom"><button type="button" data-fit aria-pressed="true">Fit</button><button type="button" data-inspect="1" aria-pressed="false">100%</button><button type="button" data-inspect="2" aria-pressed="false">200%</button><button type="button" data-inspect="4" aria-pressed="false">400%</button></div></div>',
      '<div class="print-comparison"></div>',
      '<footer><button type="button" data-undo>Undo last optimization</button><button type="button" data-retry hidden>Retry optimization</button><button type="button" data-cancel>Cancel</button><button type="button" data-apply disabled>Apply optimization</button></footer>'
    ].join('');
    var $=function(s){return dialog.querySelector(s);},status=$('.print-result'),apply=$('[data-apply]'),strength=$('[data-edge-strength]'),enhancement=$('[data-enhancement]');
    var comparison=createComparison($('.print-comparison'));
    var adopted=false;
    function discard(){
      var owned=new Set([candidate,cleanup&&cleanup.canvas,cleanup&&cleanup.fringe.canvas]);
      owned.forEach(function(c){if(!(adopted&&c===candidate))releaseCanvas(c,original);});
      candidate=null;cleanup=null;
    }
    function close(){closed=true;comparison.destroy();if(!busy)discard();dialog.close();dialog.remove();if(prior&&prior.isConnected)prior.focus({preventScroll:true});}
    function cancelled(){return closed;}
    function message(text){if(!closed)status.textContent=text;}
    function sourceSummary(){return (info.ppi<300?'Low source quality: ':'Print-ready: effective source ')+Math.round(info.ppi)+' PPI.'+(info.ppi>=300?' No upscale needed.':' A higher-resolution original gives better detail.');}
    function summary(){
      var result=changed?'Optimized preview: '+(factor>1?'smooth upscale '+Number(factor.toFixed(2))+'× · ':'')+cleanup.removed+' isolated outer ghost pixels removed.':'No visual change required. This mode produced no pending image changes.';
      if(enhancement.value==='force')result='Forced smooth enhancement applied · 2× working resolution · mild edge refinement. '+cleanup.removed+' isolated outer ghost pixels removed. Effective source '+Math.round(info.ppi)+' PPI; interpolation adds no original detail.';
      else result+=' '+sourceSummary();
      var label={safe:'Safe',balanced:'Balanced',strong:'Strong'}[cleanup.fringe.strength];
      result+=' '+label+' edge cleanup: '+cleanup.fringe.cleaned+' outer fringe pixels cleaned.';
      if(cleanup.fringe.strength==='safe')result+=' Safe checks isolated dots only.';
      else if(!cleanup.fringe.cleaned)result+=' No removable edge fringe detected in this mode.';
      if(cleanup.skipped)result+=' Dense detached detail preserved.';
      if(enhancement.value==='auto')result+=' Native resolution retained.';
      return result;
    }
    function ready(){busy=false;strength.disabled=false;enhancement.disabled=false;apply.disabled=false;apply.textContent=changed?'Apply optimization':'Close — no changes';message(summary());}
    async function regenerateCleanup(){
      busy=true;changed=false;apply.disabled=true;apply.textContent='Apply optimization';strength.disabled=true;enhancement.disabled=true;
      $('[data-retry]').hidden=true;comparison.clear();discard();
      try {
        if(!Number.isFinite(options.widthIn)||!Number.isFinite(options.heightIn)||options.widthIn<=0||options.heightIn<=0)throw new Error('Enter a valid print width and height before optimizing.');
        // Auto never resamples, even at low effective PPI. Enhancement requires
        // the explicit Force choice and always starts from this session's source.
        factor=enhancement.value==='force'?2:1;
        var estimate=checkMemory(original.width,original.height,strength.value,factor,enhancement.value==='force');
        dialog.dataset.estimatedPeakBytes=estimate.bytes;
        message('Preparing '+strength.options[strength.selectedIndex].text+' edge cleanup at '+original.width+' × '+original.height+' px…');
        // Every mode starts from the session original, never from a previously
        // cleaned preview. Switching strengths cannot accumulate erasure.
        cleanup=await prepare(original,cancelled,strength.value);if(closed)return;
        info=analyze(cleanup.canvas,options.widthIn,options.heightIn,options.nativeScale);
        candidate=cleanup.canvas;
        if(factor>1){
          candidate=await forceEnhance(cleanup.canvas,message,cancelled);
          releaseCanvas(cleanup.canvas,original);cleanup.canvas=candidate;cleanup.fringe.canvas=candidate;
        }
        if(closed)return;
        changed=!(await samePreviewPixels(original,candidate,cancelled));if(closed)return;
        comparison.setImages(original,candidate);ready();
      }catch(error){
        discard();comparison.clear();
        if(!closed){busy=false;strength.disabled=false;enhancement.disabled=false;
          apply.disabled=true;$('[data-retry]').hidden=false;
          message('Optimization failed: '+error.message+' Nothing was applied. Retry, change the selected option, or Cancel.');}
      }finally{if(closed){busy=false;discard();}}
    }
    $('[data-close]').onclick=$('[data-cancel]').onclick=close;
    dialog.oncancel=function(e){e.preventDefault();close();};
    dialog.onkeydown=function(e){if(e.key==='Tab'){var list=Array.from(dialog.querySelectorAll('button,input,select,[tabindex="0"]')).filter(function(el){return !el.disabled&&el.getClientRects().length;});if(e.shiftKey&&document.activeElement===list[0]){e.preventDefault();list[list.length-1].focus();}else if(!e.shiftKey&&document.activeElement===list[list.length-1]){e.preventDefault();list[0].focus();}}};
    dialog.querySelectorAll('[data-fit],[data-inspect]').forEach(function(button){button.onclick=function(){comparison.setZoom(Number(button.dataset.inspect)||0);dialog.querySelectorAll('[data-fit],[data-inspect]').forEach(function(b){b.setAttribute('aria-pressed',String(b===button));});};});
    dialog.querySelectorAll('[data-mode]').forEach(function(button){button.onclick=function(){comparison.setMode(button.dataset.mode);dialog.querySelectorAll('[data-mode]').forEach(function(b){b.setAttribute('aria-pressed',String(b===button));});};});
    $('[data-undo]').disabled=!options.canUndo;
    $('[data-undo]').onclick=function(){options.undo();close();};
    enhancement.onchange=regenerateCleanup;
    strength.onchange=regenerateCleanup;
    $('[data-retry]').onclick=regenerateCleanup;
    apply.onclick=function(){if(busy||apply.disabled)return;if(changed){options.apply(candidate,factor,cleanup.removed,summary());adopted=true;}close();};
    document.body.appendChild(dialog);dialog.showModal();$('[data-close]').focus();
    await regenerateCleanup();
  }
  // UI only: both rasters keep their own pixels. Geometry is normalized to the
  // candidate's pixel grid so images with different resolutions align in print.
  function createComparison(root) {
    root.innerHTML=['<section class="print-before"><h3><span>Original <small data-original-size></small></span><span class="print-swipe-label">Optimized preview <small data-swipe-size></small></span></h3><div class="print-viewport" tabindex="0" role="region" aria-label="Original image; drag or use arrow keys to pan"><div class="print-surface"><canvas class="print-image"></canvas></div></div></section>',
      '<section class="print-after"><h3>Optimized preview <small data-candidate-size></small></h3><div class="print-viewport" tabindex="0" role="region" aria-label="Optimized preview; pan linked to original"><div class="print-surface"><canvas class="print-image"></canvas></div></div></section>',
      '<div class="print-divider" role="slider" tabindex="0" aria-label="Swipe comparison divider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span>↔</span></div>'].join('');
    var panes=Array.from(root.querySelectorAll('.print-viewport')),surfaces=Array.from(root.querySelectorAll('.print-surface')),canvases=Array.from(root.querySelectorAll('.print-image'));
    var divider=root.querySelector('.print-divider'),images=null,zoom=0,scale=1,split=50,mode='side',point=null,drag=null,closed=false,scrollLock=false,layout=[];
    var lenses=panes.map(function(p){var lens=document.createElement('div');lens.className='print-lens';lens.hidden=true;lens.innerHTML='<canvas width="128" height="128"></canvas><output></output>';p.parentNode.appendChild(lens);return lens;});
    function activePanes(){return mode==='swipe'?[panes[0]]:panes;}
    function clip(){
      if(mode!=='swipe'||!images)return;
      var p=panes[0];
      // Complementary clips are essential: a transparent optimized pixel must
      // reveal the checkerboard, never the original pixel underneath it.
      canvases.forEach(function(c,i){var width=parseFloat(c.style.width),left=p.scrollLeft+p.clientWidth*split/100-parseFloat(c.style.left||0),cut=Math.max(0,Math.min(width,left));c.style.clipPath=i?'inset(0 0 0 '+cut+'px)':'inset(0 '+(width-cut)+'px 0 0)';});
      divider.style.left=(p.offsetLeft+p.clientWidth*split/100)+'px';divider.style.top=p.offsetTop+'px';divider.style.height=p.clientHeight+'px';
      divider.setAttribute('aria-valuenow',String(Math.round(split)));
    }
    function hideLens(){point=null;lenses.forEach(function(l){l.hidden=true;});}
    function inspect(u,v){
      if(!images||u<0||v<0||u>1||v>1){hideLens();return;}
      point={u:u,v:v};
      lenses.forEach(function(l,i){
        var viewport=mode==='swipe'?panes[0]:panes[i],c=canvases[i],display=canvases[0];
        var px=layout[i].left+u*layout[i].width-viewport.scrollLeft;
        var py=layout[i].top+v*layout[i].height-viewport.scrollTop;
        // In swipe mode the two lenses sit together inside the visible pane.
        if(mode==='swipe'&&l.parentNode!==panes[0].parentNode)panes[0].parentNode.appendChild(l);
        if(mode==='side'&&l.parentNode!==panes[i].parentNode)panes[i].parentNode.appendChild(l);
        var size=Math.min(128,Math.max(64,viewport.clientWidth/2-12),Math.max(64,viewport.clientHeight-28));
        l.style.width=size+'px';
        l.style.left=(viewport.offsetLeft+Math.max(0,Math.min(viewport.clientWidth-size,px-size/2+(mode==='swipe'?(i?size/2+4:-size/2-4):0))))+'px';
        l.style.top=(viewport.offsetTop+Math.max(0,Math.min(viewport.clientHeight-size-22,py-size/2)))+'px';
        var lc=l.querySelector('canvas'),ctx=lc.getContext('2d'),im=images[i],span=16*im.width/images[1].width,spanY=16*im.height/images[1].height;
        ctx.clearRect(0,0,128,128);ctx.imageSmoothingEnabled=false;
        ctx.drawImage(im,u*im.width-span/2,v*im.height-spanY/2,span,spanY,0,0,128,128);
        // The center always samples the exact normalized cursor position.
        ctx.strokeStyle='#ff00a8';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(60,64.5);ctx.lineTo(68,64.5);ctx.moveTo(64.5,60);ctx.lineTo(64.5,68);ctx.stroke();
        l.querySelector('output').textContent=(i?'Optimized':'Original')+' · '+Math.min(im.width-1,Math.floor(u*im.width))+', '+Math.min(im.height-1,Math.floor(v*im.height));
        l.dataset.u=u;l.dataset.v=v;l.hidden=false;
      });
    }
    function atPointer(e,i){if(!images)return;var index=mode==='swipe'?0:i,r=surfaces[index].getBoundingClientRect(),l=layout[index];inspect((e.clientX-r.left-l.left)/l.width,(e.clientY-r.top-l.top)/l.height);}
    function renderVisible(){
      if(!images||closed)return;
      images.forEach(function(im,i){
        if(im.width<=1024&&im.height<=1024)return;
        var c=canvases[i],p=mode==='swipe'?panes[0]:panes[i],l=layout[i];
        var x=Math.max(0,p.scrollLeft-l.left),y=Math.max(0,p.scrollTop-l.top);
        var width=Math.max(1,Math.min(l.width-x,p.clientWidth)),height=Math.max(1,Math.min(l.height-y,p.clientHeight));
        // A bounded viewport tile, never a full-size comparison clone. At
        // inspection zoom draw directly from the full-resolution source.
        var density=Math.min(1,1024/width,1024/height);
        c.width=Math.max(1,Math.ceil(width*density));c.height=Math.max(1,Math.ceil(height*density));
        c.style.width=width+'px';c.style.height=height+'px';c.style.left=(l.left+x)+'px';c.style.top=(l.top+y)+'px';
        var ctx=c.getContext('2d');ctx.imageSmoothingEnabled=!zoom;ctx.imageSmoothingQuality='high';
        ctx.drawImage(im,x/l.width*im.width,y/l.height*im.height,width/l.width*im.width,height/l.height*im.height,0,0,c.width,c.height);
        c.dataset.sourceX=x/l.width*im.width;c.dataset.sourceY=y/l.height*im.height;
      });
    }
    function geometry(){
      if(!images||closed)return;
      var active=activePanes(),w=images[1].width,h=images[1].height;
      var next=zoom||Math.min.apply(null,active.map(function(p){return Math.min(p.clientWidth/w,p.clientHeight/h);}));
      if(next<=0)return;
      var x=panes[0].scrollLeft/scale,y=panes[0].scrollTop/scale;scale=next;
      surfaces.forEach(function(s,i){var p=mode==='swipe'?panes[0]:panes[i];s.style.width=Math.max(w*scale,p.clientWidth)+'px';s.style.height=Math.max(h*scale,p.clientHeight)+'px';});
      canvases.forEach(function(c,i){var p=mode==='swipe'?panes[0]:panes[i];layout[i]={width:w*scale,height:h*scale,left:Math.max(0,(p.clientWidth-w*scale)/2),top:Math.max(0,(p.clientHeight-h*scale)/2)};c.style.width=w*scale+'px';c.style.height=h*scale+'px';c.style.left=layout[i].left+'px';c.style.top=layout[i].top+'px';c.classList.toggle('actual-pixels',!!zoom);});
      panes.forEach(function(p){p.scrollLeft=x*scale;p.scrollTop=y*scale;});renderVisible();clip();hideLens();
    }
    panes.forEach(function(p,i){
      p.onscroll=function(){if(!scrollLock&&mode==='side'){scrollLock=true;panes[1-i].scrollLeft=p.scrollLeft;panes[1-i].scrollTop=p.scrollTop;scrollLock=false;}renderVisible();clip();hideLens();};
      p.onpointerdown=function(e){if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:p.scrollLeft,top:p.scrollTop};p.setPointerCapture(e.pointerId);atPointer(e,i);};
      p.onpointermove=function(e){if(drag&&drag.id===e.pointerId){p.scrollLeft=drag.left+drag.x-e.clientX;p.scrollTop=drag.top+drag.y-e.clientY;}atPointer(e,i);};
      p.onpointerup=p.onpointercancel=function(){drag=null;};p.onpointerleave=function(e){if(!drag&&e.pointerType!=='touch')hideLens();};
      p.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();var r=p.getBoundingClientRect();atPointer({clientX:r.left+p.clientWidth/2,clientY:r.top+p.clientHeight/2},i);}};
    });
    function moveDivider(e){var r=panes[0].getBoundingClientRect();split=Math.max(0,Math.min(100,(e.clientX-r.left)/panes[0].clientWidth*100));clip();hideLens();}
    divider.onpointerdown=function(e){e.preventDefault();divider.setPointerCapture(e.pointerId);moveDivider(e);};
    divider.onpointermove=function(e){if(divider.hasPointerCapture(e.pointerId))moveDivider(e);};
    divider.onkeydown=function(e){if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();split=e.key==='Home'?0:e.key==='End'?100:Math.max(0,Math.min(100,split+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?10:1)));clip();};
    var observer=new ResizeObserver(geometry);panes.forEach(function(p){observer.observe(p);});
    function clear(){images=null;layout=[];canvases.forEach(function(c){c.width=0;c.height=0;});hideLens();}
    return {
      setImages:function(original,candidate){images=[original,candidate];images.forEach(function(im,i){var c=canvases[i];if(im.width<=1024&&im.height<=1024){c.width=im.width;c.height=im.height;c.getContext('2d').drawImage(im,0,0);}else{c.width=0;c.height=0;}});root.querySelector('[data-original-size]').textContent=original.width+' × '+original.height+' px';root.querySelector('[data-candidate-size]').textContent=candidate.width+' × '+candidate.height+' px';root.querySelector('[data-swipe-size]').textContent=candidate.width+' × '+candidate.height+' px';geometry();},
      setZoom:function(value){zoom=value;geometry();},
      setMode:function(value){mode=value;root.classList.toggle('is-swipe',mode==='swipe');if(mode==='swipe')surfaces[0].appendChild(canvases[1]);else{surfaces[1].appendChild(canvases[1]);canvases.forEach(function(c){c.style.clipPath='';});}geometry();},
      clear:clear,
      destroy:function(){closed=true;observer.disconnect();clear();lenses.forEach(function(l){l.querySelector('canvas').width=0;});}
    };
  }
  async function samePreviewPixels(a,b,cancelled){
    if(a===b)return true;if(a.width!==b.width||a.height!==b.height)return false;
    for(var y=0;y<a.height;y+=64){var rows=Math.min(64,a.height-y),left=a.getContext('2d').getImageData(0,y,a.width,rows).data,right=b.getContext('2d').getImageData(0,y,b.width,rows).data;for(var i=0;i<left.length;i++)if(left[i]!==right[i])return false;await new Promise(function(r){setTimeout(r,0);});if(cancelled())throw new Error('Cancelled.');}return true;
  }
  window.PrintOptimizer={clean:clean,cleanFringe:cleanFringe,prepare:prepare,analyze:analyze,upscale:upscale,forceEnhance:forceEnhance,estimateMemory:estimateMemory,open:open};
})();
