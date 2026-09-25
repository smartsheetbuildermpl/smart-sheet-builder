// Isolated PostgreSQL-compatible database; never connects to Supabase.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const owner = '00000000-0000-4000-8000-000000000001';
const basic = '00000000-0000-4000-8000-000000000002';
const legacy = '00000000-0000-4000-8000-000000000003';
const newcomer = '00000000-0000-4000-8000-000000000004';
(async () => {
  const db = new PGlite();
  const q = (sql, params = []) => db.query(sql, params);
  const one = async (sql, params) => (await q(sql, params)).rows[0];
  async function denied(sql, params) { await assert.rejects(() => q(sql, params)); }
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,created_at timestamptz default now(),last_sign_in_at timestamptz,raw_user_meta_data jsonb);
      create schema storage; create table storage.buckets(id text primary key,public boolean); create table storage.objects(id uuid,bucket_id text); alter table storage.objects enable row level security;
      create table public.design_library_categories(id uuid); create table public.design_library_designs(id uuid);
    `);
    await db.exec(fs.readFileSync('supabase-smart-sheet-v53b.sql','utf8').replace('create extension if not exists pgcrypto;',''));
    await db.exec(fs.readFileSync('supabase-access-entitlements-v1.sql','utf8'));
    for (const [id,email] of [[owner,'masterprintlabcorp@gmail.com'],[basic,'basic@example.test'],[legacy,'legacy@example.test']]) {
      await q('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[id,email]);
      await q("insert into profiles(id,email,role,plan,exports_used,exports_unlimited) values($1,$2,$3,'free',4,$4)",[id,email,id===legacy?'admin':'customer',id===basic]);
    }
    await q("insert into usage_exports(user_id,export_kind) values($1,'tiff')",[basic]);
    const migration = fs.readFileSync('supabase-user-management-v1.sql','utf8');
    await db.exec(migration); await db.exec(migration);
    assert.equal((await one('select count(*)::int n from user_access_history')).n,0,'no fabricated registration history');
    assert.equal((await one('select count(*)::int n from profiles where is_super_admin')).n,1);
    assert.equal((await one('select exports_used,exports_unlimited from profiles where id=$1',[basic])).exports_used,4);
    assert.equal((await one('select exports_unlimited from profiles where id=$1',[basic])).exports_unlimited,true);
    await q('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[newcomer,'new@example.test',JSON.stringify({ full_name:'New User',business_name:'Shop',role:'admin',plan:'admin',is_super_admin:true,exports_unlimited:true,machine_type:'DTF',terms_accepted:true })]);
    let p = await one('select * from profiles where id=$1',[newcomer]);
    assert.equal(p.role,'user'); assert.equal(p.plan,'free'); assert.equal(p.exports_unlimited,false); assert.equal(p.is_super_admin,false); assert.equal(p.full_name,'New User'); assert(p.terms_accepted_at);
    let data = (await one('select ssb_admin_user($1,$2) d',[owner,newcomer])).d;
    assert.equal(data.user.account_status,'pending_email_verification'); assert.equal(data.user.can_manage_design_library,false); assert.equal(data.history.length,1);
    assert.equal((await one("select ssb_consume_export($1,'png') d",[newcomer])).d.allowed,false);
    for (const actor of [basic,legacy,newcomer]) {
      await denied('select ssb_admin_users($1)',[actor]);
      await denied('select ssb_admin_user($1,$2)',[actor,owner]);
      await denied("select ssb_admin_change($1,$2,'export_access','unlimited',now())",[actor,newcomer]);
    }
    // Even if someone grants a broad SELECT policy later, the restrictive guard remains.
    await db.exec(`grant usage on schema auth,public to authenticated; grant select on profiles to authenticated;
      create policy accidental_broad_read on profiles for select to authenticated using(true);`);
    await q("select set_config('request.jwt.claim.sub',$1,false)",[newcomer]);
    await db.exec('set role authenticated');
    assert.equal((await one('select count(*)::int n from profiles')).n,1);
    await denied("update profiles set exports_unlimited=true where id=$1",[newcomer]);
    await denied("insert into profiles(id,email) values(gen_random_uuid(),'attack@test.com')");
    await denied('select * from user_access_history'); await denied('select * from usage_exports');
    await denied('select ssb_admin_users($1)',[owner]);
    await denied("select ssb_consume_export($1,'png')",[owner]);
    await db.exec('reset role');
    await q('update auth.users set email_confirmed_at=now() where id=$1',[newcomer]);
    let consume = (await one("select ssb_consume_export($1,'png') d",[newcomer])).d;
    assert(consume.allowed); assert.equal(consume.profile.exports_used,1);
    await q("insert into guest_usage(guest_id,exports_used) values('guest',2)");
    await q("select ssb_import_guest_usage($1,'guest')",[newcomer]);
    assert.equal((await one('select exports_used from profiles where id=$1',[newcomer])).exports_used,2);
    for (let i=0;i<3;i++) assert((await one("select ssb_consume_export($1,'tiff') d",[newcomer])).d.allowed);
    await q("select ssb_import_guest_usage($1,'guest')",[newcomer]);
    assert.equal((await one('select exports_used from profiles where id=$1',[newcomer])).exports_used,5,'guest import never decrements usage');
    assert.equal((await one("select ssb_consume_export($1,'png') d",[newcomer])).d.allowed,false);
    async function change(id,field,value) {
      const row = await one('select updated_at::text stamp from profiles where id=$1',[id]);
      await q('select ssb_admin_change($1,$2,$3,$4,$5)',[owner,id,field,value,row.stamp]);
    }
    await change(newcomer,'export_access','unlimited');
    p = await one('select * from profiles where id=$1',[newcomer]); assert.equal(p.role,'user'); assert.equal(p.is_super_admin,false);
    assert((await one("select ssb_consume_export($1,'tiff') d",[newcomer])).d.allowed);
    await denied('select ssb_admin_users($1)',[newcomer]);
    await change(newcomer,'status','blocked');
    assert.equal((await one("select ssb_consume_export($1,'png') d",[newcomer])).d.reason,'account_blocked');
    await denied("select ssb_import_guest_usage($1,'guest')",[newcomer]);
    await change(newcomer,'status','active');
    await change(newcomer,'export_access','standard');
    assert.equal((await one("select ssb_consume_export($1,'png') d",[newcomer])).d.reason,'limit_reached');
    await change(legacy,'export_access','standard');
    assert.equal((await one('select ssb_unlimited(p) u from profiles p where id=$1',[legacy])).u,false);
    await denied("select ssb_admin_change($1,$1,'status','blocked',now())",[owner]);
    await denied("select ssb_admin_change($1,$2,'role','admin',now())",[owner,newcomer]);
    await denied("select ssb_admin_change($1,$2,'status','blocked','2000-01-01')",[owner,newcomer]);
    data=(await one('select ssb_admin_user($1,$2) d',[owner,newcomer])).d;
    assert.equal(data.user.recorded_exports,5); assert.equal(data.history.filter(e=>e.event==='admin_access_change').length,4);
    assert(data.history.filter(e=>e.event==='admin_access_change').every(e=>e.actor_id===owner && e.old_value && e.new_value));
    const filtered=(await one("select ssb_admin_users($1,'New User','active','standard',0) d",[owner])).d;
    assert.equal(filtered.total,1); assert.equal(filtered.users[0].id,newcomer);
    // A new account reusing the old owner's email cannot inherit owner access.
    await q("update auth.users set email='owner-new@example.test' where id=$1",[owner]);
    await q("update profiles set email='owner-new@example.test' where id=$1",[owner]);
    await q("insert into auth.users(id,email,email_confirmed_at) values(gen_random_uuid(),'masterprintlabcorp@gmail.com',now())");
    assert.equal((await one("select is_super_admin from profiles where email='masterprintlabcorp@gmail.com'")).is_super_admin,false);
    console.log('PASS: migration rerun, legacy preservation, registration/verification, metadata escalation, RLS, RPC denial, owner protection, standard/unlimited, suspension, usage serialization, exact audits, filtering.');
  } finally { await db.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
