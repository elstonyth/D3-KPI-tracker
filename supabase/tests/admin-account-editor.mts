/**
 * Characterization test for the per-creator editor action LOGIC (creators/[id]/
 * actions.ts), reproduced minus requireAdmin/revalidatePath/redirect, against a
 * LOCAL Supabase stack.
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm exec tsx supabase/tests/admin-account-editor.mts
 */
import { randomUUID } from 'node:crypto';
import {
  getSupabaseAdmin, ensureCreatorForUser, detectPlatform, validateProfileUrl, findOrCreateProfile, addProfileClaim,
} from '@d3/database';
import { validateDisplayName } from '../../apps/frontend/src/lib/account-validation.ts';

const sb = getSupabaseAdmin();
let pass = 0, fail = 0;
function check(n: string, ok: boolean, d = '') { ok ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`)); }
const userIds: string[] = [];
const creatorIds: string[] = [];

async function mkCreator(): Promise<{ creatorId: string; userId: string }> {
  const u = await sb.auth.admin.createUser({ email: `e_${randomUUID().slice(0, 8)}@test.local`, password: randomUUID(), email_confirm: true });
  const userId = u.data.user!.id; userIds.push(userId);
  const cr = await ensureCreatorForUser({ user_id: userId, display_name: 'Editme' });
  const creatorId = cr.ok ? cr.value.creator_id : '';
  creatorIds.push(creatorId);
  return { creatorId, userId };
}

// --- reproduced action cores ---
async function rename(creatorId: string, name: string) {
  const v = validateDisplayName(name);
  if (!v.ok) return { ok: false, message: v.error };
  const { error } = await sb.from('creator').update({ display_name: v.value }).eq('id', creatorId);
  return error ? { ok: false, message: 'fail' } : { ok: true, message: 'Renamed.' };
}
async function addUrl(creatorId: string, userId: string, url: string) {
  const platform = detectPlatform(url);
  if (!platform) return { ok: false, message: 'Unrecognized platform URL.' };
  const pr = await findOrCreateProfile({ platform, profile_url: url, fallback_creator_id: creatorId });
  if (pr.ok !== true) return { ok: false, message: pr.error };
  if (!pr.value.created && pr.value.profile.creator_id !== creatorId) return { ok: false, message: 'other creator' };
  await addProfileClaim({ user_id: userId, profile_id: pr.value.profile.id, claim_kind: 'owner', claimed_via: 'admin_assigned' });
  return { ok: true, message: 'added', profileId: pr.value.profile.id };
}
async function editUrl(creatorId: string, profileId: string, newUrl: string) {
  const existing = await sb.from('profile').select('platform, creator_id').eq('id', profileId).maybeSingle();
  if (!existing.data || existing.data.creator_id !== creatorId) return { ok: false, message: 'not found' };
  const platform = detectPlatform(newUrl);
  if (!platform) return { ok: false, message: 'Unrecognized platform URL.' };
  if (platform !== existing.data.platform) return { ok: false, message: 'Different platform — remove this URL and add the new one.' };
  const v = validateProfileUrl(platform, newUrl);
  if (v.ok !== true) return { ok: false, message: v.error };
  const { error } = await sb.from('profile').update({ profile_url: v.normalizedUrl, handle: v.handle, scrape_status: 'pending' }).eq('id', profileId);
  if (error) return { ok: false, message: error.code === '23505' ? 'That profile already exists.' : 'fail' };
  return { ok: true, message: 'URL updated.' };
}

async function main() {
  const { creatorId, userId } = await mkCreator();

  // rename
  const r = await rename(creatorId, 'Renamed Creator');
  check('rename ok', r.ok, r.message);
  const c = await sb.from('creator').select('display_name').eq('id', creatorId).single();
  check('rename persisted', c.data?.display_name === 'Renamed Creator', c.data?.display_name);

  // add url
  const tag = randomUUID().slice(0, 8);
  const add = await addUrl(creatorId, userId, `https://www.instagram.com/ed${tag}`);
  check('add url ok', add.ok, add.message);
  const profileId = (add as { profileId?: string }).profileId ?? '';

  // seed a snapshot, then re-point (same platform): snapshot must survive
  await sb.from('profile_snapshot').insert({ profile_id: profileId, captured_date: '2026-05-01', followers: 100 });
  const ed = await editUrl(creatorId, profileId, `https://www.instagram.com/ed${tag}_new`);
  check('re-point ok', ed.ok, ed.message);
  const p = await sb.from('profile').select('profile_url, handle').eq('id', profileId).single();
  check('re-point updated url in place', p.data?.profile_url === `https://www.instagram.com/ed${tag}_new`, p.data?.profile_url);
  const snaps = await sb.from('profile_snapshot').select('id').eq('profile_id', profileId);
  check('re-point PRESERVED snapshot history', (snaps.data?.length ?? 0) === 1, `snaps=${snaps.data?.length}`);

  // cross-platform edit rejected
  const cross = await editUrl(creatorId, profileId, `https://www.tiktok.com/@ed${tag}`);
  check('cross-platform edit rejected', cross.ok === false && /Different platform/.test(cross.message), cross.message);

  // collision: add a 2nd IG profile, then try to re-point the first onto it
  const add2 = await addUrl(creatorId, userId, `https://www.instagram.com/dup${tag}`);
  const collide = await editUrl(creatorId, profileId, `https://www.instagram.com/dup${tag}`);
  check('collision re-point rejected (23505)', collide.ok === false && /already exists/.test(collide.message), collide.message);
  void add2;

  // delete creator: logins first, then creator cascades profiles+snapshots
  const links = await sb.from('creator_link').select('user_id').eq('creator_id', creatorId);
  for (const l of (links.data ?? []) as { user_id: string }[]) await sb.auth.admin.deleteUser(l.user_id).catch(() => {});
  const del = await sb.from('creator').delete().eq('id', creatorId);
  check('delete creator ok', !del.error, del.error?.message ?? '');
  const gone = await sb.from('profile').select('id').eq('creator_id', creatorId);
  check('delete cascaded profiles', (gone.data?.length ?? 0) === 0, `rows=${gone.data?.length}`);
  // already cleaned — drop from tracking so cleanup() doesn't double-delete
  creatorIds.length = 0; userIds.length = 0;
}

async function cleanup() {
  if (creatorIds.filter(Boolean).length) await sb.from('creator').delete().in('id', creatorIds.filter(Boolean));
  for (const u of userIds) await sb.auth.admin.deleteUser(u).catch(() => {});
}
try { await main(); } catch (e) { console.error('HARNESS ERROR', e); fail++; } finally { await cleanup(); }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
