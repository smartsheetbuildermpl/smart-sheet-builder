/* Client Portal only. Streamed native-source strips; no full-roll canvas or
 * decoded original bitmap. Existing TIFF profile/spot/layer helpers are passed
 * in by the isolated export iframe, preserving its RGB/CMYK contracts. */
(function(root){
  'use strict';
  var LIMIT=128*1024*1024;
  function bytes(base64){var text=atob(base64),out=new Uint8Array(text.length);for(var i=0;i<text.length;i++)out[i]=text.charCodeAt(i);return out;}
  async function codec(data,compress){
    var stream=new Blob([data]).stream().pipeThrough(compress?new CompressionStream('deflate'):new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function encode(options){
    var job=options.job,sheet=job.manifest.sheets[0],kind=options.kind,profile=options.profile;
    var parts=[],pixelSizes=[],received=0,payloadBytes=0,complete=false,rendered=false,expectedY=0;
    var baseSamples=profile && profile.baseMode==='cmyk'?4:3,ids=baseSamples===4?[-1,0,1,2,3]:[-1,0,1,2];
    var rowData=ids.map(function(){return [];}), rowLengths=ids.map(function(){return [];}),layerBytes=0;
    var levels=new Uint8Array(256);for(var lv=0;lv<256;lv++)levels[lv]=Math.min(32,Math.floor((lv*32+127)/255));
    function bounded(n){payloadBytes+=n;if(payloadBytes>LIMIT)throw Error('This browser delivery supports a maximum 128 MiB encoded print file. No partial file was saved. Contact the shop for a larger renderer; originals remain unchanged.');}
    async function event(e){
      if(e.type==='error')throw Error(e.message);
      if(e.type==='progress')options.progress(e.message);
      else if(e.type==='data') {var b=bytes(e.data);bounded(b.length);parts.push(b);}
      else if(e.type==='strip') {
        if(kind!=='tiff'||e.y!==expectedY||e.rows!==Math.min(32,sheet.heightPx-e.y)||e.top!==Math.max(0,e.y-1)||e.readRows!==Math.min(sheet.heightPx,e.y+e.rows+1)-e.top)throw Error('Print strip sequence is incomplete. Retry; no partial file was saved.');
        var rgba=await codec(bytes(e.data),false),width=sheet.widthPx,samples=baseSamples+(profile.normalAlpha?1:0)+profile.spotNames.length;
        if(rgba.length!==width*e.readRows*4)throw Error('Print strip pixels are incomplete.');
        var out=new Uint8Array(width*e.rows*samples),pos=0;
        for(var row=0;row<e.rows;row++){
          var channels=profile.normalAlpha?null:ids.map(function(){return new Uint8Array(width);});
          for(var x=0;x<width;x++) {
            var src=((e.y+row-e.top)*width+x)*4,alpha=rgba[src+3],blank=profile.mode==='dtf_rgb_w1'&&alpha===0;
            var lutIndex=((levels[rgba[src]]*33+levels[rgba[src+1]])*33+levels[rgba[src+2]])*4;
            if(profile.baseMode==='cmyk')for(var c=0;c<4;c++)out[pos++]=Math.floor((options.color.lut[lutIndex+c]*alpha+127)/255);
            else if(profile.normalAlpha){out[pos++]=rgba[src];out[pos++]=rgba[src+1];out[pos++]=rgba[src+2];out[pos++]=alpha;}
            else for(var rgb=0;rgb<3;rgb++)out[pos++]=blank?255:Math.floor((rgba[src+rgb]*alpha+127)/255);
            if(profile.spotNames.length){
              var spot=options.helpers.spot(rgba,src,width,sheet.heightPx,x,e.y+row,alpha);
              for(var s=0;s<profile.spotNames.length;s++)out[pos++]=spot;
            }
            if(channels){channels[0][x]=alpha;for(var channel=0;channel<baseSamples;channel++)channels[channel+1][x]=profile.baseMode==='cmyk'?(alpha?255-options.color.lut[lutIndex+channel]:255):(blank?255:rgba[src+channel]);}
          }
          if(channels)for(var ch=0;ch<channels.length;ch++){
            var packed=options.helpers.pack(channels[ch]);if(packed.length>65535)throw Error('TIFF Photoshop layer row exceeds the 65535-byte format limit. Contact the shop.');
            bounded(packed.length+2);layerBytes+=packed.length+2;rowLengths[ch].push(packed.length);rowData[ch].push(packed);
          }
        }
        var compressed=await codec(out,true); bounded(compressed.length);parts.push(compressed);pixelSizes.push(compressed.length);expectedY+=e.rows;received++;
      } else if(e.type==='rendered') {
        if(e.width!==sheet.widthPx||e.height!==sheet.heightPx||e.dpi!==job.manifest.dpi||kind==='tiff'&&(expectedY!==sheet.heightPx||received!==e.strips))throw Error('The full-resolution output did not complete. Retry.');
        rendered=true;
      } else if(e.type==='complete')complete=true;
    }
    var response=await options.request();if(!response.ok){var error=await response.json();throw Error(error.message||'Print file preparation failed. Retry.');}
    var reader=response.body.getReader(),decoder=new TextDecoder(),pending='';
    try{
      while(true){var r=await reader.read();if(r.done)break;pending+=decoder.decode(r.value,{stream:true});var newline;while((newline=pending.indexOf('\n'))>=0){var line=pending.slice(0,newline);pending=pending.slice(newline+1);if(line)await event(JSON.parse(line));}}
      if(pending.trim()||!rendered||!complete||!parts.length)throw Error('Print file preparation was interrupted. Retry; no partial file was saved.');
    } finally {await reader.cancel().catch(function(){});}
    if(kind==='png')return new Blob(parts,{type:'image/png'});
    options.progress('Assembling full-resolution TIFF…');
    var h=options.helpers,layer=null;
    if(!profile.normalAlpha){
      var blocks=ids.map(function(_,ch){return h.concat([h.u16(1),h.shorts(rowLengths[ch])].concat(rowData[ch]));});
      layer=h.layer({top:0,left:0,bottom:sheet.heightPx,right:sheet.widthPx},ids,blocks);
      // Full-canvas layer bounds carry precisely the same RGBA pixels; only
      // compressed layer storage differs from the existing bounded-art bounds.
    }
    var prefix=h.prefix(sheet.widthPx,sheet.heightPx,job.manifest.dpi,32,pixelSizes,profile,h.resources(profile.spotNames),options.color?options.color.icc:null,layer);
    // The shared TIFF prefix supports exact strip byte counts/offsets. These
    // strips are losslessly Deflate encoded (TIFF tag 259 = 8).
    var view=new DataView(prefix.buffer,prefix.byteOffset,prefix.byteLength),ifd=view.getUint32(4,true),count=view.getUint16(ifd,true);
    for(var t=0;t<count;t++){var off=ifd+2+t*12;if(view.getUint16(off,true)===259)view.setUint16(off+8,8,true);}
    if(prefix.length+payloadBytes-layerBytes>LIMIT)throw Error('The encoded TIFF exceeds the 128 MiB delivery limit. No partial file was saved. Contact the shop.');
    return new Blob([prefix].concat(parts),{type:'image/tiff'});
  }
  root.SmartSheetRollExport={encode:encode};
})(typeof window!=='undefined'?window:globalThis);
