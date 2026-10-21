const assert = require('node:assert/strict');
const { NextRequest } = require('next/server');
const { load } = require('./export-enforcement.test.cjs');
const helper = load('app/api/_lib/password-auth.js');
const request = load('app/api/auth/password/request/route.js');
const req = origin => new NextRequest(origin+'/api/auth/password/request', {method:'POST',headers:{origin},body:JSON.stringify({email:'test@example.test'})});
(async () => {
  const before = {...process.env}, priorFetch = global.fetch, calls=[];
  try {
    Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:'https://supabase.test',NEXT_PUBLIC_SUPABASE_ANON_KEY:'fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture-server',NODE_ENV:'production',VERCEL:'1',VERCEL_ENV:'production',SMART_SHEET_SITE_URL:'https://smart-sheet-builder.vercel.app'});
    global.fetch=async (url,options)=>{calls.push({url:new URL(url),body:JSON.parse(options.body)});return Response.json({});};
    const prod = 'https://smart-sheet-builder.vercel.app';
    assert.equal(helper.resetUrl(req(prod)),prod+'/reset-password');
    assert.equal(helper.appAuthUrl(req(prod)),prod+'/auth/callback');
    assert.equal((await request.POST(req(prod))).status,200);
    assert.equal(calls.at(-1).url.searchParams.get('redirect_to'),prod+'/reset-password');
    assert(!calls.at(-1).url.href.includes('localhost'));
    assert.deepEqual(calls.at(-1).body,{email:'test@example.test'},'new recovery links must not be bound to a requesting-browser PKCE verifier');
    process.env.SMART_SHEET_SITE_URL='http://localhost:3000';
    const count=calls.length;
    assert.equal((await request.POST(req(prod))).status,503,'production misconfiguration fails before sending an unsafe redirect');
    assert.equal(calls.length,count);
    delete process.env.SMART_SHEET_SITE_URL; process.env.VERCEL_PROJECT_PRODUCTION_URL='smart-sheet-builder.vercel.app';
    assert.equal(helper.resetUrl(req(prod)),prod+'/reset-password','trusted Vercel fallback');
    delete process.env.VERCEL;delete process.env.VERCEL_ENV; delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    // A locally running build retains a same-origin redirect, even with a
    // production canonical value configured in the development environment.
    process.env.SMART_SHEET_SITE_URL=prod;
    for(const mode of ['development','production']){
      process.env.NODE_ENV=mode;
      for(const origin of ['http://localhost:3000','http://localhost:3114']){
        assert.equal(helper.resetUrl(req(origin)),origin+'/reset-password');
        assert.equal(helper.appAuthUrl(req(origin)),origin+'/auth/callback');
        assert.equal((await request.POST(req(origin))).status,200);
        assert.equal(calls.at(-1).url.searchParams.get('redirect_to'),origin+'/reset-password');
      }
    }
    process.env.VERCEL_ENV='production';process.env.SMART_SHEET_SITE_URL='http://localhost:3000';
    assert.throws(()=>helper.resetUrl(req('http://localhost:3000')),'a Vercel deployment cannot select a local URL');
    assert.throws(()=>helper.appAuthUrl(req(prod),'/'),'generic root is not an auth callback');
    console.log('PASS: exact production /reset-password and /auth/callback, cross-device recovery issuance, no production localhost, fail closed for misconfiguration, local dev/build origins, trusted Vercel fallback.');
  } finally { global.fetch=priorFetch;for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before); }
})().catch(e=>{console.error(e);process.exitCode=1;});
