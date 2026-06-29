'use server';

/**
 * Admin server actions for profile + claim management.
 *
 * All actions:
 *  1. Re-check is_admin() via the cookie-aware client (defense-in-depth even
 *     though the (admin) layout already gates).
 *  2. Mutate via the service-role client (RLS allows admin via "admin manages *",
 *     but service-role is faster and uniform with the rest of our writes).
 *  3. revalidatePath('/admin/profiles') so the list reflects the change.
 *
 * Each action returns an `ActionResult` rather than throwing, so the client
 * buttons (useActionState) can surface a friendly message instead of an
 * unhandled error boundary. The `prevState` arg is unused but required by the
 * useActionState `(prevState, formData)` signature.
 */

import { revalidatePath } from 'next/cache';
import { getSupabaseAdmin } from '@d3/database';
import { requireAdmin } from '@gitroom/frontend/lib/auth';
import { isUuid } from '@gitroom/frontend/lib/ids';

export interface ActionResult {
  ok: boolean;
  message: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

export async function approveClaim(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const userId = String(formData.get('user_id') ?? '');
    const profileId = String(formData.get('profile_id') ?? '');
    if (!isUuid(userId) || !isUuid(profileId)) {
      return { ok: false, message: 'Invalid user or profile id.' };
    }

    const admin = getSupabaseAdmin();

    // One owner per profile (partial unique profile_claim_one_owner). If another
    // user already owns it, promoting this claim to 'owner' would 23505 — tell the
    // admin plainly instead of failing opaquely.
    const owner = await admin
      .from('profile_claim')
      .select('user_id')
      .eq('profile_id', profileId)
      .eq('claim_kind', 'owner')
      .maybeSingle();
    if (owner.data && owner.data.user_id !== userId) {
      return {
        ok: false,
        message:
          "This profile already has an owner — reject this claim, or reassign ownership from the creator's editor.",
      };
    }

    const { error } = await admin
      .from('profile_claim')
      .update({ claim_kind: 'owner', confirmed_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('profile_id', profileId);
    if (error) {
      console.error('[admin/approveClaim]', error);
      return {
        ok: false,
        message:
          error.code === '23505'
            ? "This profile already has an owner — reject this claim, or reassign ownership from the creator's editor."
            : 'Could not approve the claim.',
      };
    }

    revalidatePath('/admin/profiles');
    return { ok: true, message: 'Claim approved.' };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function rejectClaim(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const userId = String(formData.get('user_id') ?? '');
    const profileId = String(formData.get('profile_id') ?? '');
    if (!isUuid(userId) || !isUuid(profileId)) {
      return { ok: false, message: 'Invalid user or profile id.' };
    }

    const admin = getSupabaseAdmin();
    const { error } = await admin
      .from('profile_claim')
      .delete()
      .eq('user_id', userId)
      .eq('profile_id', profileId);
    if (error) {
      console.error('[admin/rejectClaim]', error);
      return { ok: false, message: 'Could not reject the claim.' };
    }

    revalidatePath('/admin/profiles');
    return { ok: true, message: 'Claim rejected.' };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function deleteProfile(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const profileId = String(formData.get('profile_id') ?? '');
    if (!isUuid(profileId)) {
      return { ok: false, message: 'Invalid profile id.' };
    }

    // ON DELETE CASCADE on profile_claim.profile_id + profile_snapshot.profile_id
    // + post_snapshot.profile_id (per init_v1_core_tables + profile_claim
    // migrations) cleans up dependent rows automatically.
    const admin = getSupabaseAdmin();
    const { error } = await admin.from('profile').delete().eq('id', profileId);
    if (error) {
      console.error('[admin/deleteProfile]', error);
      return { ok: false, message: 'Could not delete the profile.' };
    }

    revalidatePath('/admin/profiles');
    return { ok: true, message: 'Profile deleted.' };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}
