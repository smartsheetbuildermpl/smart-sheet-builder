/* Runs the same native-pixel optimizer as the editor, with private owned buffers. */
'use strict';
self.window=self;
self.document={createElement:function(name){if(name!=='canvas')throw new Error('Unsupported worker element');var canvas=new OffscreenCanvas(1,1);canvas.getContext('2d',{willReadFrequently:true});return canvas;}};
importScripts('print-optimizer.js');
var source=null,lastProgress=0;
function progress(step,fraction){
  var now=performance.now();if(now-lastProgress<60&&fraction!==1)return;lastProgress=now;
  self.postMessage({type:'progress',step:step,fraction:Number.isFinite(fraction)?fraction:null});
}
function preview(canvas){
  var scale=Math.min(1,1600/Math.max(canvas.width,canvas.height)),c=new OffscreenCanvas(Math.max(1,Math.round(canvas.width*scale)),Math.max(1,Math.round(canvas.height*scale))),ctx=c.getContext('2d',{willReadFrequently:true});
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(canvas,0,0,c.width,c.height);return c.transferToImageBitmap();
}
self.onmessage=async function(event){
  var m=event.data;
  try{
    if(m.type==='init'){source=new OffscreenCanvas(m.width,m.height);source.getContext('2d',{willReadFrequently:true});self.postMessage({type:'initialized'});return;}
    if(m.type==='stripe'){source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.buffer),source.width,m.rows),0,m.y);self.postMessage({type:'stripe-ready'});return;}
    if(m.type!=='run')return;
    var result=await PrintOptimizer.prepare(source,null,m.strength,progress),candidate=result.canvas;
    progress('Analyzing full-resolution candidate',null);
    var info=PrintOptimizer.analyze(candidate,m.widthIn,m.heightIn,m.nativeScale),changedPixels=0;
    if(candidate!==source){
      for(var y=0;y<source.height;y+=64){
        var rows=Math.min(64,source.height-y),a=source.getContext('2d').getImageData(0,y,source.width,rows).data,b=candidate.getContext('2d').getImageData(0,y,source.width,rows).data;
        for(var i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2]||a[i+3]!==b[i+3])changedPixels++;
        progress('Verifying changed pixels',(y+rows)/source.height);
      }
    }
    var changed=changedPixels>0,width=candidate.width,height=candidate.height;
    progress('Preparing comparison preview',null);
    var originalPreview=preview(source),candidatePreview=preview(candidate);
    progress('Saving completed full-resolution candidate',null);
    var bitmap=changed?candidate.transferToImageBitmap():null;
    // Transfer the native backing pixels directly: no encode/decode and no
    // extra unpremultiply/putImageData round-trip on semi-transparent colors.
    self.postMessage({type:'complete',entry:{width:width,height:height,bitmap:bitmap,originalPreview:originalPreview,candidatePreview:candidatePreview,changed:changed,changedPixels:changedPixels,info:info,removed:result.removed,skipped:result.skipped,
      fringe:{cleaned:result.fringe.cleaned,removed:result.fringe.removed,reduced:result.fringe.reduced,strength:result.fringe.strength},factor:1}},[originalPreview,candidatePreview].concat(bitmap?[bitmap]:[]));
    candidate.width=0;source.width=0;source=null;self.close();
  }catch(error){self.postMessage({type:'error',message:error.message});self.close();}
};
