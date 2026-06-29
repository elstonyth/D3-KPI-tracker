/**
 * Reproduces approveClaim's owner-guard logic (actions.ts) against a LOCAL stack:
 *   - approving a pending claim on an UNOWNED profile promotes it to owner (ok)
 *   - approving on an ALREADY-OWNED profile is blocked with a clear message and
 *     leaves the pending claim untouched.
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm exec tsx supabase/tests/approve-claim-guard.mts
 */
import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin, ensureCreatorForUser, findOrCreateProfile } from '@d3/database';

const sb = getSupabaseAdmin();
let pass = 0, fail = 0;
function check(n: string, ok: boolean, d = '') { ok ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`)); }
const userIds: string[] = [];
const creatorIds: string[] = [];

// The production guard, reproduced (actions.ts approveClaim minus requireAdmin/revalidate).
async function approve(userId: string, profileId: string): Promise<{ ok: boolean; message: string }> {
  const owner = await sb.from('profile_claim').select('user_id').eq('profile_id', profileId).eq('claim_kind', 'owner').maybeSingle();
  if (owner.data && owner.data.user_id !== userId) {
    return { ok: false, message: "This profile already has an owner — reject this claim, or reassign ownership from the creator's editor." };
  }
  const { error } = await sb.from('profile_claim').update({ claim_kind: 'owner', confirmed_at: new Date().toISOString() }).eq('user_id', userId).eq('profile_id', profileId);
  if (error) return { ok: false, message: error.code === '23505' ? "This profile already has an owner — reject this claim, or reassign ownership from the creator's editor." : 'Could not approve the claim.' };
  return { ok: true, message: 'Claim approved.' };
}

async function mkUser() {
  const u = await sb.auth.admin.createUser({ email: `g_${randomUUID().slice(0, 8)}@test.local`, password: randomUUID(), email_confirm: true });
  userIds.push(u.data.user!.id); return u.data.user!.id;
}

async function main() {
  const owner = await mkUser();
  const cr = await ensureCreatorForUser({ user_id: owner, display_name: `Guard ${randomUUID().slice(0, 4)}` });
  if (!cr.ok) throw new Error(`ensureCreatorForUser failed: ${cr.error}`);
  creatorIds.push(cr.value.creator_id);
  const prof = await findOrCreateProfile({ platform: 'instagram', profile_url: `https://www.instagram.com/g${randomUUID().slice(0, 8)}`, fallback_creator_id: cr.value.creator_id });
  if (prof.ok !== true) throw new Error(`findOrCreateProfile failed: ${prof.error}`);
  const profileId = prof.value.profile.id;

  // Case 1: unowned profile — a pending claim approves cleanly.
  const claimer1 = await mkUser();
  await sb.from('profile_claim').insert({ user_id: claimer1, profile_id: profileId, claim_kind: 'pending', claimed_via: 'manual', confirmed_at: null });
  const r1 = await approve(claimer1, profileId);
  check('unowned profile: approve succeeds', r1.ok, r1.message);
  const k1 = await sb.from('profile_claim').select('claim_kind').eq('user_id', claimer1).eq('profile_id', profileId).single();
  check('unowned profile: claim is now owner', k1.data?.claim_kind === 'owner');

  // Case 2: now owned — a second pending claim is blocked, left pending.
  const claimer2 = await mkUser();
  await sb.from('profile_claim').insert({ user_id: claimer2, profile_id: profileId, claim_kind: 'pending', claimed_via: 'manual', confirmed_at: null });
  const r2 = await approve(claimer2, profileId);
  check('owned profile: approve blocked (ok === false)', r2.ok === false, r2.message);
  check('owned profile: message explains the conflict', /already has an owner/.test(r2.message), r2.message);
  const k2 = await sb.from('profile_claim').select('claim_kind').eq('user_id', claimer2).eq('profile_id', profileId).single();
  check('owned profile: blocked claim stays pending', k2.data?.claim_kind === 'pending', k2.data?.claim_kind);
}

async function cleanup() {
  if (creatorIds.filter(Boolean).length) await sb.from('creator').delete().in('id', creatorIds.filter(Boolean));
  for (const u of userIds) await sb.auth.admin.deleteUser(u).catch(() => {});
}
try { await main(); } finally { await cleanup(); }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
