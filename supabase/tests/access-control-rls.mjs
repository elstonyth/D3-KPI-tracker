/**
 * Authoritative access-control regression test for the AC-1 / AC-2 / AC-5
 * lockdown (TODO_access-control.md, migrations 20260601000000 / 20260601000001).
 *
 * This exercises the REAL attack path the Next app + proxy.ts cannot mediate:
 * a logged-in creator hitting PostgREST directly with their own JWT + the public
 * publishable key. RLS is the only control there, so this is where the fix must
 * be proven. (Playwright/browser e2e cannot reach this path — it's pure API.)
 *
 * Run against a LOCAL Supabase stack only:
 *   SUPABASE_URL=... ANON_KEY=... SERVICE_KEY=... node supabase/tests/access-control-rls.mjs
 *
 * Exit code 0 = all checks passed; 1 = at least one failed.
 */

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.ANON_KEY;
const SERVICE = process.env.SERVICE_KEY;

if (!ANON || !SERVICE) {
  console.error('Missing ANON_KEY / SERVICE_KEY env. Get them from `supabase status -o env`.');
  process.exit(2);
}

// Service client bypasses RLS — used for setup + ground-truth verification.
const svc = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

const stamp = Date.now();
const attackerEmail = `attacker+${stamp}@local.test`;
const victimEmail = `victim+${stamp}@local.test`;
const PW = 'test-password-123';

let attackerId, victimId, attackerCreatorId, victimCreatorId;
let victimClaimedProfileId, victimUnclaimedProfileId, attackerProfileId;

async function setup() {
  // 1. Two creator users. The handle_new_auth_user trigger auto-creates their
  //    user_role(creator) + empty creator_link rows — the realistic state.
  const a = await svc.auth.admin.createUser({ email: attackerEmail, password: PW, email_confirm: true });
  if (a.error) throw new Error(`create attacker: ${a.error.message}`);
  attackerId = a.data.user.id;
  const v = await svc.auth.admin.createUser({ email: victimEmail, password: PW, email_confirm: true });
  if (v.error) throw new Error(`create victim: ${v.error.message}`);
  victimId = v.data.user.id;

  // 2. Creator rows + one profile each (service role = the admin provisioning path).
  const ac = await svc.from('creator').insert({ display_name: `Attacker ${stamp}` }).select('id').single();
  if (ac.error) throw new Error(`create attacker creator: ${ac.error.message}`);
  attackerCreatorId = ac.data.id;
  const vc = await svc.from('creator').insert({ display_name: `Victim ${stamp}` }).select('id').single();
  if (vc.error) throw new Error(`create victim creator: ${vc.error.message}`);
  victimCreatorId = vc.data.id;

  // Two victim profiles: one we attach an owner claim to (AC-2b deletes it), and
  // one left genuinely UNCLAIMED (AC-2 inserts on it — so the insert can ONLY be
  // stopped by the dropped RLS policy, never by an existing-claim collision).
  const vpClaimed = await svc.from('profile').insert({
    creator_id: victimCreatorId, platform: 'tiktok',
    profile_url: `https://www.tiktok.com/@victim${stamp}`, handle: `victim${stamp}`,
  }).select('id').single();
  if (vpClaimed.error) throw new Error(`create victim claimed profile: ${vpClaimed.error.message}`);
  victimClaimedProfileId = vpClaimed.data.id;

  const vpUnclaimed = await svc.from('profile').insert({
    creator_id: victimCreatorId, platform: 'tiktok',
    profile_url: `https://www.tiktok.com/@victim-open${stamp}`, handle: `victim-open${stamp}`,
  }).select('id').single();
  if (vpUnclaimed.error) throw new Error(`create victim unclaimed profile: ${vpUnclaimed.error.message}`);
  victimUnclaimedProfileId = vpUnclaimed.data.id;

  const ap = await svc.from('profile').insert({
    creator_id: attackerCreatorId, platform: 'tiktok',
    profile_url: `https://www.tiktok.com/@attacker${stamp}`, handle: `attacker${stamp}`,
  }).select('id').single();
  if (ap.error) throw new Error(`create attacker profile: ${ap.error.message}`);
  attackerProfileId = ap.data.id;

  // 3. Bind via service role (provisioning). Proves the legit write path works
  //    even after the user-write policies are dropped.
  const bindLink = await svc.from('creator_link').update({ creator_id: attackerCreatorId }).eq('user_id', attackerId).select();
  check('Provisioning: service-role can set creator_link.creator_id (AC-1 path stays open for admin)',
    !bindLink.error && bindLink.data?.length === 1, bindLink.error?.message ?? `rows=${bindLink.data?.length}`);
  await svc.from('creator_link').update({ creator_id: victimCreatorId }).eq('user_id', victimId);

  const bindClaim = await svc.from('profile_claim').insert({
    user_id: victimId, profile_id: victimClaimedProfileId, claim_kind: 'owner',
    claimed_via: 'admin_assigned', confirmed_at: new Date().toISOString(),
  }).select();
  check('Provisioning: service-role can insert an owner claim (AC-2 path stays open for admin)',
    !bindClaim.error && bindClaim.data?.length === 1, bindClaim.error?.message ?? `rows=${bindClaim.data?.length}`);

  // 4. Seed 101 posts on the victim profile so the AC-5 clamp is actually exercised.
  const rows = Array.from({ length: 101 }, (_, i) => ({
    profile_id: victimClaimedProfileId, external_post_id: `post-${stamp}-${i}`,
    views: 1000 + i, likes: i, comments: 0, shares: 0,
    caption_excerpt: `seed ${i}`, content_type: 'video',
  }));
  const seed = await svc.from('post_snapshot').insert(rows).select('id');
  if (seed.error) throw new Error(`seed posts: ${seed.error.message}`);
  check('Setup: seeded 101 post_snapshots for the clamp test', seed.data?.length === 101, `inserted=${seed.data?.length}`);
}

async function attackerClient() {
  const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const s = await c.auth.signInWithPassword({ email: attackerEmail, password: PW });
  if (s.error) throw new Error(`attacker sign-in: ${s.error.message}`);
  return c;
}

async function run() {
  console.log(`\nAccess-control RLS regression — ${URL}\n`);
  await setup();
  const atk = await attackerClient();

  console.log('\n[AC-1] creator_link self-update (repoint creator_id at the victim):');
  const upd = await atk.from('creator_link')
    .update({ creator_id: victimCreatorId }).eq('user_id', attackerId).select();
  // No UPDATE policy for authenticated → RLS matches 0 rows (silent) OR errors.
  const updBlocked = (upd.data?.length ?? 0) === 0;
  check('AC-1: attacker UPDATE creator_link returns no affected row', updBlocked,
    upd.error ? `error=${upd.error.message}` : `rows=${upd.data?.length}`);
  // Ground truth: creator_id must be UNCHANGED (still attacker's own, not victim's).
  const linkNow = await svc.from('creator_link').select('creator_id').eq('user_id', attackerId).single();
  check('AC-1: creator_link.creator_id is UNCHANGED after the attack',
    linkNow.data?.creator_id === attackerCreatorId,
    `creator_id=${linkNow.data?.creator_id} (attacker=${attackerCreatorId}, victim=${victimCreatorId})`);

  console.log('\n[AC-2] profile_claim self-insert (claim the victim\'s UNCLAIMED profile as owner):');
  // Target a profile with NO existing claim, so the only thing that can stop the
  // insert is the dropped "user inserts own claims" RLS policy (not a collision).
  const ins = await atk.from('profile_claim').insert({
    user_id: attackerId, profile_id: victimUnclaimedProfileId, claim_kind: 'owner', claimed_via: 'manual',
  }).select();
  const insBlocked = !!ins.error || (ins.data?.length ?? 0) === 0;
  check('AC-2: attacker INSERT profile_claim(owner) is denied', insBlocked,
    ins.error ? `error=${ins.error.message}` : `rows=${ins.data?.length}`);
  // Ground truth: no such claim exists.
  const claimNow = await svc.from('profile_claim').select('*')
    .eq('user_id', attackerId).eq('profile_id', victimUnclaimedProfileId);
  check('AC-2: no attacker→victim claim row exists in the DB', (claimNow.data?.length ?? 0) === 0,
    `rows=${claimNow.data?.length}`);

  console.log('\n[AC-2b] profile_claim self-delete (delete the victim\'s owner claim):');
  const del = await atk.from('profile_claim').delete()
    .eq('user_id', victimId).eq('profile_id', victimClaimedProfileId).select();
  const delBlocked = (del.data?.length ?? 0) === 0;
  check('AC-2b: attacker DELETE of victim claim affects no row', delBlocked,
    del.error ? `error=${del.error.message}` : `rows=${del.data?.length}`);
  const victimClaimStill = await svc.from('profile_claim').select('*')
    .eq('user_id', victimId).eq('profile_id', victimClaimedProfileId);
  check('AC-2b: victim\'s claim still present after the attack', (victimClaimStill.data?.length ?? 0) === 1,
    `rows=${victimClaimStill.data?.length}`);

  console.log('\n[positive] legitimate own-row reads must still work:');
  const ownLink = await atk.from('creator_link').select('user_id, creator_id').eq('user_id', attackerId);
  check('READ: attacker can read their OWN creator_link', (ownLink.data?.length ?? 0) === 1,
    ownLink.error?.message ?? `rows=${ownLink.data?.length}`);
  const victimLinkRead = await atk.from('creator_link').select('user_id').eq('user_id', victimId);
  check('READ-SCOPE: attacker CANNOT read the victim\'s creator_link (RLS scopes to own)',
    (victimLinkRead.data?.length ?? 0) === 0, `rows=${victimLinkRead.data?.length}`);

  console.log('\n[AC-5] top_content_windowed.p_limit clamp (anon, direct RPC):');
  const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const huge = await anon.rpc('top_content_windowed', { p_window: 'lifetime', p_limit: 10_000_000 });
  check('AC-5: p_limit=10,000,000 is clamped to <= 100 rows',
    !huge.error && (huge.data?.length ?? 0) <= 100 && (huge.data?.length ?? 0) === 100,
    huge.error?.message ?? `rows=${huge.data?.length} (seeded 101)`);
  const neg = await anon.rpc('top_content_windowed', { p_window: 'lifetime', p_limit: -5 });
  check('AC-5: negative p_limit is floored to 1 row', !neg.error && (neg.data?.length ?? 0) === 1,
    neg.error?.message ?? `rows=${neg.data?.length}`);
  const five = await anon.rpc('top_content_windowed', { p_window: 'lifetime', p_limit: 5 });
  check('AC-5: a normal p_limit=5 is honored unchanged', !five.error && (five.data?.length ?? 0) === 5,
    five.error?.message ?? `rows=${five.data?.length}`);
  const badWindow = await anon.rpc('top_content_windowed', { p_window: 'bogus', p_limit: 5 });
  check('AC-5: invalid p_window still raises (defense-in-depth intact)', !!badWindow.error,
    badWindow.error?.message ?? 'no error');
}

async function cleanup() {
  // Cascades: deleting the auth users removes user_role/creator_link/claims;
  // deleting creators cascades profiles + snapshots.
  try {
    await svc.from('creator').delete().in('id', [attackerCreatorId, victimCreatorId].filter(Boolean));
    if (attackerId) await svc.auth.admin.deleteUser(attackerId);
    if (victimId) await svc.auth.admin.deleteUser(victimId);
  } catch (e) {
    console.warn('cleanup warning:', e.message);
  }
}

try {
  await run();
} catch (e) {
  console.error('\nTEST HARNESS ERROR:', e.message);
  fail++;
} finally {
  await cleanup();
}

console.log(`\n──────────────────────────────\n  ${pass} passed, ${fail} failed\n──────────────────────────────`);
process.exit(fail === 0 ? 0 : 1);
