/**
 * Server-side query helpers — feed the public showcase pages.
 *
 * All functions:
 *   - Use the publishable-key client (read-only, RLS-permitted public read)
 *   - Are async (called from Server Components)
 *   - Return shapes designed for the existing showcase components so we
 *     don't have to rewrite every page to switch from demo data
 *
 * When DB has zero matching rows, returns null so callers can fall back to
 * demo data (during early-development) or render an empty state (Task 5
 * polish).
 */

import { getSupabaseRead } from './supabase-server';
import { resolveMediaUrl } from './media-url';
import type { TopContentRow } from './metrics-windowed';
import type { PlatformKey } from '@gitroom/frontend/components/ui/platform-icons';
import { VIEW_PERIODS, viewPeriodCutoff, type ViewPeriod } from './view-periods';
import { collapseByContent } from './content-dedup';

// DB stores 'rednote'; showcase uses 'xiaohongshu' — single map point.
function dbPlatformToKey(platform: string): PlatformKey {
  return platform === 'rednote' ? 'xiaohongshu' : (platform as PlatformKey);
}

/**
 * Fetch EVERY row of a query, paging past PostgREST's response cap.
 *
 * PostgREST caps a single response at ~1000 rows regardless of `.limit()`, so a
 * naive `.limit(5000)` silently truncates once a table exceeds 1000 rows — which
 * undercounts any SUM/aggregate built from it (e.g. total views). We page with
 * `.range()` until a short page comes back. The caller MUST order by a stable
 * total order (e.g. `captured_at desc, id desc`) so pages don't overlap or skip.
 */
async function fetchAllRows<T>(
  buildPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await buildPage(from, from + PAGE - 1);
    if (res.error) return { rows, error: res.error };
    const page = res.data ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows, error: null };
}

/**
 * Combined totals for one of a creator's platform profiles. The public site
 * shows totals (current followers + Σ current views across tracked posts), never
 * deltas — so these need no historical baseline and never read "Building history".
 */
export interface CreatorPlatformMetric {
  platform: PlatformKey;
  /** DB platform string (e.g. 'rednote' even when key is 'xiaohongshu'). */
  dbPlatform: string;
  handle: string | null;
  followers: number;
  /** Σ current view count across this profile's tracked recent posts. */
  totalViews: number;
  /** Σ (likes + comments + shares) across this profile's tracked recent posts. */
  totalEngagement: number;
  postCount: number;
}

export interface LiveCreatorRow {
  rank: number;
  creatorId: string;
  /** Display name (creator.display_name, else the primary profile handle). */
  displayName: string;
  /** Render-ready avatar URL (resolveMediaUrl-resolved); null when none stored. */
  avatarUrl: string | null;
  /** Highest-follower profile's handle — the slug for /creators/<handle>. */
  primaryHandle: string | null;
  /** Platform of the highest-follower profile (drives the row icon). */
  primaryPlatform: PlatformKey;
  /** Whole-creator total: Σ latest followers across the creator's profiles. */
  followers: number;
  /** Combined Σ current views across all the creator's tracked recent posts. */
  totalViews: number;
  /** Combined Σ (likes+comments+shares) across those posts. */
  totalEngagement: number;
  /** One entry per platform the creator is on — powers correct per-platform
   *  filtering (pick the matching slot) without mis-attributing a creator's
   *  whole audience to its primary platform. */
  platforms: CreatorPlatformMetric[];
}

export interface SiteSummary {
  /** Creators with at least one (non-archived) profile. */
  trackedCreators: number;
  combinedFollowers: number;
  /** Σ current views across every tracked recent post. */
  combinedViews: number;
}

/**
 * One row per creator with combined totals AND a per-platform breakdown.
 * Single fetch (creators + profiles + latest snapshots + posts); the public
 * pages derive the site summary, platform breakdown, and top-N from this with
 * the pure helpers below — no deltas, no historical baseline.
 *
 * Returns null if DB has zero creators-with-profiles (caller falls back to demo).
 */
/**
 * Max views per (profile_id, external_post_id) across all snapshots. Views are
 * monotonic — a transient bad re-scrape (e.g. a stats endpoint momentarily
 * returning 0, as happened to Douyin during a TikHub-credit outage) must not
 * lower a post's recorded views below an earlier snapshot. Pairs with the
 * newest-row dedup: keep the newest row for likes/caption/thumbnail, but take
 * MAX(views) so one bad snapshot can't undercount the leaderboard.
 */
function maxViewsPerPost(
  rows: ReadonlyArray<{ profile_id: string; external_post_id: string; views: number | null }>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of rows) {
    const key = `${p.profile_id}:${p.external_post_id}`;
    const v = p.views ?? 0;
    if (v > (m.get(key) ?? -1)) m.set(key, v);
  }
  return m;
}

export async function getLiveCreatorRows(): Promise<LiveCreatorRow[] | null> {
  const sb = getSupabaseRead();

  // 1. Creators + their profiles
  const creators = await sb.from('creator').select('id, display_name, avatar_url');
  if (creators.error || !creators.data || creators.data.length === 0) {
    if (creators.error) console.error('[queries] getLiveCreatorRows creators', creators.error);
    return null;
  }

  const profiles = await sb
    .from('profile')
    .select('id, creator_id, platform, handle')
    .neq('platform', 'rednote'); // xiaohongshu archived — exclude from rollups
  if (profiles.error) {
    console.error('[queries] getLiveCreatorRows profiles', profiles.error);
    return null;
  }
  const profilesByCreator = new Map<string, typeof profiles.data>();
  for (const p of profiles.data ?? []) {
    if (!profilesByCreator.has(p.creator_id)) profilesByCreator.set(p.creator_id, []);
    profilesByCreator.get(p.creator_id)!.push(p);
  }

  // 2. Latest snapshot per profile (followers). Paged so a >1000-row
  // profile_snapshot table isn't silently capped (which would drop profiles).
  const snaps = await fetchAllRows<{
    profile_id: string;
    captured_at: string;
    followers: number | null;
  }>((from, to) =>
    sb
      .from('profile_snapshot')
      .select('profile_id, captured_at, followers')
      .order('captured_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
  if (snaps.error) {
    console.error('[queries] getLiveCreatorRows snaps', snaps.error);
    return null;
  }
  const latestFollowers = new Map<string, number>();
  for (const s of snaps.rows) {
    if (!latestFollowers.has(s.profile_id)) latestFollowers.set(s.profile_id, s.followers ?? 0);
  }

  // 3. Latest snapshot per distinct post → combined views + engagement per
  // profile. Dedup to the newest row per post (captured_at DESC) so a post
  // snapshotted across multiple days isn't counted once per day. Paged: post_
  // snapshot routinely exceeds PostgREST's 1000-row cap, which would otherwise
  // undercount total views.
  const posts = await fetchAllRows<{
    profile_id: string;
    external_post_id: string;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    views: number | null;
  }>((from, to) =>
    sb
      .from('post_snapshot')
      .select('profile_id, external_post_id, captured_at, likes, comments, shares, views')
      .order('captured_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
  if (posts.error) {
    console.error('[queries] getLiveCreatorRows posts', posts.error);
    return null;
  }
  const seenPost = new Set<string>();
  const maxViews = maxViewsPerPost(posts.rows);
  const byProfile = new Map<string, { totalViews: number; totalEng: number; count: number }>();
  for (const p of posts.rows) {
    const key = `${p.profile_id}:${p.external_post_id}`;
    if (seenPost.has(key)) continue;
    seenPost.add(key);
    const cur = byProfile.get(p.profile_id) ?? { totalViews: 0, totalEng: 0, count: 0 };
    cur.totalViews += maxViews.get(key) ?? 0;
    cur.totalEng += (p.likes ?? 0) + (p.comments ?? 0) + (p.shares ?? 0);
    cur.count += 1;
    byProfile.set(p.profile_id, cur);
  }

  // 4. Roll up per creator, emitting a per-platform slot for each profile.
  const rows: Omit<LiveCreatorRow, 'rank'>[] = [];
  for (const c of creators.data) {
    const cProfiles = profilesByCreator.get(c.id) ?? [];
    if (cProfiles.length === 0) continue; // 0-profile creators are not "tracked"

    const platforms: CreatorPlatformMetric[] = [];
    let followers = 0;
    let totalViews = 0;
    let totalEngagement = 0;
    for (const p of cProfiles) {
      const f = latestFollowers.get(p.id) ?? 0;
      const e = byProfile.get(p.id) ?? { totalViews: 0, totalEng: 0, count: 0 };
      followers += f;
      totalViews += e.totalViews;
      totalEngagement += e.totalEng;
      platforms.push({
        platform: dbPlatformToKey(p.platform),
        dbPlatform: p.platform,
        handle: p.handle,
        followers: f,
        totalViews: e.totalViews,
        totalEngagement: e.totalEng,
        postCount: e.count,
      });
    }

    // Highest-follower profile decides the primary platform + slug (matches the
    // admin/leaderboard convention; deterministic on a tie via the first seen).
    const primary = platforms.reduce(
      (best, slot) => (slot.followers > best.followers ? slot : best),
      platforms[0],
    );

    rows.push({
      creatorId: c.id,
      displayName: c.display_name ?? primary.handle ?? c.id.slice(0, 8),
      avatarUrl: resolveMediaUrl(c.avatar_url),
      primaryHandle: primary.handle,
      primaryPlatform: primary.platform,
      followers,
      totalViews,
      totalEngagement,
      platforms,
    });
  }

  if (rows.length === 0) return null;
  rows.sort((a, b) => b.followers - a.followers);
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

// ---------- Pure derivations over getLiveCreatorRows() output ----------
// These take the already-fetched rows so a page can fetch once and derive the
// summary / breakdown / top-N without extra round-trips. Pure + unit-testable.

/** Site-wide combined totals (hero strip + dashboard summary). */
export function summarizeCreatorRows(rows: LiveCreatorRow[]): SiteSummary {
  let combinedFollowers = 0;
  let combinedViews = 0;
  for (const r of rows) {
    combinedFollowers += r.followers;
    combinedViews += r.totalViews;
  }
  return { trackedCreators: rows.length, combinedFollowers, combinedViews };
}

/** Top creators by combined followers (home bento, dashboard list). */
export function topCreatorRows(rows: LiveCreatorRow[], limit: number): LiveCreatorRow[] {
  return [...rows]
    .sort((a, b) => b.followers - a.followers)
    .slice(0, limit)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

// ---------- Platform breakdown (home page + dashboard) ----------

export interface LivePlatformBreakdown {
  platform: PlatformKey;
  /** DB platform string (e.g. 'rednote' even when key is 'xiaohongshu'). */
  dbPlatform: string;
  followers: number;
  /** Σ current views across that platform's tracked recent posts. */
  totalViews: number;
  creatorCount: number;
}

/**
 * Per-platform combined totals, derived from getLiveCreatorRows() output. True
 * per-profile aggregation (a multi-platform creator contributes each platform's
 * own followers/views), so the dashboard's per-platform filter is correct.
 */
export function platformBreakdownFromRows(
  rows: LiveCreatorRow[],
): LivePlatformBreakdown[] {
  const byPlatform = new Map<
    PlatformKey,
    { dbPlatform: string; followers: number; totalViews: number; creators: Set<string> }
  >();
  for (const r of rows) {
    for (const slot of r.platforms) {
      const b = byPlatform.get(slot.platform) ?? {
        dbPlatform: slot.dbPlatform,
        followers: 0,
        totalViews: 0,
        creators: new Set<string>(),
      };
      b.followers += slot.followers;
      b.totalViews += slot.totalViews;
      b.creators.add(r.creatorId);
      byPlatform.set(slot.platform, b);
    }
  }
  return [...byPlatform.entries()].map(([platform, b]) => ({
    platform,
    dbPlatform: b.dbPlatform,
    followers: b.followers,
    totalViews: b.totalViews,
    creatorCount: b.creators.size,
  }));
}

// ---------- Top content (public leaderboard) ----------

/**
 * Load every tracked post as a TopContentRow, deduped to the newest snapshot
 * per post. UNSORTED — callers rank it (by views or interactions). Paged past
 * PostgREST's 1000-row cap so no post is silently dropped.
 */
async function loadContentRows(): Promise<TopContentRow[]> {
  const sb = getSupabaseRead();

  const profiles = await sb
    .from('profile')
    .select('id, creator_id, platform, handle')
    .neq('platform', 'rednote'); // xiaohongshu archived
  if (profiles.error || !profiles.data || profiles.data.length === 0) {
    if (profiles.error) console.error('[queries] loadContentRows profiles', profiles.error);
    return [];
  }
  const profMap = new Map(profiles.data.map((p) => [p.id, p]));
  const creatorIds = [...new Set(profiles.data.map((p) => p.creator_id))];
  const creatorsRes = await sb.from('creator').select('id, display_name').in('id', creatorIds);
  const nameByCreator = new Map(
    (creatorsRes.data ?? []).map((c) => [c.id, c.display_name as string | null]),
  );

  const posts = await fetchAllRows<{
    profile_id: string;
    external_post_id: string;
    posted_at: string | null;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    caption_excerpt: string | null;
    media_url: string | null;
    duration_seconds: number | null;
  }>((from, to) =>
    sb
      .from('post_snapshot')
      .select(
        'profile_id, external_post_id, captured_at, posted_at, views, likes, comments, shares, caption_excerpt, media_url, duration_seconds',
      )
      .order('captured_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  );
  if (posts.error) {
    console.error('[queries] loadContentRows posts', posts.error);
    return [];
  }

  const seen = new Set<string>();
  const maxViews = maxViewsPerPost(posts.rows);
  const out: TopContentRow[] = [];
  for (const p of posts.rows) {
    const prof = profMap.get(p.profile_id);
    if (!prof) continue; // rednote-excluded / unknown profile
    const key = `${p.profile_id}:${p.external_post_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const views = maxViews.get(key) ?? (p.views ?? 0);
    out.push({
      externalPostId: p.external_post_id,
      profileId: p.profile_id,
      creatorId: prof.creator_id,
      creatorName: nameByCreator.get(prof.creator_id) ?? prof.handle ?? null,
      platform: prof.platform,
      handle: prof.handle,
      captionExcerpt: p.caption_excerpt ?? null,
      thumbnailUrl: resolveMediaUrl(p.media_url),
      postedAt: p.posted_at ?? null,
      viewsGained: views,
      currentViews: views,
      likes: p.likes ?? 0,
      comments: p.comments ?? 0,
      shares: p.shares ?? 0,
      durationSeconds: p.duration_seconds ?? null,
    });
  }
  return out;
}

/** Σ public interactions for a post — likes + comments + shares. */
export function postInteractions(r: TopContentRow): number {
  return r.likes + r.comments + r.shares;
}

/** Top posts ranked by current views (drop-in for <ViewLeaderboard>). */
export async function getTopContent(limit = 20): Promise<TopContentRow[]> {
  const rows = await loadContentRows();
  return [...rows].sort((a, b) => b.currentViews - a.currentViews).slice(0, limit);
}

/**
 * Top content ranked two ways (by views, by interactions) for EACH time window,
 * from a SINGLE post fetch. Window = posts PUBLISHED in the window (matches the
 * dashboard pills); `lifetime` = no date filter. Powers the leaderboard's
 * time-filtered content grids. Posts with no postedAt appear only under `lifetime`.
 */
export async function getTopContentRankingsWindowed(
  limit = 12,
): Promise<Record<ViewPeriod, { byViews: TopContentRow[]; byInteractions: TopContentRow[] }>> {
  const rows = await loadContentRows();
  const nowMs = Date.now();
  const out = {} as Record<
    ViewPeriod,
    { byViews: TopContentRow[]; byInteractions: TopContentRow[] }
  >;
  for (const { value: period } of VIEW_PERIODS) {
    const cutoff = viewPeriodCutoff(period, nowMs);
    const inWindow =
      cutoff == null
        ? rows
        : rows.filter((r) => r.postedAt != null && Date.parse(r.postedAt) >= cutoff);
    // Collapse cross-platform duplicates (same creator + duration + caption hook)
    // per metric — a content group's most-viewed and most-engaging copies can be
    // on different platforms — then rank the survivors and take the top N.
    out[period] = {
      byViews: collapseByContent(inWindow, (r) => r.currentViews)
        .sort((a, b) => b.currentViews - a.currentViews)
        .slice(0, limit),
      byInteractions: collapseByContent(inWindow, postInteractions)
        .sort((a, b) => postInteractions(b) - postInteractions(a))
        .slice(0, limit),
    };
  }
  return out;
}

// ---------- Creator detail (Task 5 step 3) ----------

export interface CreatorPlatformSlot {
  /** Internal profile.id — needed so per-platform queries can avoid an extra lookup. */
  profileId: string;
  platform: PlatformKey;
  /** The DB platform string (e.g. 'rednote' even when key is 'xiaohongshu'). */
  dbPlatform: string;
  handle: string | null;
  nickname: string | null;
  profileUrl: string;
  followers: number | null;
  following: number | null;
  totalPosts: number | null;
  totalViews: number | null;
  totalLikes: number | null;
  capturedAt: string | null;
  scrapeStatus: string;
}

export interface CreatorDetail {
  /** UUID of the creator row */
  creatorId: string;
  /** Best display name found (creator.display_name → snapshot.raw.fullName → handle) */
  displayName: string;
  /** Best avatar URL we have (from latest snapshot.raw.profilePicUrlHD / profilePicUrl) */
  avatarUrl: string | null;
  /** Bio pulled from snapshot.raw.biography */
  biography: string | null;
  /** Sum of latest followers across all profiles */
  totalFollowers: number;
  platforms: CreatorPlatformSlot[];
}

/**
 * Latest snapshot per profile_id. Shared between getCreatorByHandle and
 * getCreatorPlatformDetail.
 *
 * One `.limit(1)` query per profile (a creator has ≤5, one per platform) —
 * NOT a single unbounded `.in()` over full history: PostgREST caps a response
 * at ~1000 rows, so once the profiles' combined daily history exceeded the cap
 * the oldest-updated profile's latest row silently fell off the page and the
 * creator page rendered null followers. A per-profile error is logged and
 * skipped so one bad profile doesn't blank the others.
 *
 * Exported for unit tests (queries.latest-snapshots.test.ts).
 */
export async function latestSnapshotsForProfiles(
  profileIds: string[],
): Promise<Map<string, { followers: number | null; following: number | null; total_posts: number | null; total_views: number | null; total_likes: number | null; captured_at: string; raw: unknown }>> {
  const map = new Map<string, { followers: number | null; following: number | null; total_posts: number | null; total_views: number | null; total_likes: number | null; captured_at: string; raw: unknown }>();
  if (profileIds.length === 0) return map;
  const sb = getSupabaseRead();
  // Dedupe defensively — a repeated id would just burn a redundant query.
  const uniqueIds = Array.from(new Set(profileIds));
  const results = await Promise.all(
    uniqueIds.map((profileId) =>
      sb
        .from('profile_snapshot')
        .select('profile_id, followers, following, total_posts, total_views, total_likes, captured_at, raw')
        .eq('profile_id', profileId)
        .order('captured_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1),
    ),
  );
  for (const res of results) {
    if (res.error) {
      console.error('[queries] latestSnapshotsForProfiles', res.error);
      continue;
    }
    const row = res.data?.[0];
    if (row && !map.has(row.profile_id)) {
      map.set(row.profile_id, {
        followers: row.followers,
        following: row.following,
        total_posts: row.total_posts,
        total_views: row.total_views,
        total_likes: row.total_likes,
        captured_at: row.captured_at,
        raw: row.raw,
      });
    }
  }
  return map;
}

/** Coerce a value to a non-empty string, else null. */
function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Pull avatar + display name + bio out of a snapshot.raw blob, tolerating the
 * different field names each platform adapter writes:
 *   - Instagram profile raw: profile_pic_url / full_name / biography
 *   - TikTok + Douyin:       avatar_url   / nickname  / biography
 *   - RedNote:               avatar_url   / nickname  / desc
 *   - Facebook:              profile_pic  / page_name / summary_text
 * Legacy Apify rows (camelCase profilePicUrlHD / fullName) are kept as a final
 * fallback so pre-migration snapshots still render.
 */
function extractRawProfileFields(raw: unknown): {
  avatarUrl: string | null;
  fullName: string | null;
  biography: string | null;
} {
  if (!raw || typeof raw !== 'object') {
    return { avatarUrl: null, fullName: null, biography: null };
  }
  const r = raw as Record<string, unknown>;
  return {
    avatarUrl:
      asStr(r.profile_pic_url) ??
      asStr(r.avatar_url) ??
      asStr(r.profile_pic) ??
      asStr(r.profilePicUrlHD) ??
      asStr(r.profilePicUrl),
    fullName:
      asStr(r.full_name) ??
      asStr(r.nickname) ??
      asStr(r.page_name) ??
      asStr(r.fullName),
    biography:
      asStr(r.biography) ??
      asStr(r.desc) ??
      asStr(r.summary_text) ??
      asStr(r.signature),
  };
}

/**
 * Escape Postgres LIKE/ILIKE wildcards so a user-supplied handle is matched
 * literally. Without this, `_`/`%` in the route param act as wildcards and can
 * resolve the WRONG creator (mirrors escapeLikePattern in libraries/database).
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Resolve a creator by any of their profile handles. Returns null when no
 * profile.handle matches and no creator.display_name matches.
 */
export async function getCreatorByHandle(
  handle: string,
): Promise<CreatorDetail | null> {
  const sb = getSupabaseRead();

  // 1. Find profile by handle (case-insensitive)
  const profileRes = await sb
    .from('profile')
    .select('id, creator_id, platform, profile_url, handle, nickname, scrape_status')
    .ilike('handle', escapeLikePattern(handle))
    .neq('platform', 'rednote') // xiaohongshu archived — its handles 404
    .limit(1)
    .maybeSingle();
  if (profileRes.error) {
    console.error('[queries] getCreatorByHandle profile lookup', profileRes.error);
    return null;
  }
  if (!profileRes.data) return null;

  // 2. Pull every profile for that creator
  const allProfilesRes = await sb
    .from('profile')
    .select('id, platform, profile_url, handle, nickname, scrape_status')
    .eq('creator_id', profileRes.data.creator_id)
    .neq('platform', 'rednote'); // xiaohongshu archived — hide its slots
  if (allProfilesRes.error) {
    console.error('[queries] getCreatorByHandle all-profiles', allProfilesRes.error);
    return null;
  }
  const allProfiles = allProfilesRes.data ?? [];

  // 3. Latest snapshots
  const profileIds = allProfiles.map((p) => p.id);
  const latest = await latestSnapshotsForProfiles(profileIds);

  // 4. Pull most-recent post per profile so we get fresh profilePicUrl/biography
  const recentPostRes = await sb
    .from('post_snapshot')
    .select('profile_id, raw, captured_at')
    .in('profile_id', profileIds)
    .order('captured_at', { ascending: false })
    .limit(profileIds.length * 2);
  const postRawByProfile = new Map<string, unknown>();
  for (const r of recentPostRes.data ?? []) {
    if (!postRawByProfile.has(r.profile_id)) {
      postRawByProfile.set(r.profile_id, r.raw);
    }
  }

  // 5. Creator row (display_name)
  const creatorRes = await sb
    .from('creator')
    .select('id, display_name, avatar_url')
    .eq('id', profileRes.data.creator_id)
    .maybeSingle();
  if (creatorRes.error || !creatorRes.data) {
    console.error('[queries] getCreatorByHandle creator', creatorRes.error);
    return null;
  }

  // 6. Roll up
  let totalFollowers = 0;
  let bestAvatar: string | null = resolveMediaUrl(creatorRes.data.avatar_url);
  let bestFullName: string | null = creatorRes.data.display_name;
  let bestBio: string | null = null;
  const slots: CreatorPlatformSlot[] = [];

  for (const p of allProfiles) {
    const snap = latest.get(p.id);
    if (snap?.followers) totalFollowers += snap.followers;

    const rawFromPost = postRawByProfile.get(p.id);
    const rawFromSnap = snap?.raw;
    const fromPost = extractRawProfileFields(rawFromPost);
    const fromSnap = extractRawProfileFields(rawFromSnap);
    if (!bestAvatar) bestAvatar = resolveMediaUrl(fromPost.avatarUrl ?? fromSnap.avatarUrl);
    if (!bestFullName) bestFullName = fromPost.fullName ?? fromSnap.fullName;
    if (!bestBio) bestBio = fromPost.biography ?? fromSnap.biography;

    slots.push({
      profileId: p.id,
      platform: dbPlatformToKey(p.platform),
      dbPlatform: p.platform,
      handle: p.handle,
      nickname: p.nickname,
      profileUrl: p.profile_url,
      followers: snap?.followers ?? null,
      following: snap?.following ?? null,
      totalPosts: snap?.total_posts ?? null,
      totalViews: snap?.total_views ?? null,
      totalLikes: snap?.total_likes ?? null,
      capturedAt: snap?.captured_at ?? null,
      scrapeStatus: p.scrape_status,
    });
  }

  return {
    creatorId: creatorRes.data.id,
    displayName: bestFullName || handle,
    avatarUrl: bestAvatar,
    biography: bestBio,
    totalFollowers,
    platforms: slots,
  };
}

// ---------- Per-platform detail (recent posts) ----------

export interface PlatformPostRow {
  externalId: string;
  url: string;
  type: 'image' | 'video' | 'reel' | 'carousel' | 'note' | 'text';
  thumbnailUrl: string | null;
  caption: string;
  hashtags: string[];
  publishedAt: string;
  likes: number;
  comments: number;
  shares: number;
  views: number | null;
  mediaCount: number | null;
  durationSec: number | null;
}

export interface CreatorPlatformDetail {
  creator: CreatorDetail;
  /** The slot for this specific platform, or null if creator has no profile there. */
  slot: CreatorPlatformSlot | null;
  /** Posts (from post_snapshot). Empty array when nothing scraped yet. */
  posts: PlatformPostRow[];
}

/** Hashtags parsed from caption text — works across every platform since no
 *  adapter writes a structured hashtag array anymore. */
function extractHashtags(caption: string | null): string[] {
  if (!caption) return [];
  const m = caption.match(/#[\p{L}\p{N}_]+/gu);
  return m ? Array.from(new Set(m)) : [];
}

/**
 * Build the canonical permalink for a post, per platform. A raw `url` from the
 * adapter (Facebook posts carry one) always wins; otherwise we synthesize the
 * platform-correct URL from the external id (+ handle for TikTok).
 */
export function buildPostUrl(
  platform: PlatformKey,
  raw: Record<string, unknown>,
  externalId: string,
  handle: string | null,
): string {
  const rawUrl = asStr(raw.url);
  if (rawUrl) return rawUrl;
  switch (platform) {
    case 'instagram': {
      const code = asStr(raw.code) ?? asStr(raw.shortcode) ?? asStr(raw.shortCode) ?? externalId;
      return `https://www.instagram.com/p/${code}/`;
    }
    case 'tiktok':
      return handle
        ? `https://www.tiktok.com/@${handle}/video/${externalId}`
        : `https://www.tiktok.com/`;
    case 'douyin':
      return `https://www.douyin.com/video/${externalId}`;
    case 'xiaohongshu':
      return `https://www.xiaohongshu.com/explore/${externalId}`;
    case 'facebook':
      return `https://www.facebook.com/${externalId}`;
    default:
      return rawUrl ?? '';
  }
}

function mapPostSnapshotToRow(
  platform: PlatformKey,
  raw: unknown,
  content_type: string | null,
  handle: string | null,
  post: { external_post_id: string; posted_at: string | null; caption_excerpt: string | null; likes: number | null; comments: number | null; shares: number | null; views: number | null; media_url: string | null },
): PlatformPostRow {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Instagram carousels expose carousel_media; legacy Apify rows used childPosts.
  const carousel = Array.isArray(r.carousel_media)
    ? (r.carousel_media as unknown[])
    : Array.isArray(r.childPosts)
      ? (r.childPosts as unknown[])
      : [];
  const ct = (content_type ?? 'image').toLowerCase();
  const type: PlatformPostRow['type'] =
    ct === 'reel' ? 'reel'
      : ct === 'video' || ct === 'short' ? 'video'
        : carousel.length > 0 ? 'carousel'
          : 'image';

  return {
    externalId: post.external_post_id,
    url: buildPostUrl(platform, r, post.external_post_id, handle),
    type,
    thumbnailUrl: resolveMediaUrl(post.media_url),
    caption: post.caption_excerpt ?? '',
    hashtags: extractHashtags(post.caption_excerpt),
    publishedAt: post.posted_at ?? new Date().toISOString(),
    likes: post.likes ?? 0,
    comments: post.comments ?? 0,
    shares: post.shares ?? 0,
    views: post.views,
    mediaCount: carousel.length > 0 ? carousel.length + 1 : null,
    durationSec: null, // not surfaced by current adapters; future ones may
  };
}

/**
 * Per-platform creator view. Returns null when the creator handle resolves
 * to nothing; returns CreatorPlatformDetail with empty posts when the
 * creator exists but has no scraped data for the requested platform yet.
 */
export async function getCreatorPlatformDetail(
  handle: string,
  platformKey: PlatformKey,
): Promise<CreatorPlatformDetail | null> {
  const creator = await getCreatorByHandle(handle);
  if (!creator) return null;
  const slot = creator.platforms.find((p) => p.platform === platformKey) ?? null;
  if (!slot) return { creator, slot: null, posts: [] };

  // Use the profile id already loaded by getCreatorByHandle — eliminates a
  // 4th serial round-trip just to re-look-up a value we already have.
  const sb = getSupabaseRead();
  const postsRes = await sb
    .from('post_snapshot')
    .select(
      'external_post_id, posted_at, caption_excerpt, likes, comments, shares, views, media_url, content_type, raw',
    )
    .eq('profile_id', slot.profileId)
    .order('captured_at', { ascending: false })
    // posted_at tiebreak: a deep backfill writes many posts under a single
    // captured_at, so without this the fetched 60 (and thus the displayed 30)
    // would be an arbitrary slice rather than the newest-published posts.
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(60);

  if (postsRes.error) {
    console.error('[queries] getCreatorPlatformDetail posts', postsRes.error);
    return { creator, slot, posts: [] };
  }

  // Dedupe by external_post_id (we have up to 2 days × 30 = 60 rows; keep newest)
  const seen = new Set<string>();
  const rows: PlatformPostRow[] = [];
  for (const r of postsRes.data ?? []) {
    if (seen.has(r.external_post_id)) continue;
    seen.add(r.external_post_id);
    rows.push(mapPostSnapshotToRow(platformKey, r.raw, r.content_type, slot.handle, r));
    if (rows.length >= 30) break;
  }
  return { creator, slot, posts: rows };
}
