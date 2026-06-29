/**
 * Creator profile resolution + shared metric formatters.
 *
 * resolveCreatorProfiles is the source of truth for *which* profiles a creator
 * user sees (confirmed owner + tracker claims, with a legacy profile.creator_id
 * fallback), shared by /me and /me/leaderboard. All reads go through the
 * cookie-aware client passed in by the caller (NOT service-role) — the data
 * tables are public-read for the showcase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResolvedProfile {
  id: string;
  platform: string;
  handle: string | null;
  display_name: string | null;
  profile_url: string;
  scrape_status: string;
}

/**
 * The set of profiles a creator user should see, and where it came from.
 * Source of truth is profile_claim (confirmed owner + tracker), with a legacy
 * profile.creator_id fallback. Shared by /me and /me/leaderboard.
 */
export async function resolveCreatorProfiles(
  sb: SupabaseClient,
  args: { userId: string; creatorId: string | null },
): Promise<{ profiles: ResolvedProfile[]; source: 'claims' | 'creator_id' }> {
  const claimsRes = await sb
    .from('profile_claim')
    .select(
      'profile:profile_id(id, platform, handle, display_name, profile_url, scrape_status)',
    )
    .eq('user_id', args.userId)
    .in('claim_kind', ['owner', 'tracker'])
    .not('confirmed_at', 'is', null);

  const claimed = ((claimsRes.data ?? []) as unknown as { profile: ResolvedProfile | null }[])
    .map((c) => c.profile)
    .filter((p): p is ResolvedProfile => p != null);

  if (claimed.length > 0) return { profiles: claimed, source: 'claims' };

  if (args.creatorId) {
    const { data } = await sb
      .from('profile')
      .select('id, platform, handle, display_name, profile_url, scrape_status')
      .eq('creator_id', args.creatorId);
    return { profiles: (data ?? []) as ResolvedProfile[], source: 'creator_id' };
  }

  return { profiles: [], source: 'claims' };
}

// --- Formatters -------------------------------------------------------------

const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
});

export function formatCompact(n: number | null): string {
  if (n == null) return '—';
  return compactFmt.format(n);
}

/** Signed compact delta, e.g. "+1.2K" / "-340" / "0". */
export function formatDelta(n: number | null): string {
  if (n == null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${compactFmt.format(n)}`;
}

/** Fraction → percent string, e.g. 0.0423 → "4.2%". */
export function formatPercent(fraction: number | null): string {
  if (fraction == null) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
}
