const fs=require('node:fs'), vm=require('node:vm'), assert=require('node:assert/strict'), {webcrypto}=require('node:crypto');
(async()=>{
  const sandbox={crypto:webcrypto,TextEncoder,Date,WeakMap,Map,Set}; vm.runInNewContext(fs.readFileSync('public/export-delivery.js','utf8'),sandbox);
  const calls=[], delivered=[], canvas={width:2048,height:2048,_ssbExportRecipe:['real-source',1]};
  let fail=false, failAck=false, creditDenied=false;
  const helper=sandbox.SmartSheetExportDelivery.create({gate:async(kind,op)=>{calls.push({kind,...op}); return creditDenied?{allowed:false,reason:'credits_empty'}:failAck&&op.action==='saved'?{allowed:false,reason:'transport_error'}:{allowed:true,authorization:'server-token',receipt:'receipt-one'};},save:async(blob)=>{if(fail)throw Error('disk full'); delivered.push(blob);return true;},notice:()=>{}});
  await helper.deliver(null,'x.png',null,'png',canvas); assert.equal(calls.length,0,'encoding failure makes no deduction');
  await helper.deliver(new Blob(['ready']),'x.png',false,'png',canvas); assert.equal(calls.length,0,'picker cancellation makes no deduction');
  const blob=new Blob(['complete-full-resolution-pixels']);
  const ticket=await helper.prepare('png',canvas);const retry=await helper.prepare('png',canvas);assert.equal(ticket.requestKey,retry.requestKey,'uncertain attempt retains retry key');
  await helper.deliver(blob,'x.png',null,'png',canvas,null,ticket); assert.equal(calls[2].action,'consume');assert.equal(calls[3].action,'saved');assert.equal(delivered[0],blob,'identical output bytes, never preview input');
  const next=await helper.prepare('png',canvas);assert.notEqual(ticket.requestKey,next.requestKey,'completed export is not a free replay');
  const noTicket=calls.length;assert.equal(await helper.deliver(blob,'x.png',null,'png',canvas),false);assert.equal(calls.length,noTicket,'delivery cannot bypass central authorization');
  canvas._ssbExportRecipe=['real-source',2];await helper.deliver(blob,'x.png',null,'png',canvas,null,await helper.prepare('png',canvas));assert.notEqual(calls.at(-2).requestKey,calls[0].requestKey,'changed design new key');
  fail=true;const cmyk=await helper.prepare('tiff',canvas,{mode:'cmyk'});await assert.rejects(()=>helper.deliver(blob,'x.tif',null,'tiff',canvas,{mode:'cmyk'},cmyk));assert.equal(calls.at(-1).action,'refund');
  fail=false;failAck=true;await helper.deliver(blob,'x.tif',null,'tiff',canvas,{mode:'rgb'},await helper.prepare('tiff',canvas,{mode:'rgb'}));assert.equal(calls.at(-1).action,'saved','lost acknowledgement never refunds a delivered file');
  failAck=false;creditDenied=true;const count=delivered.length;await helper.deliver(blob,'x.png',null,'png',canvas);assert.equal(delivered.length,count);
  console.log('PASS: final Blob before debit, failed encoding/cancel no charge, stable retry key, changed source/format distinct, save-failure refund, no refund after delivered output, exact bytes preserved.');
})().catch(e=>{console.error(e);process.exitCode=1;});
