'use server';

/**
 * Admin creator-provisioning action. Mirrors profiles/actions.ts conventions:
 * re-check admin (defense-in-depth), service-role writes, return a result
 * object instead of throwing, revalidatePath.
 *
 * Flow: create the auth login (the handle_new_auth_user trigger assigns
 * role='creator' + an empty creator_link) -> ensureCreatorForUser binds the
 * creator row -> per URL: detectPlatform -> findOrCreateProfile (canonical,
 * validates internally) -> addProfileClaim (owner, admin_assigned).
 *
 * email_confirm:true so the creator can sign in immediately (login-free,
 * agency-provisioned). The auth user is never rolled back on a downstream URL
 * failure — the login is the valuable artifact; failures are reported per-URL.
 */

import { revalidatePath } from 'next/cache';
import {
  getSupabaseAdmin,
  ensureCreatorForUser,
  findOrCreateProfile,
  addProfileClaim,
  detectPlatform,
  resolveShortLink,
} from '@d3/database';
import { requireAdmin } from '@gitroom/frontend/lib/auth';
import { normalizeProvisionUrls } from '@gitroom/frontend/lib/provision-plan';
import {
  validateEmail,
  validatePassword,
  validateDisplayName,
  MAX_PROVISION_URLS,
} from '@gitroom/frontend/lib/account-validation';

export interface UrlResult {
  url: string;
  platform?: string;
  status: 'created' | 'linked' | 'failed';
  detail?: string;
}

export interface ProvisionResult {
  ok: boolean;
  message: string;
  /** Echoed once on success so the admin can hand them to the creator. */
  credentials?: { email: string; password: string };
  urlResults?: UrlResult[];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

export async function createCreator(
  _prev: ProvisionResult | null,
  formData: FormData,
): Promise<ProvisionResult> {
  try {
    await requireAdmin();

    const emailRes = validateEmail(String(formData.get('email') ?? ''));
    if (!emailRes.ok) return { ok: false, message: emailRes.error };
    const email = emailRes.value;

    const passwordRes = validatePassword(String(formData.get('password') ?? ''));
    if (!passwordRes.ok) return { ok: false, message: passwordRes.error };
    const password = passwordRes.value;

    const nameRes = validateDisplayName(String(formData.get('display_name') ?? ''));
    if (!nameRes.ok) return { ok: false, message: nameRes.error };
    const displayName = nameRes.value;

    // Validate the URL list BEFORE creating any auth user — an over-cap
    // submission must not leave an orphaned login/creator behind.
    const urls = normalizeProvisionUrls(formData.getAll('url').map((v) => String(v)));
    if (urls.length > MAX_PROVISION_URLS) {
      return { ok: false, message: `Too many URLs — provide at most ${MAX_PROVISION_URLS}.` };
    }

    const admin = getSupabaseAdmin();

    // 1. Auth login. Trigger assigns role='creator' + empty creator_link.
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (created.error || !created.data.user) {
      return { ok: false, message: created.error?.message ?? 'Could not create the login.' };
    }
    const userId = created.data.user.id;

    // 2. Create + bind the creator row.
    const creatorRes = await ensureCreatorForUser({ user_id: userId, display_name: displayName });
    if (creatorRes.ok !== true) {
      return {
        ok: false,
        message: `Login created, but linking the creator failed: ${creatorRes.error}. Add profiles via /admin/profiles or retry.`,
        credentials: { email, password },
      };
    }
    const creatorId = creatorRes.value.creator_id;

    // 3. Assign social URLs — owner claims, admin-initiated.
    const urlResults: UrlResult[] = [];
    for (const rawUrl of urls) {
      const url = await resolveShortLink(rawUrl);
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
      urlResults.push({
        url,
        platform,
        status: profileRes.value.created ? 'created' : 'linked',
      });
    }

    revalidatePath('/admin');

    const failures = urlResults.filter((r) => r.status === 'failed').length;
    const message =
      failures === 0
        ? `Created ${displayName}.`
        : `Created ${displayName} — ${failures} URL${failures === 1 ? '' : 's'} need attention.`;
    return { ok: true, message, credentials: { email, password }, urlResults };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}
