// apps/frontend/src/lib/creator-platform-breakdown.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MetricWindow } from './metrics-windowed';
import { getDashboardViewTotalsWindowed } from './metrics-windowed';
import type { PlatformKey } from '@gitroom/frontend/components/ui/platform-icons';

export interface PlatformCard {
  platform: PlatformKey;
  handle: string;
  followers: number | null;
  views: number | null;
}

// RedNote is excluded from the scoped profile read below.
const ORDER: PlatformKey[] = ['instagram', 'facebook', 'tiktok', 'douyin'];

/**
 * Per-platform summary cards for the creator's own `/me` dashboard. Followers and
 * views are scraped for every platform, scoped to `creatorId` (no full-table scan).
 */
export async function getCreatorPlatformBreakdown(
  window: MetricWindow,
  opts: { client: SupabaseClient; creatorId: string },
): Promise<PlatformCard[]> {
  const { client, creatorId } = opts;

  // Scraped per-platform slots for THIS creator only (scoped — no full scan).
  const { data: profs } = await client
    .from('profile')
    .select('id, platform, handle')
    .eq('creator_id', creatorId)
    .neq('platform', 'rednote'); // xiaohongshu archived
  const profileIds = (profs ?? []).map((p) => p.id as string);

  // Latest scraped follower count per profile (newest snapshot wins).
  const followersByProfile = new Map<string, number | null>();
  if (profileIds.length > 0) {
    const { data: snaps } = await client
      .from('profile_snapshot')
      .select('profile_id, followers, captured_at')
      .in('profile_id', profileIds)
      .order('captured_at', { ascending: false })
      .order('id', { ascending: false });
    for (const s of snaps ?? []) {
      const pid = s.profile_id as string;
      if (!followersByProfile.has(pid)) {
        followersByProfile.set(pid, (s.followers as number | null) ?? null);
      }
    }
  }

  const slots = (profs ?? []).map((p) => ({
    profileId: p.id as string,
    platform: p.platform as PlatformKey,
    handle: (p.handle as string | null) ?? null,
    followers: followersByProfile.get(p.id as string) ?? null,
  }));

  // Scraped window views, scoped to this creator.
  const totals = await getDashboardViewTotalsWindowed({
    client,
    creatorIds: [creatorId],
  });
  const viewsByPlatform = totals.byCreator[creatorId] ?? {};

  const cards: PlatformCard[] = [];
  for (const platform of ORDER) {
    const slot = slots.find((s) => s.platform === platform);
    if (!slot || !slot.handle) continue; // not tracked / no handle → skip
    cards.push({
      platform,
      handle: slot.handle,
      followers: slot.followers,
      views: viewsByPlatform[platform]?.[window] ?? null,
    });
  }
  return cards;
}
