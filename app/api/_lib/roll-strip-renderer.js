// Portal-only native-source renderer. PNG scanlines are decoded to private
// scratch files, never to a full-image Buffer/canvas. Only a strip and bounded
// source rectangles are resident while applying the locked manifest transforms.
import { open, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createInflate, createDeflate, deflateSync } from 'node:zlib';

export const ROLL_STRIP_ROWS = 32;
export const ROLL_SOURCE_WINDOW_BYTES = 4 * 1024 * 1024;
export const ROLL_SCRATCH_BYTES = 448 * 1024 * 1024;
export const ROLL_DELIVERY_BYTES = 128 * 1024 * 1024;
const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable = Array.from({length:256}, (_,n) => {
  for(let k=0;k<8;k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function pngChunk(type, data = Buffer.alloc(0)) {
  const b=Buffer.alloc(data.length+12); b.writeUInt32BE(data.length); b.write(type,4); data.copy(b,8);
  let crc=0xffffffff;
  for(let i=4;i<b.length-4;i++) crc=crcTable[(crc ^ b[i]) & 255] ^ (crc >>> 8);
  b.writeUInt32BE((crc ^ 0xffffffff) >>> 0,b.length-4); return b;
}
async function read(file, length, offset) {
  const b=Buffer.allocUnsafe(length); let done=0;
  while(done<length) { const r=await file.read(b,done,length-done,offset+done); if(!r.bytesRead) throw Error('Original PNG is incomplete. Reopen the submission and retry.'); done+=r.bytesRead; }
  return b;
}
async function write(file, bytes) {
  let offset=0;
  while(offset<bytes.length) { const result=await file.write(bytes,offset,bytes.length-offset); if(!result.bytesWritten)throw Error('Private source storage could not complete. Retry; no partial print file was saved.');offset+=result.bytesWritten; }
}
function paeth(a,b,c) { const p=a+b-c, x=Math.abs(p-a), y=Math.abs(p-b), z=Math.abs(p-c); return x<=y && x<=z ? a : y<=z ? b : c; }

export async function decodeOriginal(path, rawPath, asset, check) {
  const input=await open(path,'r'), output=await open(rawPath,'w');
  let palette=null, transparency=null, type, channels, width, height, ranges=[];
  try {
    if(!(await read(input,8,0)).equals(signature)) throw Error('Original source is not a PNG.');
    const size=(await input.stat()).size;
    for(let pos=8;pos<size;) {
      check(); const h=await read(input,8,pos), length=h.readUInt32BE(0), kind=h.toString('ascii',4);
      if(pos+length+12>size) throw Error('Original PNG is incomplete.');
      if(kind==='IHDR') {
        const d=await read(input,length,pos+8); width=d.readUInt32BE(0); height=d.readUInt32BE(4); type=d[9];
        channels=({0:1,2:3,3:1,4:2,6:4})[type];
        if(length!==13 || d[8]!==8 || !channels || d[10] || d[11] || d[12]) throw Error('Strip rendering requires a static, non-interlaced 8-bit PNG original. Contact the shop about this source format; no reduced file was created.');
        if(width!==asset.width || height!==asset.height) throw Error('Original source dimensions failed verification.');
      } else if(kind==='PLTE') palette=await read(input,length,pos+8);
      else if(kind==='tRNS') transparency=await read(input,length,pos+8);
      else if(kind==='IDAT') ranges.push([pos+8,length]);
      else if(kind==='IEND') break;
      pos+=length+12;
    }
    if(!width || !ranges.length || (type===3 && !palette)) throw Error('Original PNG has no readable pixels.');
    const c=asset.crop;
    if(!c || ![c.x,c.y,c.w,c.h].every(Number.isInteger) || c.x<0 || c.y<0 || c.w<1 || c.h<1 || c.x+c.w>width || c.y+c.h>height) throw Error('The saved original crop is invalid.');
    const rowBytes=width*channels, stride=rowBytes+1;
    let previous=Buffer.alloc(rowBytes), scan=Buffer.alloc(stride), filled=0, y=0;
    async function* compressed() {
      for(const [start,length] of ranges) for(let n=0;n<length;n+=65536) { check(); yield await read(input,Math.min(65536,length-n),start+n); }
    }
    const inflater=createInflate({chunkSize:65536}), source=Readable.from(compressed());
    source.on('error',e=>inflater.destroy(e)); source.pipe(inflater);
    try {
      for await(const part of inflater) {
        let at=0;
        while(at<part.length) {
          const n=Math.min(stride-filled,part.length-at); part.copy(scan,filled,at,at+n); at+=n; filled+=n;
          if(filled!==stride) continue;
          check(); if(y>=height || scan[0]>4) throw Error('Original PNG scanlines are invalid.');
          const row=scan.subarray(1), filter=scan[0];
          for(let x=0;x<rowBytes;x++) {
            const a=x>=channels?row[x-channels]:0, b=previous[x], d=x>=channels?previous[x-channels]:0;
            row[x]=(row[x]+(filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,d):0)) & 255;
          }
          if(y>=c.y && y<c.y+c.h) {
            const rgba=Buffer.allocUnsafe(c.w*4);
            if(type===6) row.copy(rgba,0,c.x*4,(c.x+c.w)*4);
            else for(let x=0;x<c.w;x++) {
              const i=(x+c.x)*channels, o=x*4;
              if(type===2) { row.copy(rgba,o,i,i+3); rgba[o+3]=transparency && row[i]===transparency.readUInt16BE(0) && row[i+1]===transparency.readUInt16BE(2) && row[i+2]===transparency.readUInt16BE(4) ? 0 : 255; }
              else if(type===3) { const p=row[i]; if(p*3+2>=palette.length) throw Error('Invalid PNG palette.'); palette.copy(rgba,o,p*3,p*3+3); rgba[o+3]=transparency && p<transparency.length?transparency[p]:255; }
              else { rgba[o]=rgba[o+1]=rgba[o+2]=row[i]; rgba[o+3]=type===4?row[i+1]:transparency && row[i]===transparency.readUInt16BE(0)?0:255; }
            }
            await write(output,rgba);
          }
          // Keep two scanlines only. Source color/alpha bytes are unchanged.
          previous=row; scan=Buffer.allocUnsafe(stride); filled=0; y++;
        }
      }
    } finally { source.destroy(); inflater.destroy(); }
    if(y!==height || filled) throw Error('Original PNG scanlines are incomplete.');
  } finally { await input.close(); await output.close(); }
}

function sourcePoint(p, source, x, y) {
  let u=(x-p.x)/p.w, v=(y-p.y)/p.h;
  if(p.rotation===90) [u,v]=[v,1-u];
  else if(p.rotation===180) [u,v]=[1-u,1-v];
  else if(p.rotation===270) [u,v]=[1-v,u];
  return [Math.max(0,Math.min(source.w-1,u*source.w-0.5)),Math.max(0,Math.min(source.h-1,v*source.h-0.5))];
}
// Split output rectangles until their native source window fits 4 MiB. This
// also bounds extreme downscales/90-degree rotations without a full bitmap.
async function drawWindow(out, sheetWidth, stripY, p, source, x0,y0,x1,y1,check) {
  const corners=[[x0+.5,y0+.5],[x1-.5,y0+.5],[x0+.5,y1-.5],[x1-.5,y1-.5]].map(([x,y])=>sourcePoint(p,source,x,y));
  const left=Math.floor(Math.min(...corners.map(c=>c[0]))), top=Math.floor(Math.min(...corners.map(c=>c[1])));
  const right=Math.min(source.w-1,Math.ceil(Math.max(...corners.map(c=>c[0])))), bottom=Math.min(source.h-1,Math.ceil(Math.max(...corners.map(c=>c[1]))));
  const w=right-left+1, h=bottom-top+1;
  if(w*h*4>ROLL_SOURCE_WINDOW_BYTES) {
    if(x1-x0>=y1-y0 && x1-x0>1) { const mid=Math.floor((x0+x1)/2); await drawWindow(out,sheetWidth,stripY,p,source,x0,y0,mid,y1,check); return drawWindow(out,sheetWidth,stripY,p,source,mid,y0,x1,y1,check); }
    const mid=Math.floor((y0+y1)/2); await drawWindow(out,sheetWidth,stripY,p,source,x0,y0,x1,mid,check); return drawWindow(out,sheetWidth,stripY,p,source,x0,mid,x1,y1,check);
  }
  check(); const pixels=Buffer.allocUnsafe(w*h*4);
  for(let row=0;row<h;row++) { let done=0; while(done<w*4) { const r=await source.file.read(pixels,row*w*4+done,w*4-done,((top+row)*source.w+left)*4+done); if(!r.bytesRead) throw Error('Private source tile is incomplete.'); done+=r.bytesRead; } }
  for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++) {
    let u=(x+.5-p.x)/p.w, v=(y+.5-p.y)/p.h;
    if(p.rotation===90) { const old=u; u=v; v=1-old; }
    else if(p.rotation===180) { u=1-u; v=1-v; }
    else if(p.rotation===270) { const old=u; u=1-v; v=old; }
    const sx=Math.max(0,Math.min(source.w-1,u*source.w-.5)), sy=Math.max(0,Math.min(source.h-1,v*source.h-.5));
    const ix=Math.floor(sx), iy=Math.floor(sy), fx=sx-ix, fy=sy-iy;
    const i=((iy-top)*w+ix-left)*4, j=i+(ix<right?4:0), k=i+(iy<bottom?w*4:0), l=k+(ix<right?4:0);
    const a0=pixels[i+3]*(1-fx)*(1-fy), a1=pixels[j+3]*fx*(1-fy), a2=pixels[k+3]*(1-fx)*fy, a3=pixels[l+3]*fx*fy;
    const alpha=a0+a1+a2+a3;
    // Premultiply while interpolating; unassociate only after source-over.
    // Identical transforms at every strip boundary prevent seams/fringes.
    if(alpha===0) continue;
    const o=((y-stripY)*sheetWidth+x)*4, remaining=1-alpha/255, dest=out[o+3]*remaining, combined=alpha+dest;
    for(let c=0;c<3;c++) out[o+c]=Math.round((pixels[i+c]*a0+pixels[j+c]*a1+pixels[k+c]*a2+pixels[l+c]*a3+out[o+c]*dest)/combined);
    out[o+3]=Math.round(combined);
  }
}
export async function renderStrip(sheet, sources, y, rows, check) {
  const out=Buffer.alloc(sheet.widthPx*rows*4);
  for(const p of sheet.placements) {
    const x0=Math.max(0,Math.ceil(p.x-.5)), y0=Math.max(y,Math.ceil(p.y-.5)), x1=Math.min(sheet.widthPx,Math.ceil(p.x+p.w-.5)), y1=Math.min(y+rows,Math.ceil(p.y+p.h-.5));
    if(x1>x0 && y1>y0) await drawWindow(out,sheet.widthPx,y,p,sources[p.assetId],x0,y0,x1,y1,check);
  }
  return out;
}

export const rollRenderEvents = async function* (job, kind, fetchSource, check) {
  const dir=await mkdtemp(join(tmpdir(),'ssb-roll-')), sources={};
  const sheet=job.manifest.sheets[0], referenced=new Set(sheet.placements.map(p=>p.assetId)), assets=job.assets.filter(a=>a.ready && referenced.has(a.id));
  let encoder;
  try {
    // /tmp is capped on the production platform. This is a disk requirement,
    // independent of total output height; no decoded image lives in JS memory.
    const scratch=assets.reduce((n,a)=>n+a.crop.w*a.crop.h*4,0)+Math.max(0,...assets.map(a=>a.bytes || a.size || 0));
    if(scratch>ROLL_SCRATCH_BYTES) throw Error(`This roll needs ${(scratch/1048576).toFixed(1)} MiB of private scratch disk; this server supports 448 MiB per render. Contact the shop to process this job on a larger renderer. Originals and preview are preserved.`);
    yield {type:'progress',message:'Preparing full-resolution print file…'};
    for(const [i,asset] of assets.entries()) {
      check(); yield {type:'progress',message:`Preparing original artwork ${i+1} of ${assets.length}…`};
      const path=join(dir,`${i}.png`), raw=join(dir,`${i}.rgba`), digest=createHash('sha256'); let size=0;
      const response=await fetchSource(asset);
      const hashStream=new Transform({transform(chunk,encoding,callback){try{check(); size+=chunk.length; if(size>100*1048576) throw Error('Original source exceeds the 100 MiB server upload ceiling.'); digest.update(chunk); callback(null,chunk);}catch(e){callback(e);}}});
      await pipeline(Readable.fromWeb(response.body),hashStream,createWriteStream(path));
      if(digest.digest('hex')!==asset.sha256) throw Error('Original source integrity check failed. No file was created.');
      await decodeOriginal(path,raw,asset,check); await rm(path);
      sources[asset.id]={w:asset.crop.w,h:asset.crop.h,file:await open(raw,'r')};
    }
    const total=Math.ceil(sheet.heightPx/ROLL_STRIP_ROWS);
    let pngParts=[];
    if(kind==='png') {
      const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(sheet.widthPx); ihdr.writeUInt32BE(sheet.heightPx,4); ihdr[8]=8; ihdr[9]=6;
      const phys=Buffer.alloc(9); phys.writeUInt32BE(Math.round(job.manifest.dpi/0.0254)); phys.writeUInt32BE(Math.round(job.manifest.dpi/0.0254),4); phys[8]=1;
      yield {type:'data',data:Buffer.concat([signature,pngChunk('IHDR',ihdr),pngChunk('pHYs',phys)]).toString('base64')};
      encoder=createDeflate({chunkSize:65536}); encoder.on('data',b=>pngParts.push(pngChunk('IDAT',b))); encoder.on('error',()=>{});
    }
    for(let y=0, index=0;y<sheet.heightPx;y+=ROLL_STRIP_ROWS,index++) {
      check(); yield {type:'progress',message:`Rendering strip ${index+1} of ${total}…`};
      // TIFF gets a one-row halo on either side for the existing spot-mask
      // contraction. Halos are not output rows and never duplicate artwork.
      const top=kind==='tiff'?Math.max(0,y-1):y, bottom=Math.min(sheet.heightPx,y+ROLL_STRIP_ROWS+(kind==='tiff'?1:0)), rows=Math.min(ROLL_STRIP_ROWS,sheet.heightPx-y);
      const rgba=await renderStrip(sheet,sources,top,bottom-top,check);
      if(kind==='tiff') yield {type:'strip',y,rows,top,readRows:bottom-top,data:deflateSync(rgba).toString('base64')};
      else {
        const filtered=Buffer.alloc((sheet.widthPx*4+1)*rows);
        for(let row=0;row<rows;row++) rgba.copy(filtered,row*(sheet.widthPx*4+1)+1,row*sheet.widthPx*4,(row+1)*sheet.widthPx*4);
        await new Promise((resolve,reject)=>encoder.write(filtered,e=>e?reject(e):resolve()));
        for(const b of pngParts) yield {type:'data',data:b.toString('base64')}; pngParts=[];
      }
    }
    if(encoder) {
      await new Promise((resolve,reject)=>{encoder.once('end',resolve);encoder.once('error',reject);encoder.end();});
      for(const b of pngParts) yield {type:'data',data:b.toString('base64')};
      yield {type:'data',data:pngChunk('IEND').toString('base64')};
    }
    check(); yield {type:'rendered',width:sheet.widthPx,height:sheet.heightPx,dpi:job.manifest.dpi,strips:total};
  } finally {
    encoder?.destroy();
    await Promise.all(Object.values(sources).map(s=>s.file.close()));
    await rm(dir,{recursive:true,force:true});
  }
}
