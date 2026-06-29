/**
 * End-to-end characterization test for the admin "create a creator" flow.
 *
 * It reproduces the EXACT sequence of apps/frontend/src/app/(admin)/admin/actions.ts
 * `createCreator` (lines 54-146) by calling the SAME underlying functions in the
 * SAME order, against a LOCAL Supabase stack. The only two steps it omits are the
 * Next-runtime-only lines that are NOT provisioning logic:
 *   - requireAdmin()      (authz gate; needs next/headers cookies)
 *   - revalidatePath()    (Next cache; needs next/cache)
 * Everything that actually creates/links rows is the real production code:
 *   validateDisplayName + normalizeProvisionUrls + MAX_PROVISION_URLS  (input layer)
 *   auth.admin.createUser  ->  ensureCreatorForUser  ->  per URL:
 *   detectPlatform  ->  findOrCreateProfile (which runs validateProfileUrl)  ->  addProfileClaim
 *
 * Proves:
 *   A. A single creator can be created with a display name + MULTIPLE URLs across
 *      DIFFERENT platforms (Instagram + TikTok + Facebook), and that the creator
 *      row, all profile rows, the creator_link binding, and all owner claims are
 *      created and correctly linked.
 *   B. The two-layer URL rejection from Q4: an unrecognized host fails at
 *      detectPlatform; a post URL / shortlink / non-http on a KNOWN host passes
 *      detectPlatform but is rejected inside findOrCreateProfile. None of the bad
 *      URLs persist a row; the good URL in the same batch still succeeds.
 *
 * Run against a LOCAL Supabase stack only (never prod):
 *   supabase start
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role from `supabase status -o env`> \
 *   pnpm exec tsx supabase/tests/provision-creator.mts
 *
 * Exit code 0 = all checks passed; 1 = at least one failed.
 */

import { randomUUID } from 'node:crypto';
import {
  detectPlatform,
  ensureCreatorForUser,
  findOrCreateProfile,
  addProfileClaim,
  getSupabaseAdmin,
} from '@d3/database';
// Pure, dependency-free input-layer helpers the server action runs before the DB
// path. Imported by relative path (they carry no @gitroom/* path-alias imports).
import { normalizeProvisionUrls } from '../../apps/frontend/src/lib/provision-plan.ts';
import {
  validateDisplayName,
  MAX_PROVISION_URLS,
} from '../../apps/frontend/src/lib/account-validation.ts';

const supabase = getSupabaseAdmin();

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

// Track everything we create so cleanup can remove it (cascades do the rest).
const createdUserIds: string[] = [];
const createdCreatorIds: string[] = [];

type UrlResult = {
  url: string;
  platform?: string;
  status: 'created' | 'linked' | 'failed';
  detail?: string;
};
type ProvisionResult = {
  ok: boolean;
  message: string;
  creatorId?: string;
  userId?: string;
  urlResults?: UrlResult[];
};

/**
 * Faithful mirror of createCreator (actions.ts:54-146) minus requireAdmin +
 * revalidatePath. Email/password are generated here (createCreator validates
 * them; that is not the behavior under test).
 */
async function provisionCreator(input: {
  displayName: string;
  urls: string[];
}): Promise<ProvisionResult> {
  const nameRes = validateDisplayName(input.displayName);
  if (!nameRes.ok) return { ok: false, message: nameRes.error };
  const displayName = nameRes.value;

  const urls = normalizeProvisionUrls(input.urls);
  if (urls.length > MAX_PROVISION_URLS) {
    return { ok: false, message: `Too many URLs — provide at most ${MAX_PROVISION_URLS}.` };
  }

  // 1. Auth login (trigger assigns role='creator' + empty creator_link).
  const email = `prov_${randomUUID().slice(0, 8)}@test.local`;
  const password = randomUUID();
  const created = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (created.error || !created.data.user) {
    return { ok: false, message: created.error?.message ?? 'Could not create the login.' };
  }
  const userId = created.data.user.id;
  createdUserIds.push(userId);

  // 2. Create + bind the creator row.
  const creatorRes = await ensureCreatorForUser({ user_id: userId, display_name: displayName });
  if (creatorRes.ok !== true) {
    return { ok: false, message: `linking the creator failed: ${creatorRes.error}` };
  }
  const creatorId = creatorRes.value.creator_id;
  createdCreatorIds.push(creatorId);

  // 3. Assign social URLs — owner claims, admin-initiated.
  const urlResults: UrlResult[] = [];
  for (const url of urls) {
    const platform = detectPlatform(url);
    if (!platform) {
      urlResults.push({ url, status: 'failed', detail: 'Unrecognized platform URL.' });
      continue;
    }
    const profileRes = await findOrCreateProfile({
      platform,
      profile_url: url,
      fallback_creator_id: creatorId,
    });
    if (profileRes.ok !== true) {
      urlResults.push({ url, platform, status: 'failed', detail: profileRes.error });
      continue;
    }
    const claimRes = await addProfileClaim({
      user_id: userId,
      profile_id: profileRes.value.profile.id,
      claim_kind: 'owner',
      claimed_via: 'admin_assigned',
    });
    if (claimRes.ok !== true) {
      urlResults.push({ url, platform, status: 'failed', detail: claimRes.error });
      continue;
    }
    urlResults.push({ url, platform, status: profileRes.value.created ? 'created' : 'linked' });
  }

  const failures = urlResults.filter((r) => r.status === 'failed').length;
  const message =
    failures === 0
      ? `Created ${displayName}.`
      : `Created ${displayName} — ${failures} URL${failures === 1 ? '' : 's'} need attention.`;
  return { ok: true, message, creatorId, userId, urlResults };
}

async function scenarioA_multiPlatformHappyPath() {
  console.log('\n[A] One creator, display name + 3 URLs across 3 platforms (IG + TikTok + FB):');
  const tag = randomUUID().slice(0, 8);
  const displayName = `Aria ${tag}`;
  // IG + FB intentionally pasted WITHOUT www to also prove host canonicalization.
  const igUrl = `https://instagram.com/aria${tag}`;
  const ttUrl = `https://www.tiktok.com/@aria${tag}`;
  const fbUrl = `https://facebook.com/aria${tag}`;

  const res = await provisionCreator({ displayName, urls: [igUrl, ttUrl, fbUrl] });

  check('A: provisionCreator returned ok', res.ok, res.message);
  const created = (res.urlResults ?? []).filter((r) => r.status === 'created');
  check('A: all 3 URLs reported created', created.length === 3, JSON.stringify(res.urlResults));
  const byPlat = Object.fromEntries((res.urlResults ?? []).map((r) => [r.platform, r.status]));
  check('A: instagram URL detected + created', byPlat.instagram === 'created', JSON.stringify(byPlat));
  check('A: tiktok URL detected + created', byPlat.tiktok === 'created', JSON.stringify(byPlat));
  check('A: facebook URL detected + created', byPlat.facebook === 'created', JSON.stringify(byPlat));

  // --- DB ground truth ---
  const cRow = await supabase.from('creator').select('display_name').eq('id', res.creatorId!).single();
  check(
    'A: creator row exists with the supplied display_name',
    !cRow.error && cRow.data?.display_name === displayName,
    cRow.error?.message ?? `display_name=${cRow.data?.display_name}`,
  );

  const linkRow = await supabase
    .from('creator_link')
    .select('creator_id')
    .eq('user_id', res.userId!)
    .single();
  check(
    'A: creator_link binds the auth user → the creator',
    linkRow.data?.creator_id === res.creatorId,
    `link.creator_id=${linkRow.data?.creator_id} expected=${res.creatorId}`,
  );

  const profs = await supabase.from('profile').select('*').eq('creator_id', res.creatorId!);
  check('A: exactly 3 profile rows linked to the creator', (profs.data?.length ?? 0) === 3, `rows=${profs.data?.length}`);
  const platforms = new Set((profs.data ?? []).map((p) => p.platform));
  check(
    'A: profile rows span instagram + tiktok + facebook',
    platforms.has('instagram') && platforms.has('tiktok') && platforms.has('facebook'),
    [...platforms].join(','),
  );

  const ig = (profs.data ?? []).find((p) => p.platform === 'instagram');
  check(
    'A: instagram profile_url canonicalized to www host',
    ig?.profile_url === `https://www.instagram.com/aria${tag}`,
    ig?.profile_url,
  );
  check('A: instagram handle extracted from path', ig?.handle === `aria${tag}`, ig?.handle);
  const fb = (profs.data ?? []).find((p) => p.platform === 'facebook');
  check(
    'A: facebook profile_url canonicalized to www host',
    fb?.profile_url === `https://www.facebook.com/aria${tag}`,
    fb?.profile_url,
  );

  const claims = await supabase.from('profile_claim').select('*').eq('user_id', res.userId!);
  check('A: exactly 3 profile_claim rows for the user', (claims.data?.length ?? 0) === 3, `rows=${claims.data?.length}`);
  check(
    'A: every claim is owner / admin_assigned',
    (claims.data ?? []).every((c) => c.claim_kind === 'owner' && c.claimed_via === 'admin_assigned'),
    JSON.stringify((claims.data ?? []).map((c) => `${c.claim_kind}/${c.claimed_via}`)),
  );
  const profIds = new Set((profs.data ?? []).map((p) => p.id));
  const claimProfileIds = new Set((claims.data ?? []).map((c) => c.profile_id));
  check(
    'A: each claim points at exactly one of the 3 created profiles',
    claimProfileIds.size === 3 && [...claimProfileIds].every((id) => profIds.has(id)),
    `claimProfileIds=${claimProfileIds.size}`,
  );
}

async function scenarioB_negativeUrlHandling() {
  console.log('\n[B] One creator, 1 good URL + 4 bad URLs (Q4 two-layer rejection):');
  const tag = randomUUID().slice(0, 8);
  const goodUrl = `https://www.instagram.com/good${tag}`;
  const unrecognized = 'https://example.com/whoever'; // host not in any pattern
  const postUrl = 'https://www.instagram.com/p/Cabc123'; // known host, post path
  const shortlink = 'https://vm.tiktok.com/ZMabc/'; // known-host redirector
  const nonHttp = `ftp://www.instagram.com/nothttp${tag}`; // known host, wrong scheme

  const res = await provisionCreator({
    displayName: `Bad ${tag}`,
    urls: [goodUrl, unrecognized, postUrl, shortlink, nonHttp],
  });
  check('B: provisionCreator still ok (partial success — login is kept)', res.ok, res.message);

  const r = Object.fromEntries((res.urlResults ?? []).map((x) => [x.url, x]));
  check('B: the 1 good IG URL was created', r[goodUrl]?.status === 'created', JSON.stringify(r[goodUrl]));

  const u1 = r[unrecognized];
  check(
    'B: unrecognized host fails at detectPlatform (no platform, "Unrecognized platform URL.")',
    u1?.status === 'failed' && !u1?.platform && /Unrecognized platform URL\./.test(u1?.detail ?? ''),
    JSON.stringify(u1),
  );

  const u2 = r[postUrl];
  check(
    'B: post URL is detected as instagram but rejected as non-profile by validateProfileUrl',
    u2?.status === 'failed' && u2?.platform === 'instagram' && /not a instagram profile/i.test(u2?.detail ?? ''),
    JSON.stringify(u2),
  );

  const u3 = r[shortlink];
  check(
    'B: tiktok shortlink is detected as tiktok but rejected as a short link',
    u3?.status === 'failed' && u3?.platform === 'tiktok' && /short links?.*(aren.t supported|full)/i.test(u3?.detail ?? ''),
    JSON.stringify(u3),
  );

  const u4 = r[nonHttp];
  check(
    'B: non-http URL is detected by host but rejected as not http(s)',
    u4?.status === 'failed' && u4?.platform === 'instagram' && /http\(s\)/i.test(u4?.detail ?? ''),
    JSON.stringify(u4),
  );

  // --- DB ground truth: bad URLs persisted NOTHING ---
  const bProfs = await supabase.from('profile').select('platform,profile_url').eq('creator_id', res.creatorId!);
  check(
    'B: exactly 1 profile row exists (the 4 bad URLs created no rows)',
    (bProfs.data?.length ?? 0) === 1,
    `rows=${bProfs.data?.length} -> ${JSON.stringify(bProfs.data)}`,
  );
  const bClaims = await supabase.from('profile_claim').select('profile_id').eq('user_id', res.userId!);
  check('B: exactly 1 profile_claim row exists', (bClaims.data?.length ?? 0) === 1, `rows=${bClaims.data?.length}`);
  check(
    'B: exactly 4 URLs reported failed',
    (res.urlResults ?? []).filter((x) => x.status === 'failed').length === 4,
    JSON.stringify((res.urlResults ?? []).map((x) => x.status)),
  );
}

async function scenarioC_overLimitCreatesNothing() {
  console.log('\n[C] Over-limit URL list is rejected BEFORE any account or row is created:');
  const tag = randomUUID().slice(0, 8);
  // MAX_PROVISION_URLS + 1 distinct, individually-valid TikTok profile URLs: the
  // batch is rejected purely on COUNT, before the first side effect (createUser).
  const urls = Array.from(
    { length: MAX_PROVISION_URLS + 1 },
    (_, i) => `https://www.tiktok.com/@over${tag}_${i}`,
  );

  const before = await counts();
  const res = await provisionCreator({ displayName: `Over ${tag}`, urls });
  const after = await counts();

  check('C: over-limit submission is rejected (ok === false)', res.ok === false, res.message);
  check('C: rejection message names the URL cap', /Too many URLs/.test(res.message), res.message);
  check(
    'C: no userId / creatorId returned (early return, nothing provisioned)',
    res.userId === undefined && res.creatorId === undefined,
    JSON.stringify({ userId: res.userId, creatorId: res.creatorId }),
  );
  check(
    'C: NO auth user was created (count unchanged across the call)',
    after.users === before.users,
    `auth users before=${before.users} after=${after.users}`,
  );
  check(
    'C: NO creator row was created (count unchanged across the call)',
    after.creators === before.creators,
    `creators before=${before.creators} after=${after.creators}`,
  );
}

/** Ground-truth counts used to prove the over-limit path is a pure no-op. */
async function counts(): Promise<{ users: number; creators: number }> {
  const u = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const c = await supabase.from('creator').select('*', { count: 'exact', head: true });
  return { users: u.data?.users?.length ?? 0, creators: c.count ?? 0 };
}

async function cleanup() {
  // Deleting the creator cascades its profiles → profile_claims. Deleting the
  // auth user cascades its creator_link + any remaining claims.
  try {
    if (createdCreatorIds.length > 0) {
      await supabase.from('creator').delete().in('id', createdCreatorIds);
    }
    for (const uid of createdUserIds) {
      await supabase.auth.admin.deleteUser(uid).catch(() => {});
    }
  } catch (e) {
    console.warn('cleanup warning:', e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  console.log(`\nProvision-creator E2E — ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL}\n`);
  try {
    await scenarioA_multiPlatformHappyPath();
    await scenarioB_negativeUrlHandling();
    await scenarioC_overLimitCreatesNothing();
  } catch (e) {
    console.error('\nTEST HARNESS ERROR:', e instanceof Error ? e.message : String(e));
    fail++;
  } finally {
    await cleanup();
  }
  console.log(`\n──────────────────────────────\n  ${pass} passed, ${fail} failed\n──────────────────────────────`);
  process.exit(fail === 0 ? 0 : 1);
}

await main();
