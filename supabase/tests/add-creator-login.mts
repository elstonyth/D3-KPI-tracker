/**
 * Characterization test for the per-creator "add a login" action LOGIC
 * (creators/[id]/actions.ts `addCreatorLogin`), reproduced minus
 * requireAdmin/revalidatePath, against a LOCAL Supabase stack.
 *
 * Models the real-world case the feature exists for: a creator seeded by the
 * scraper as a BARE row (profiles, but no creator_link / no login). It then runs
 * the exact step sequence addCreatorLogin uses — validate → createUser (trigger
 * fires role+empty link) → creator_link upsert(onConflict user_id) → backfill
 * owner claims for existing profiles — and asserts the result THROUGH the same
 * read path the admin UI renders (getAdminCreatorDetail): the login now appears
 * and the profile shows an owner claim.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm exec tsx supabase/tests/add-creator-login.mts
 *
 * Exit code 0 = all checks passed; 1 = at least one failed.
 */
import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin, addProfileClaim } from '@d3/database';
import { getAdminCreatorDetail } from '../../apps/frontend/src/lib/admin-creators.ts';
import { validateEmail, validatePassword } from '../../apps/frontend/src/lib/account-validation.ts';

const sb = getSupabaseAdmin();
let pass = 0, fail = 0;
function check(n: string, ok: boolean, d = '') {
  ok ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`));
}
const userIds: string[] = [];
const creatorIds: string[] = [];

/** A scraper-seeded creator: creator row + one profile, NO login. */
async function mkBareCreator(): Promise<{ creatorId: string; profileId: string }> {
  const cr = await sb.from('creator').insert({ display_name: 'Bare Seeded' }).select('id').single();
  const creatorId = cr.data!.id as string;
  creatorIds.push(creatorId);
  const tag = randomUUID().slice(0, 8);
  const pr = await sb
    .from('profile')
    .insert({ creator_id: creatorId, platform: 'tiktok', profile_url: `https://www.tiktok.com/@bare${tag}`, handle: `bare${tag}` })
    .select('id')
    .single();
  return { creatorId, profileId: pr.data!.id as string };
}

/** Reproduced core of addCreatorLogin (minus requireAdmin/revalidatePath). */
async function addLogin(creatorId: string, email: string, password: string) {
  const emailRes = validateEmail(email);
  if (!emailRes.ok) return { ok: false as const, message: emailRes.error };
  const pwRes = validatePassword(password);
  if (!pwRes.ok) return { ok: false as const, message: pwRes.error };

  const creatorRes = await sb.from('creator').select('id, display_name').eq('id', creatorId).maybeSingle();
  if (creatorRes.error || !creatorRes.data) return { ok: false as const, message: 'Creator not found.' };

  // Guard: credential-less creators only — refuse if a login is already linked.
  const existingLogin = await sb.from('creator_link').select('user_id').eq('creator_id', creatorId).limit(1).maybeSingle();
  if (existingLogin.error) return { ok: false as const, message: 'Could not verify existing logins — try again.' };
  if (existingLogin.data?.user_id) return { ok: false as const, message: 'This creator already has a login — use Reset password instead.' };

  const displayName = (creatorRes.data as { display_name: string }).display_name;

  // 1. Auth login. Trigger assigns role='creator' + empty creator_link.
  const created = await sb.auth.admin.createUser({
    email: emailRes.value, password: pwRes.value, email_confirm: true, user_metadata: { display_name: displayName },
  });
  if (created.error || !created.data.user) return { ok: false as const, message: created.error?.message ?? 'create failed' };
  const userId = created.data.user.id;
  userIds.push(userId);

  // 2. Bind the login to THIS creator (overwrite the trigger's empty link).
  const linked = await sb.from('creator_link').upsert(
    { user_id: userId, creator_id: creatorId, onboarding_completed: true },
    { onConflict: 'user_id' },
  );
  if (linked.error) return { ok: false as const, message: linked.error.message };

  // 3. Backfill owner claims for the creator's existing profiles.
  const profilesRes = await sb.from('profile').select('id').eq('creator_id', creatorId);
  for (const p of (profilesRes.data ?? []) as { id: string }[]) {
    await addProfileClaim({ user_id: userId, profile_id: p.id, claim_kind: 'owner', claimed_via: 'admin_assigned' });
  }
  return { ok: true as const, userId, credentials: { email: emailRes.value, password: pwRes.value } };
}

async function main() {
  const { creatorId, profileId } = await mkBareCreator();

  // Baseline: the bare creator reads back with NO login and NO owner claim.
  const before = await getAdminCreatorDetail(sb, creatorId);
  check('bare creator has no login', (before?.logins.length ?? -1) === 0, `logins=${before?.logins.length}`);
  check('bare creator profile has no owner claim',
    before?.profiles.find((p) => p.id === profileId)?.ownerCount === 0,
    `ownerCount=${before?.profiles.find((p) => p.id === profileId)?.ownerCount}`);

  // Add the login.
  const email = `seeded_${randomUUID().slice(0, 8)}@test.local`;
  const res = await addLogin(creatorId, email, ''); // blank password → action generates; here we must supply one
  check('blank password rejected by validatePassword', res.ok === false, res.ok ? 'unexpectedly ok' : res.message);

  const res2 = await addLogin(creatorId, email, randomUUID());
  check('add login ok', res2.ok, res2.ok ? '' : res2.message);
  check('credentials echoed', res2.ok === true && res2.credentials.email === email);

  // Through the UI read path: login now present, owner claim backfilled.
  const after = await getAdminCreatorDetail(sb, creatorId);
  check('login now visible in admin detail', after?.logins.some((l) => l.email === email) === true,
    `logins=${JSON.stringify(after?.logins.map((l) => l.email))}`);
  check('owner claim backfilled for existing profile',
    after?.profiles.find((p) => p.id === profileId)?.ownerCount === 1,
    `ownerCount=${after?.profiles.find((p) => p.id === profileId)?.ownerCount}`);

  // creator_link binds the new user to THIS creator, onboarding completed.
  const link = await sb.from('creator_link').select('creator_id, onboarding_completed').eq('user_id', res2.ok ? res2.userId : '').maybeSingle();
  check('creator_link binds user → creator', link.data?.creator_id === creatorId, link.data?.creator_id ?? 'none');
  check('creator_link onboarding_completed', link.data?.onboarding_completed === true);

  // Trigger assigned role='creator'.
  const role = await sb.from('user_role').select('role').eq('user_id', res2.ok ? res2.userId : '').maybeSingle();
  check('signup trigger set role=creator', role.data?.role === 'creator', role.data?.role ?? 'none');

  // Guard: a creator that already has a login rejects a second provision
  // (credential-less only — otherwise a duplicate auth user is silently spawned).
  const dupe = await addLogin(creatorId, `dupe_${randomUUID().slice(0, 8)}@test.local`, randomUUID());
  check('second login rejected (already has login)',
    dupe.ok === false && /already has a login/.test(dupe.message),
    dupe.ok ? 'unexpectedly ok' : dupe.message);

  // Idempotent retry: re-running the claim backfill does NOT duplicate the owner claim.
  if (res2.ok) {
    await addProfileClaim({ user_id: res2.userId, profile_id: profileId, claim_kind: 'owner', claimed_via: 'admin_assigned' });
  }
  const retried = await getAdminCreatorDetail(sb, creatorId);
  check('retry does not duplicate owner claim',
    retried?.profiles.find((p) => p.id === profileId)?.ownerCount === 1,
    `ownerCount=${retried?.profiles.find((p) => p.id === profileId)?.ownerCount}`);
}

async function cleanup() {
  for (const u of userIds) await sb.auth.admin.deleteUser(u).catch(() => {});
  if (creatorIds.length) await sb.from('creator').delete().in('id', creatorIds);
}
try { await main(); } catch (e) { console.error('HARNESS ERROR', e); fail++; } finally { await cleanup(); }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
