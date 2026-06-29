'use server';

/**
 * Per-creator editor actions. Same conventions as profiles/actions.ts: re-check
 * admin, validate ids, service-role writes, return {ok,message} (never throw),
 * revalidatePath. Ownership/URL logic reuses @d3/database helpers.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomBytes } from 'node:crypto';
import {
  getSupabaseAdmin,
  detectPlatform,
  resolveShortLink,
  validateProfileUrl,
  findOrCreateProfile,
  addProfileClaim,
} from '@d3/database';
import { requireAdmin } from '@gitroom/frontend/lib/auth';
import { isUuid } from '@gitroom/frontend/lib/ids';
import { validateDisplayName, validateEmail, validatePassword } from '@gitroom/frontend/lib/account-validation';

export interface ActionResult {
  ok: boolean;
  message: string;
}
export interface PasswordResetResult extends ActionResult {
  credentials?: { email: string; password: string };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

function revalidateCreator(creatorId: string) {
  revalidatePath(`/admin/creators/${creatorId}`);
  revalidatePath('/admin/profiles');
  revalidatePath('/admin');
}

/** crypto-strong, login-friendly throwaway password (passes validatePassword). */
function generatePassword(): string {
  return randomBytes(12).toString('base64url'); // ~16 chars, < 72 bytes
}

export async function renameCreator(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    if (!isUuid(creatorId)) return { ok: false, message: 'Invalid creator id.' };
    const nameRes = validateDisplayName(String(formData.get('display_name') ?? ''));
    if (!nameRes.ok) return { ok: false, message: nameRes.error };

    const admin = getSupabaseAdmin();
    const { error } = await admin.from('creator').update({ display_name: nameRes.value }).eq('id', creatorId);
    if (error) {
      console.error('[admin/renameCreator]', error);
      return { ok: false, message: 'Could not rename the creator.' };
    }
    revalidateCreator(creatorId);
    return { ok: true, message: 'Renamed.' };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function addCreatorUrl(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    if (!isUuid(creatorId)) return { ok: false, message: 'Invalid creator id.' };

    const resolved = await resolveShortLink(String(formData.get('url') ?? ''));
    const platform = detectPlatform(resolved);
    if (!platform) return { ok: false, message: 'Unrecognized platform URL.' };

    const admin = getSupabaseAdmin();
    const profileRes = await findOrCreateProfile({
      platform,
      profile_url: resolved,
      fallback_creator_id: creatorId,
    });
    if (profileRes.ok !== true) return { ok: false, message: profileRes.error };

    // The URL already existed under a DIFFERENT creator — don't steal it.
    if (!profileRes.value.created && profileRes.value.profile.creator_id !== creatorId) {
      return { ok: false, message: 'That profile is already tracked under another creator.' };
    }

    // Owner claim attaches to the creator's login (the first creator_link user).
    const link = await admin
      .from('creator_link')
      .select('user_id')
      .eq('creator_id', creatorId)
      .order('user_id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (link.error) {
      console.error('[admin/addCreatorUrl] creator_link lookup', link.error);
      return { ok: false, message: 'Could not verify the creator login — try again.' };
    }
    if (link.data?.user_id) {
      const claimRes = await addProfileClaim({
        user_id: link.data.user_id,
        profile_id: profileRes.value.profile.id,
        claim_kind: 'owner',
        claimed_via: 'admin_assigned',
      });
      if (claimRes.ok !== true) {
        return { ok: false, message: `Profile saved, but the owner claim failed: ${claimRes.error}` };
      }
    }
    revalidateCreator(creatorId);
    return {
      ok: true,
      message: profileRes.value.created ? `Added ${platform} profile.` : `Linked existing ${platform} profile.`,
    };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function editCreatorUrl(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    const profileId = String(formData.get('profile_id') ?? '');
    if (!isUuid(creatorId) || !isUuid(profileId)) return { ok: false, message: 'Invalid id.' };

    const admin = getSupabaseAdmin();
    const existing = await admin
      .from('profile')
      .select('platform, creator_id')
      .eq('id', profileId)
      .maybeSingle();
    if (existing.error) {
      console.error('[admin/editCreatorUrl] profile fetch', existing.error);
      return { ok: false, message: 'Could not look up the profile.' };
    }
    if (!existing.data || existing.data.creator_id !== creatorId) {
      return { ok: false, message: 'Profile not found for this creator.' };
    }

    const resolved = await resolveShortLink(String(formData.get('url') ?? ''));
    const platform = detectPlatform(resolved);
    if (!platform) return { ok: false, message: 'Unrecognized platform URL.' };
    if (platform !== existing.data.platform) {
      return { ok: false, message: `Different platform — remove this URL and add the new one.` };
    }
    const v = validateProfileUrl(platform, resolved);
    if (v.ok !== true) return { ok: false, message: v.error };

    const { error } = await admin
      .from('profile')
      .update({ profile_url: v.normalizedUrl, handle: v.handle, scrape_status: 'pending' })
      .eq('id', profileId);
    if (error) {
      console.error('[admin/editCreatorUrl]', error);
      return {
        ok: false,
        message: error.code === '23505' ? 'That profile already exists.' : 'Could not update the URL.',
      };
    }
    revalidateCreator(creatorId);
    return { ok: true, message: 'URL updated.' };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function removeCreatorUrl(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    const profileId = String(formData.get('profile_id') ?? '');
    if (!isUuid(creatorId) || !isUuid(profileId)) return { ok: false, message: 'Invalid id.' };

    const admin = getSupabaseAdmin();
    const prof = await admin.from('profile').select('creator_id').eq('id', profileId).maybeSingle();
    if (prof.error || !prof.data || prof.data.creator_id !== creatorId) {
      return { ok: false, message: 'Profile not found for this creator.' };
    }
    const { error } = await admin.from('profile').delete().eq('id', profileId);
    if (error) {
      console.error('[admin/removeCreatorUrl]', error);
      return { ok: false, message: 'Could not remove the URL.' };
    }
    revalidateCreator(creatorId);
    return { ok: true, message: 'URL removed.' };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

/**
 * Provision a login for an EXISTING creator that has none (created before the
 * admin-provisioning flow, e.g. seeded by the scraper as a bare creator row).
 *
 * Mirrors createCreator, but binds to the existing creator instead of making a
 * new one: the signup trigger inserts an empty creator_link, which we upsert to
 * point at this creator (NOT ensureCreatorForUser — that would spawn a second
 * creator). Owner claims are backfilled for the creator's existing profiles so
 * the login reaches full parity with an agency-provisioned one (claims-based
 * /me path + accurate admin ownerCount), not just the creator_id fallback.
 *
 * The auth user is never rolled back on a downstream failure — the login is the
 * valuable artifact and the helpers are idempotent, so a retry heals the rest.
 */
export async function addCreatorLogin(
  _prev: PasswordResetResult | null,
  formData: FormData,
): Promise<PasswordResetResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    if (!isUuid(creatorId)) return { ok: false, message: 'Invalid creator id.' };

    const emailRes = validateEmail(String(formData.get('email') ?? ''));
    if (!emailRes.ok) return { ok: false, message: emailRes.error };
    const email = emailRes.value;

    const typed = String(formData.get('password') ?? '');
    const password = typed.length ? typed : generatePassword();
    const pwRes = validatePassword(password);
    if (!pwRes.ok) return { ok: false, message: pwRes.error };

    const admin = getSupabaseAdmin();

    // Confirm the creator exists (and grab its name for the login metadata).
    const creatorRes = await admin
      .from('creator')
      .select('id, display_name')
      .eq('id', creatorId)
      .maybeSingle();
    if (creatorRes.error || !creatorRes.data) {
      return { ok: false, message: 'Creator not found.' };
    }

    // This action is for credential-less creators only. Refuse if a login is
    // already linked — a second auth user would never collide on user_id, so
    // it would silently spawn a duplicate login (and addCreatorUrl only ever
    // claims onto the first creator_link user). Use Reset password instead.
    const existingLogin = await admin
      .from('creator_link')
      .select('user_id')
      .eq('creator_id', creatorId)
      .limit(1)
      .maybeSingle();
    if (existingLogin.error) {
      console.error('[admin/addCreatorLogin] creator_link lookup', existingLogin.error);
      return { ok: false, message: 'Could not verify existing logins — try again.' };
    }
    if (existingLogin.data?.user_id) {
      return { ok: false, message: 'This creator already has a login — use Reset password instead.' };
    }

    const displayName = (creatorRes.data as { display_name: string }).display_name;

    // 1. Auth login. Trigger assigns role='creator' + empty creator_link.
    const created = await admin.auth.admin.createUser({
      email,
      password: pwRes.value,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (created.error || !created.data.user) {
      return { ok: false, message: created.error?.message ?? 'Could not create the login.' };
    }
    const userId = created.data.user.id;

    // 2. Bind the login to THIS creator (overwrite the trigger's empty link).
    const linked = await admin
      .from('creator_link')
      .upsert(
        { user_id: userId, creator_id: creatorId, onboarding_completed: true },
        { onConflict: 'user_id' },
      );
    if (linked.error) {
      console.error('[admin/addCreatorLogin] creator_link upsert', linked.error);
      return {
        ok: false,
        message: `Login created, but linking it to the creator failed: ${linked.error.message}. Retry to heal.`,
        credentials: { email, password: pwRes.value },
      };
    }

    // 3. Backfill owner claims for the creator's existing profiles (parity with
    //    createCreator). Idempotent — safe on retry.
    let claimFailure: string | null = null;
    const profilesRes = await admin.from('profile').select('id').eq('creator_id', creatorId);
    if (profilesRes.error) {
      console.error('[admin/addCreatorLogin] profile fetch', profilesRes.error);
      claimFailure = profilesRes.error.message;
    } else {
      for (const p of (profilesRes.data ?? []) as { id: string }[]) {
        const claimRes = await addProfileClaim({
          user_id: userId,
          profile_id: p.id,
          claim_kind: 'owner',
          claimed_via: 'admin_assigned',
        });
        if (claimRes.ok !== true) {
          console.error('[admin/addCreatorLogin] claim', p.id, claimRes.error);
          claimFailure ??= claimRes.error;
        }
      }
    }

    revalidateCreator(creatorId);
    // The login is created and bound (it works via the creator_id fallback), but
    // a failed owner-claim backfill leaves /me parity + ownerCount understated.
    // Report it so the admin sees the gap — never a silent success. Credentials
    // still ride along so the one-time password is never lost.
    if (claimFailure) {
      return {
        ok: false,
        message: `Login created and works, but an owner claim failed (${claimFailure}) — the creator may show fewer owned profiles.`,
        credentials: { email, password: pwRes.value },
      };
    }
    return {
      ok: true,
      message: 'Login created.',
      credentials: { email, password: pwRes.value },
    };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function resetCreatorPassword(
  _prev: PasswordResetResult | null,
  formData: FormData,
): Promise<PasswordResetResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    const userId = String(formData.get('user_id') ?? '');
    if (!isUuid(creatorId) || !isUuid(userId)) return { ok: false, message: 'Invalid id.' };

    const admin = getSupabaseAdmin();
    const link = await admin
      .from('creator_link')
      .select('user_id')
      .eq('user_id', userId)
      .eq('creator_id', creatorId)
      .maybeSingle();
    if (link.error || !link.data) {
      return { ok: false, message: 'That login is not linked to this creator.' };
    }

    const typed = String(formData.get('password') ?? '');
    const password = typed.length ? typed : generatePassword();
    const pwRes = validatePassword(password);
    if (!pwRes.ok) return { ok: false, message: pwRes.error };

    const upd = await admin.auth.admin.updateUserById(userId, { password: pwRes.value });
    if (upd.error || !upd.data.user) {
      console.error('[admin/resetCreatorPassword]', upd.error);
      return { ok: false, message: 'Could not reset the password.' };
    }
    revalidateCreator(creatorId);
    return {
      ok: true,
      message: 'Password reset.',
      credentials: { email: upd.data.user.email ?? '', password: pwRes.value },
    };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function deleteCreator(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = String(formData.get('creator_id') ?? '');
  let done = false;
  try {
    await requireAdmin();
    if (!isUuid(creatorId)) return { ok: false, message: 'Invalid creator id.' };

    const admin = getSupabaseAdmin();
    // Delete linked logins first (cascades user_role + creator_link), then the
    // creator (cascades profiles → claims/snapshots/posts).
    const links = await admin.from('creator_link').select('user_id').eq('creator_id', creatorId);
    if (links.error) {
      console.error('[admin/deleteCreator] creator_link lookup', links.error);
      return { ok: false, message: 'Could not delete the creator.' };
    }
    for (const l of (links.data ?? []) as { user_id: string }[]) {
      const { error: delErr } = await admin.auth.admin.deleteUser(l.user_id);
      if (delErr) console.error('[admin/deleteCreator] deleteUser', l.user_id, delErr);
    }
    const del = await admin.from('creator').delete().eq('id', creatorId);
    if (del.error) {
      console.error('[admin/deleteCreator]', del.error);
      return { ok: false, message: 'Could not delete the creator.' };
    }
    revalidatePath('/admin/profiles');
    revalidatePath('/admin');
    done = true;
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
  // redirect() throws NEXT_REDIRECT — keep it OUTSIDE the try so it isn't caught.
  if (done) redirect('/admin/profiles');
  return { ok: true, message: 'Deleted.' };
}
