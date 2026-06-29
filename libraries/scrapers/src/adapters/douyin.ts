/**
 * Douyin adapter — TikHub REST (api.tikhub.io/api/v1/douyin/web/...).
 *
 * Endpoints used:
 *   GET /api/v1/douyin/web/handler_user_profile?sec_user_id=<sec_uid>
 *   GET /api/v1/douyin/web/fetch_user_post_videos?sec_user_id=<sec_uid>&count=30
 *   GET /api/v1/douyin/app/v3/fetch_multi_video_statistics?aweme_ids=<id,id,…>
 *
 * Douyin is the mainland-China ByteDance app — different product from
 * international TikTok (different domain douyin.com, different APIs). Both
 * web endpoints accept the sec_uid that lives in the profile URL path
 * (douyin.com/user/<sec_uid>) so we don't need an extra lookup.
 *
 * VIEW COUNTS: the fetch_user_post_videos FEED returns statistics.play_count=0
 * for every post (Douyin hides play counts in the feed). The real numbers come
 * only from the dedicated app/v3 fetch_multi_video_statistics endpoint, keyed
 * by aweme_id. So we collect the window's aweme_ids and make a second (batched)
 * call to backfill real views/likes/shares. That stats endpoint does NOT return
 * comment_count, so comments still come from the feed.
 *
 * Output mapping:
 *   Profile
 *     - followers:    user.follower_count
 *     - following:    user.following_count
 *     - total_posts:  user.aweme_count (lifetime)
 *     - total_likes:  user.total_favorited (lifetime — Douyin exposes this on
 *                     the profile, unlike TikTok which only exposes via app v3)
 *     - total_views:  sum of real play_count (from fetch_multi_video_statistics)
 *                     across the fetched window (Douyin has no lifetime view count).
 *   Post
 *     - content_type: 'short' (Douyin is short-form video only)
 *     - views:        from fetch_multi_video_statistics ONLY (the feed's
 *                     play_count is always 0, so it is never a fallback —
 *                     a missing stat stays null rather than becoming a fake 0)
 *     - likes/shares: from fetch_multi_video_statistics (feed fallback — the
 *                     feed reports these truthfully, unlike play_count)
 *     - comments:     statistics.comment_count (feed — not in the stats endpoint)
 *
 * Migrated from Apify Actor zen-studio/douyin-profile-scraper (2026-05-28).
 */

import { tikhubGet } from '../tikhub-client';
import { ProfileNotFoundError, ScrapeError } from '../errors';
import type {
  NormalizedPostSnapshot,
  NormalizedProfileSnapshot,
  PlatformAdapter,
  ScrapeOptions,
  ScrapeResult,
} from '../types';

const PLATFORM = 'douyin';
const POSTS_PER_SCRAPE = 30;
const CAPTION_LIMIT = 280;
/** Max aweme_ids per fetch_multi_video_statistics call — chunk to stay under
 *  any batch cap and keep each request small. */
const STATS_BATCH = 20;

/** Extract sec_uid from a normalized douyin.com URL: /user/<sec_uid>. */
function extractSecUid(profileUrl: string): string {
  const u = new URL(profileUrl);
  const m = u.pathname.match(/^\/user\/([A-Za-z0-9_-]+)\/?$/);
  if (!m) {
    throw new ScrapeError(
      'failed',
      `Cannot extract Douyin sec_uid from path "${u.pathname}"`,
      PLATFORM,
      profileUrl,
    );
  }
  return m[1];
}

interface DyUrlList {
  url_list?: string[];
}

interface DyUser {
  uid?: string;
  sec_uid?: string;
  short_id?: string;
  unique_id?: string;
  nickname?: string | null;
  signature?: string | null;
  avatar_thumb?: DyUrlList;
  avatar_larger?: DyUrlList;
  avatar_medium?: DyUrlList;
  follower_count?: number | null;
  following_count?: number | null;
  aweme_count?: number | null;
  total_favorited?: number | null;
  custom_verify?: string | null;
  ip_location?: string | null;
}

interface DyProfileResponse {
  user?: DyUser;
  uid?: string;
  sec_uid?: string;
}

interface DyStatistics {
  play_count?: number | null;
  digg_count?: number | null;
  comment_count?: number | null;
  share_count?: number | null;
  collect_count?: number | null;
  forward_count?: number | null;
}

interface DyVideo {
  cover?: DyUrlList;
  origin_cover?: DyUrlList;
  dynamic_cover?: DyUrlList;
  duration?: number;
}

interface DyAweme {
  aweme_id?: string;
  desc?: string | null;
  create_time?: number | null;
  statistics?: DyStatistics;
  video?: DyVideo;
}

interface DyPostsResponse {
  aweme_list?: DyAweme[];
  has_more?: number | boolean;
  max_cursor?: number | string;
}

/** fetch_multi_video_statistics row — note: NO comment_count field. */
interface DyVideoStat {
  aweme_id?: string;
  play_count?: number | null;
  digg_count?: number | null;
  share_count?: number | null;
  download_count?: number | null;
}

interface DyMultiStatsResponse {
  statistics_list?: DyVideoStat[];
}

/**
 * Backfill real per-video stats (play/digg/share) the feed omits. Batched by
 * STATS_BATCH and keyed by aweme_id. Resilient per chunk: a failing chunk is
 * logged and skipped (those posts degrade to feed values) while already-fetched
 * chunks are preserved — so one transient error doesn't zero the whole window.
 * Never throws on a chunk failure; returns whatever stats it gathered (empty
 * map if there are no ids or every chunk failed).
 */
async function fetchVideoStats(
  awemeIds: string[],
  profileUrl: string,
): Promise<Map<string, DyVideoStat>> {
  const map = new Map<string, DyVideoStat>();
  for (let i = 0; i < awemeIds.length; i += STATS_BATCH) {
    const chunk = awemeIds.slice(i, i + STATS_BATCH);
    try {
      const data = await tikhubGet<DyMultiStatsResponse>({
        path: '/api/v1/douyin/app/v3/fetch_multi_video_statistics',
        query: { aweme_ids: chunk.join(',') },
        platform: PLATFORM,
        profileUrl,
      });
      for (const s of data.statistics_list ?? []) {
        if (s.aweme_id) map.set(s.aweme_id, s);
      }
    } catch (err) {
      // Degrade only this chunk's posts to feed values, but stay observable.
      console.warn(
        `[douyin] stats chunk failed for ${profileUrl} (offset ${i}); degrading those posts to feed values`,
        err,
      );
    }
  }
  return map;
}

function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function pickCover(v?: DyVideo): string | null {
  const lists = [v?.cover, v?.dynamic_cover, v?.origin_cover];
  for (const l of lists) {
    if (l?.url_list && l.url_list.length > 0) return l.url_list[0];
  }
  return null;
}

function pickAvatar(u: DyUser): string | null {
  const lists = [u.avatar_larger, u.avatar_medium, u.avatar_thumb];
  for (const l of lists) {
    if (l?.url_list && l.url_list.length > 0) return l.url_list[0];
  }
  return null;
}

function unwrapTimestamp(t: number | null | undefined): string | null {
  if (typeof t === 'number' && Number.isFinite(t)) {
    return new Date(t * 1000).toISOString();
  }
  return null;
}

function mapPost(
  a: DyAweme,
  statsMap: Map<string, DyVideoStat>,
): NormalizedPostSnapshot | null {
  const externalId = a.aweme_id;
  if (!externalId) return null;
  const feed = a.statistics ?? {};
  const stat = statsMap.get(externalId);
  return {
    external_post_id: externalId,
    posted_at: unwrapTimestamp(a.create_time),
    caption_excerpt: truncate(a.desc, CAPTION_LIMIT),
    // play_count is ONLY reliable from the stats endpoint — the feed always
    // reports 0, so it must NEVER be a fallback for views: writing that 0
    // would record a real-looking "0 views" (and a fake cliff in the profile
    // total) whenever a stats chunk fails. Unknown stays null.
    views: stat?.play_count ?? null,
    likes: stat?.digg_count ?? feed.digg_count ?? null,
    // comment_count is not in the stats endpoint — feed is the only source.
    comments: feed.comment_count ?? null,
    shares: stat?.share_count ?? feed.share_count ?? null,
    media_url: pickCover(a.video),
    content_type: 'short',
    raw: a,
  };
}

function unwrapUser(resp: DyProfileResponse): DyUser {
  return resp.user ?? (resp as unknown as DyUser);
}

function mapProfile(
  user: DyUser,
  posts: NormalizedPostSnapshot[],
): NormalizedProfileSnapshot {
  let totalViews = 0;
  let viewsSeen = false;
  for (const p of posts) {
    if (p.views !== null) {
      totalViews += p.views;
      viewsSeen = true;
    }
  }
  return {
    followers: user.follower_count ?? null,
    following: user.following_count ?? null,
    total_posts: user.aweme_count ?? null,
    total_views: viewsSeen ? totalViews : null,
    total_likes: user.total_favorited ?? null,
    raw: {
      uid: user.uid,
      sec_uid: user.sec_uid,
      short_id: user.short_id,
      unique_id: user.unique_id,
      nickname: user.nickname,
      verified: Boolean(user.custom_verify),
      avatar_url: pickAvatar(user),
      biography: user.signature,
      ip_location: user.ip_location,
      sample_size: posts.length,
    },
  };
}

export const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',
  sourceId: 'tikhub:douyin/web',
  async scrape(profileUrl: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
    const secUid = extractSecUid(profileUrl);

    const fetchPostsPage = (maxCursor: number | string) =>
      tikhubGet<DyPostsResponse>({
        path: '/api/v1/douyin/web/fetch_user_post_videos',
        query: { sec_user_id: secUid, count: POSTS_PER_SCRAPE, max_cursor: maxCursor },
        platform: PLATFORM,
        profileUrl,
      });

    const [profileResp, postsResp] = await Promise.all([
      tikhubGet<DyProfileResponse>({
        path: '/api/v1/douyin/web/handler_user_profile',
        query: { sec_user_id: secUid },
        platform: PLATFORM,
        profileUrl,
      }),
      fetchPostsPage('0').catch((err) => {
        // Posts are supplementary — a private/missing posts tab must not sink
        // the profile snapshot. The profile response below still decides
        // not_found. Degrade to empty posts.
        if (
          err instanceof ProfileNotFoundError ||
          (err instanceof ScrapeError && err.status === 'private')
        ) {
          return { aweme_list: [] } as DyPostsResponse;
        }
        throw err;
      }),
    ]);

    const user = unwrapUser(profileResp);
    if (!user || (!user.sec_uid && !user.uid)) {
      throw new ProfileNotFoundError(PLATFORM, profileUrl);
    }

    const awemeList = postsResp.aweme_list ?? [];

    // Deep backfill: when maxPosts is set, follow the feed's max_cursor /
    // has_more cursor to pull deep back-catalog posts. The default (no maxPosts)
    // stays a single page so the daily cron's per-profile cost is unchanged.
    // The view-stats backfill below then runs over the FULL collected window.
    const { maxPosts } = opts;
    if (maxPosts !== undefined && awemeList.length > 0) {
      const MAX_PAGES = 100; // safety bound against a non-advancing cursor
      let pages = 0;
      let cursor: number | string | undefined = postsResp.max_cursor;
      let hasMore = Boolean(postsResp.has_more);
      while (awemeList.length < maxPosts && hasMore && cursor !== undefined && pages < MAX_PAGES) {
        pages += 1;
        let next: DyPostsResponse;
        try {
          next = await fetchPostsPage(cursor);
        } catch {
          // A mid-pagination failure must not discard the posts already
          // collected — stop here and keep what we have.
          break;
        }
        const items = next.aweme_list ?? [];
        if (items.length === 0) break;
        awemeList.push(...items);
        if (next.max_cursor === cursor) break; // cursor not advancing — avoid a loop
        cursor = next.max_cursor;
        hasMore = Boolean(next.has_more);
      }
      if (awemeList.length > maxPosts) awemeList.length = maxPosts;
    }

    // Backfill real view/like/share counts the feed omits (feed play_count=0).
    // fetchVideoStats degrades per chunk and never throws, so a stats failure
    // never sinks the snapshot — affected posts just fall back to feed values.
    const awemeIds = awemeList
      .map((a) => a.aweme_id)
      .filter((id): id is string => Boolean(id));
    const statsMap =
      awemeIds.length > 0
        ? await fetchVideoStats(awemeIds, profileUrl)
        : new Map<string, DyVideoStat>();

    const posts: NormalizedPostSnapshot[] = [];
    for (const a of awemeList) {
      const mapped = mapPost(a, statsMap);
      if (mapped) posts.push(mapped);
    }

    return {
      profile: mapProfile(user, posts),
      posts,
    };
  },
};
