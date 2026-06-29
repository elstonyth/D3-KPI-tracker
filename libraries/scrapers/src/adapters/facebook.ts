/**
 * Facebook adapter — Bright Data Web Scraper API (single dataset).
 *
 * Dataset used (Bright Data prebuilt collector):
 *   - Facebook posts by profile URL: gd_lkaxegm826bjpoo9m5
 *       ("Facebook - Pages Posts by Profile URL")
 *       Returns the latest N posts per profile URL AND carries the
 *       profile-level fields (page_followers / page_name / page_is_verified /
 *       following / page_intro / page_logo) on EACH post item.
 *
 * Why one dataset instead of two (changed 2026-05-30):
 *   The previous design paired this posts dataset with a separate profile
 *   dataset (gd_mf124a0511bauquyow "Pages and Profiles") for follower counts.
 *   That profile dataset returns a FALSE `dead_page` for Facebook
 *   "Digital creator" professional profiles — which is exactly what our
 *   creators are (verified live 2026-05-30: garyko980 has 34K followers and
 *   posts hourly, yet the profile dataset reported dead_page twice and once
 *   timed out >5min). The dedicated "Facebook - Profiles" dataset
 *   (gd_mf0urb782734ik94dz) is fast but returns NO follower count and rejects
 *   profile.php?id= URLs ("Not profile type" / bad_input).
 *
 *   The posts dataset, by contrast, succeeds on BOTH vanity (/garyko980) and
 *   numeric (/profile.php?id=123) URLs in ~50s and exposes page_followers on
 *   every item — so we read the profile from the first item and drop the
 *   profile dataset entirely. Fewer calls, faster, and reliable on creator
 *   profiles.
 *
 *   Caveat: page_followers reflects Facebook's PUBLIC (logged-out) follower
 *   count, which FB rounds for large accounts (e.g. 34000, 26000). Day-to-day
 *   growth deltas on FB are therefore coarse — a platform limitation, not a
 *   dataset one (the Web Unlocker returns the same rounded "34K").
 *
 * Output mapping:
 *   Profile (from the first post item's page_* fields)
 *     - followers:    page_followers
 *     - following:    following (often null for pages)
 *     - total_posts:  null (no clean lifetime post count is exposed)
 *     - total_likes:  sum of likes across the post window
 *     - total_views:  sum of video views across the post window
 *   Post
 *     - content_type: 'video' if has_video / view counts present, else 'image'
 *     - shares:       num_shares (FB exposes; IG does not, TikTok does)
 *
 * Migrated from Apify Actor apify/facebook-posts-scraper (2026-05-28).
 * Single-dataset rework 2026-05-30.
 */

import { runDataset } from '../brightdata-client';
import { ProfileNotFoundError, ProfilePrivateError, ScrapeError } from '../errors';
import type {
  ContentType,
  NormalizedPostSnapshot,
  NormalizedProfileSnapshot,
  PlatformAdapter,
  ScrapeOptions,
  ScrapeResult,
} from '../types';

const PLATFORM = 'facebook';
const POSTS_DATASET_ID = 'gd_lkaxegm826bjpoo9m5';
const POSTS_PER_SCRAPE = 30;
// Hard upper bound for a deep-backfill request. BrightData bills per delivered
// record and the 240s budget realistically completes ~100 posts, so this caps
// worst-case spend/runtime if a caller ever passes an unbounded maxPosts.
const MAX_POSTS_PER_SCRAPE = 200;
const CAPTION_LIMIT = 280;

/**
 * Bright Data FB post item (gd_lkaxegm826bjpoo9m5).
 *
 * Each item carries BOTH the post fields and a snapshot of the owning
 * page/profile via the page_* fields — that's what lets a single call cover
 * the profile snapshot too.
 */
interface BdFbPost {
  url?: string;
  post_id?: string;
  shortcode?: string;
  user_url?: string;
  page_url?: string;
  user_username_raw?: string;
  profile_handle?: string;
  profile_id?: string;
  content?: string | null;
  /** ISO 8601 timestamp. */
  date_posted?: string | null;
  timestamp?: string | null;
  num_comments?: number | null;
  num_shares?: number | null;
  num_likes_type?: { type?: string; num?: number }[];
  /** Aggregate likes — sometimes 'likes', sometimes 'num_likes'. */
  likes?: number | null;
  num_likes?: number | null;
  /** Video view counts (videos only). */
  num_views?: number | null;
  video_view_count?: number | null;
  play_count?: number | null;
  has_video?: boolean;
  post_type?: string | null;
  attachments?: Array<{ type?: string; url?: string; thumbnail?: string }>;
  post_external_image?: string | null;
  header_image?: string | null;
  thumbnail?: string | null;

  // --- Profile-level fields (same on every item for a given profile) ---
  page_name?: string | null;
  page_followers?: number | null;
  following?: number | null;
  page_is_verified?: boolean | null;
  page_category?: string | null;
  page_intro?: string | null;
  page_logo?: string | null;
  avatar_image_url?: string | null;
  page_creation_time?: string | null;
  is_page?: boolean | null;

  // --- Per-row error markers ---
  error?: string;
  error_code?: string;
  warning?: string;
}

function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function pickViews(p: BdFbPost): number | null {
  // FB Reels expose BOTH a lower `video_view_count` (3s+ video views) and the
  // higher `play_count` that FB actually shows on the reel (counts replays).
  // Preferring video_view_count undercounted every reel (e.g. 692,463 stored vs
  // FB's displayed 1,142,280). Take the max of whatever count fields are
  // present so our number matches FB's public count and a partial/stale field
  // can never undercount. Image posts carry none → null (not 0).
  const counts = [p.play_count, p.video_view_count, p.num_views].filter(
    (v): v is number => typeof v === 'number',
  );
  return counts.length ? Math.max(...counts) : null;
}

function pickContentType(p: BdFbPost): ContentType {
  if (p.has_video || (pickViews(p) ?? 0) > 0) return 'video';
  const type = (p.post_type ?? '').toLowerCase();
  if (type.includes('video') || type.includes('reel')) return 'video';
  const attTypes = (p.attachments ?? []).map((a) => (a.type ?? '').toLowerCase());
  if (attTypes.includes('video')) return 'video';
  return 'image';
}

function pickMediaUrl(p: BdFbPost): string | null {
  if (p.thumbnail) return p.thumbnail;
  const first = p.attachments?.[0];
  if (first) return first.thumbnail ?? first.url ?? null;
  return p.post_external_image ?? p.header_image ?? null;
}

function pickLikes(p: BdFbPost): number | null {
  if (typeof p.likes === 'number') return p.likes;
  if (typeof p.num_likes === 'number') return p.num_likes;
  const arr = p.num_likes_type;
  if (Array.isArray(arr) && arr.length > 0) {
    return arr.reduce((sum, e) => sum + (typeof e.num === 'number' ? e.num : 0), 0);
  }
  return null;
}

function mapPost(p: BdFbPost): NormalizedPostSnapshot | null {
  const externalId = p.post_id ?? p.shortcode;
  if (!externalId) return null;
  return {
    external_post_id: externalId,
    posted_at: p.date_posted ?? p.timestamp ?? null,
    caption_excerpt: truncate(p.content, CAPTION_LIMIT),
    views: pickViews(p),
    likes: pickLikes(p),
    comments: p.num_comments ?? null,
    shares: p.num_shares ?? null,
    media_url: pickMediaUrl(p),
    content_type: pickContentType(p),
    raw: p,
  };
}

function mapProfile(
  first: BdFbPost,
  posts: NormalizedPostSnapshot[],
): NormalizedProfileSnapshot {
  let totalViews = 0;
  let totalLikes = 0;
  let viewsSeen = false;
  let likesSeen = false;
  for (const p of posts) {
    if (p.views !== null) {
      totalViews += p.views;
      viewsSeen = true;
    }
    if (p.likes !== null) {
      totalLikes += p.likes;
      likesSeen = true;
    }
  }
  return {
    followers: first.page_followers ?? null,
    following: first.following ?? null,
    total_posts: null, // dataset exposes no clean lifetime post count
    total_views: viewsSeen ? totalViews : null,
    total_likes: likesSeen ? totalLikes : null,
    raw: {
      facebook_id: first.profile_id,
      page_name: first.page_name,
      page_url: first.page_url ?? first.user_url,
      entity_type: first.is_page ? 'PAGE' : 'PROFILE',
      profile_pic: first.avatar_image_url ?? first.page_logo ?? null,
      primary_category: first.page_category,
      verified: first.page_is_verified ?? null,
      summary_text: first.page_intro,
      page_created_at: first.page_creation_time,
      sample_size: posts.length,
    },
  };
}

/** Classify a Bright Data per-row error_code into our status taxonomy. */
function throwForErrorCode(p: BdFbPost, profileUrl: string): void {
  if (!p.error_code && !p.error) return;
  const code = (p.error_code || p.error || '').toLowerCase();
  if (code.includes('private') || code.includes('restricted') || code.includes('login')) {
    throw new ProfilePrivateError(PLATFORM, profileUrl);
  }
  if (
    code.includes('dead') ||
    code.includes('not_found') ||
    code.includes('not found') ||
    code.includes('deleted') ||
    code.includes('does not exist')
  ) {
    throw new ProfileNotFoundError(PLATFORM, profileUrl);
  }
  // bad_input / invalid_url / everything else → surface as failed with BD's
  // message so operators see exactly what Bright Data rejected.
  throw new ScrapeError(
    'failed',
    `Bright Data rejected input (${p.error_code || 'error'}): ${p.error || code}`,
    PLATFORM,
    profileUrl,
  );
}

export const facebookAdapter: PlatformAdapter = {
  platform: 'facebook',
  sourceId: `brightdata:${POSTS_DATASET_ID}`,
  async scrape(profileUrl: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
    // Single dataset call. BD's posts collector resolves both vanity and
    // profile.php?id= URLs in ~50s and returns page_followers on each item.
    // Cap at 240s (4 min) to leave ~60s margin under Vercel's 300s Function
    // maxDuration for Supabase round-trips + status update + JSON response.
    const FB_BUDGET_MS = 240_000;
    const FB_POLL_MS = 10_000;

    // Deep-backfill knob. BrightData's posts dataset takes `num_of_posts`
    // directly, so a deeper scrape is just a larger single request — no
    // client-side cursor loop (unlike the TikHub IG/TikTok/Douyin adapters).
    // The daily cron passes no opts, so num_of_posts stays POSTS_PER_SCRAPE
    // (30) and the per-record BrightData bill is unchanged; only the admin
    // one-off /api/admin/backfill-posts route raises it via maxPosts. Bigger
    // counts also take BrightData longer to collect — keep them under the
    // 240s budget (a modest count both bounds cost and avoids a timeout).
    // Validate at the boundary: a 0/negative/non-integer maxPosts would only
    // produce a misleading BrightData failure, so reject it loudly. Clamp the
    // upper end so an unbounded value can't run up spend or blow the budget.
    if (
      opts.maxPosts != null &&
      (!Number.isInteger(opts.maxPosts) || opts.maxPosts <= 0)
    ) {
      throw new ScrapeError(
        'failed',
        `Invalid maxPosts (${opts.maxPosts}); expected a positive integer.`,
        PLATFORM,
        profileUrl,
      );
    }
    const numOfPosts = Math.min(
      opts.maxPosts ?? POSTS_PER_SCRAPE,
      MAX_POSTS_PER_SCRAPE,
    );

    const items = await runDataset<BdFbPost>({
      datasetId: POSTS_DATASET_ID,
      inputs: [{ url: profileUrl, num_of_posts: numOfPosts }],
      platform: PLATFORM,
      profileUrl,
      timeoutMs: FB_BUDGET_MS,
      pollIntervalMs: FB_POLL_MS,
    });

    const first = items[0];
    if (!first) {
      // No rows at all — Bright Data can deliver an empty `ready` snapshot
      // transiently (block/timeout on their side), and a live page with zero
      // recent posts also returns nothing. Neither proves a dead page, and
      // the cron's due-filter excludes `not_found` PERMANENTLY (it needs a
      // human reset), so surface as retryable `failed`. `not_found` is
      // reserved for an explicit per-row error_code (throwForErrorCode).
      throw new ScrapeError(
        'failed',
        'Bright Data delivered no rows — empty/blocked collection or a page with no recent posts; retrying next tick',
        PLATFORM,
        profileUrl,
      );
    }

    // A per-row error_code is BD telling us why a specific URL failed.
    throwForErrorCode(first, profileUrl);

    // No error code but no page identity either → malformed/placeholder row,
    // not a confirmed dead page. Retryable for the same reason as above.
    if (
      first.page_followers == null &&
      !first.page_name &&
      !first.profile_id &&
      !first.post_id
    ) {
      throw new ScrapeError(
        'failed',
        'Bright Data row carries no page identity — treating as transient; retrying next tick',
        PLATFORM,
        profileUrl,
      );
    }

    const posts: NormalizedPostSnapshot[] = [];
    for (const p of items) {
      // Skip error/empty rows mixed into the snapshot (include_errors=true).
      if (p.error_code || p.error) continue;
      const mapped = mapPost(p);
      if (mapped) posts.push(mapped);
    }

    return {
      profile: mapProfile(first, posts),
      posts,
    };
  },
};
