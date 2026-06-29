/**
 * TikTok adapter — TikHub REST (api.tikhub.io/api/v1/tiktok/app/v3/...).
 *
 * Endpoints used:
 *   GET /api/v1/tiktok/app/v3/handler_user_profile?unique_id=<handle>
 *   GET /api/v1/tiktok/app/v3/fetch_user_post_videos_v2?unique_id=<handle>&count=30
 *   (was _v3 — switched to _v2 2026-05-28; see notes inside scrape().)
 *
 * The "_v3" endpoints return the simplified TikTok app payload — same fields
 * as the full version but lighter / faster. Both endpoints accept unique_id
 * directly, so we don't need a sec_uid round-trip.
 *
 * Output mapping:
 *   Profile
 *     - followers:    user.follower_count
 *     - following:    user.following_count
 *     - total_posts:  user.aweme_count (lifetime, exposed by app API)
 *     - total_likes:  user.total_favorited (lifetime hearts received)
 *     - total_views:  sum of statistics.play_count across the fetched window
 *                     (TikTok does not expose a lifetime view total).
 *   Post
 *     - content_type: 'short' (TikTok is short-form video only)
 *     - shares:       statistics.share_count
 *
 * Migrated from Apify Actor clockworks/tiktok-scraper (2026-05-28).
 */

import { tikhubGet } from '../tikhub-client';
import { ProfileNotFoundError, ProfilePrivateError, ScrapeError } from '../errors';
import type {
  NormalizedPostSnapshot,
  NormalizedProfileSnapshot,
  PlatformAdapter,
  ScrapeOptions,
  ScrapeResult,
} from '../types';

const PLATFORM = 'tiktok';
const POSTS_PER_SCRAPE = 30;
const CAPTION_LIMIT = 280;

/** Extract unique_id (no @) from a normalized tiktok.com URL. */
function extractHandle(profileUrl: string): string {
  const u = new URL(profileUrl);
  const m = u.pathname.match(/^\/@([A-Za-z0-9._]+)\/?$/);
  if (!m) {
    throw new ScrapeError(
      'failed',
      `Cannot extract TikTok handle from path "${u.pathname}"`,
      PLATFORM,
      profileUrl,
    );
  }
  return m[1];
}

interface TtUrlList {
  /** TikTok image/video URLs come as a list of CDN mirrors. */
  url_list?: string[];
}

interface TtUser {
  uid?: string;
  sec_uid?: string;
  unique_id?: string;
  nickname?: string | null;
  signature?: string | null;
  avatar_thumb?: TtUrlList;
  avatar_larger?: TtUrlList;
  avatar_medium?: TtUrlList;
  follower_count?: number | null;
  following_count?: number | null;
  aweme_count?: number | null;
  total_favorited?: number | null;
  verification_type?: number | null;
  custom_verify?: string | null;
  is_private_account?: boolean;
  /** Some responses use this name instead. */
  privacy_setting?: { private_account?: boolean };
}

interface TtProfileResponse {
  user?: TtUser;
  /** Some endpoints return the user at root. */
  uid?: string;
  unique_id?: string;
}

interface TtStatistics {
  play_count?: number | null;
  digg_count?: number | null;
  comment_count?: number | null;
  share_count?: number | null;
  collect_count?: number | null;
  download_count?: number | null;
}

interface TtVideo {
  cover?: TtUrlList;
  origin_cover?: TtUrlList;
  dynamic_cover?: TtUrlList;
  duration?: number;
  play_addr?: TtUrlList;
}

interface TtAweme {
  aweme_id?: string;
  desc?: string | null;
  create_time?: number | null;
  statistics?: TtStatistics;
  video?: TtVideo;
  /** Author is sometimes nested per-item (verify on smoke). */
  author?: TtUser;
}

interface TtPostsResponse {
  aweme_list?: TtAweme[];
  has_more?: number | boolean;
  max_cursor?: number | string;
}

function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Pick a browser-renderable image URL from a TikTok url_list.
 *
 * TikTok returns each cover/avatar as TWO signed URLs — a `.heic` (first) and
 * a `.jpeg` (or `.webp`). HEIC is smaller but browsers (Chrome/Firefox) can't
 * render it, so the thumbnail shows black. Each format carries its own valid
 * signature, so we must pick the actual non-HEIC URL from the list (rewriting
 * the .heic URL's extension breaks the signature → 403). Verified live
 * 2026-05-30.
 */
function pickRenderableUrl(list?: TtUrlList): string | null {
  const urls = list?.url_list;
  if (!urls || urls.length === 0) return null;
  // Upstream JSON occasionally carries a null/non-string entry; guard before
  // .split so one bad URL can't throw a TypeError and abort the whole scrape.
  const strings = urls.filter((u): u is string => typeof u === 'string');
  if (strings.length === 0) return null;
  const nonHeic = strings.find(
    (u) => !u.split('?')[0].toLowerCase().endsWith('.heic'),
  );
  return nonHeic ?? strings[0];
}

function pickCover(v?: TtVideo): string | null {
  for (const l of [v?.cover, v?.dynamic_cover, v?.origin_cover]) {
    const url = pickRenderableUrl(l);
    if (url) return url;
  }
  return null;
}

function pickAvatar(u: TtUser): string | null {
  for (const l of [u.avatar_larger, u.avatar_medium, u.avatar_thumb]) {
    const url = pickRenderableUrl(l);
    if (url) return url;
  }
  return null;
}

function unwrapTimestamp(t: number | null | undefined): string | null {
  if (typeof t === 'number' && Number.isFinite(t)) {
    return new Date(t * 1000).toISOString();
  }
  return null;
}

function mapPost(a: TtAweme): NormalizedPostSnapshot | null {
  const externalId = a.aweme_id;
  if (!externalId) return null;
  const stats = a.statistics ?? {};
  return {
    external_post_id: externalId,
    posted_at: unwrapTimestamp(a.create_time),
    caption_excerpt: truncate(a.desc, CAPTION_LIMIT),
    views: stats.play_count ?? null,
    likes: stats.digg_count ?? null,
    comments: stats.comment_count ?? null,
    shares: stats.share_count ?? null,
    media_url: pickCover(a.video),
    content_type: 'short',
    raw: a,
  };
}

function unwrapUser(resp: TtProfileResponse): TtUser {
  return resp.user ?? (resp as unknown as TtUser);
}

function isPrivate(u: TtUser): boolean {
  return Boolean(u.is_private_account || u.privacy_setting?.private_account);
}

function mapProfile(
  user: TtUser,
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
      unique_id: user.unique_id,
      nickname: user.nickname,
      verified: (user.verification_type ?? 0) > 0,
      avatar_url: pickAvatar(user),
      biography: user.signature,
      sample_size: posts.length,
    },
  };
}

export const tiktokAdapter: PlatformAdapter = {
  platform: 'tiktok',
  sourceId: 'tikhub:tiktok/app/v3',
  async scrape(profileUrl: string, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
    const handle = extractHandle(profileUrl);

    // v3 of this endpoint currently returns 400 universally on TikHub (verified
    // 2026-05-28, same backend issue as IG v3 get_user_posts); v2 returns the
    // same shape on a healthy worker. Swap back once TikHub fixes their backend.
    const fetchPostsPage = (pageQuery: Record<string, unknown>) =>
      tikhubGet<TtPostsResponse>({
        path: '/api/v1/tiktok/app/v3/fetch_user_post_videos_v2',
        query: { count: POSTS_PER_SCRAPE, max_cursor: 0, ...pageQuery },
        platform: PLATFORM,
        profileUrl,
      });

    const [profileResp, postsResp] = await Promise.all([
      tikhubGet<TtProfileResponse>({
        path: '/api/v1/tiktok/app/v3/handler_user_profile',
        query: { unique_id: handle },
        platform: PLATFORM,
        profileUrl,
      }),
      fetchPostsPage({ unique_id: handle }).catch((err) => {
        // Posts are supplementary. A private OR not-found error from the posts
        // endpoint must not sink an otherwise-healthy profile — the profile
        // response below still decides genuine private/not_found. Degrade to
        // empty posts. (Matches the Instagram and Douyin adapters; without the
        // not_found case a transient posts-worker blip would mark a live
        // profile not_found, which the cron then excludes permanently.)
        if (err instanceof ProfilePrivateError || err instanceof ProfileNotFoundError) {
          return { aweme_list: [] } as TtPostsResponse;
        }
        throw err;
      }),
    ]);

    const user = unwrapUser(profileResp);
    if (!user || (!user.uid && !user.sec_uid && !user.unique_id)) {
      throw new ProfileNotFoundError(PLATFORM, profileUrl);
    }
    if (isPrivate(user)) {
      throw new ProfilePrivateError(PLATFORM, profileUrl);
    }

    // Some public accounts return an EMPTY post list when queried by unique_id
    // even though they have videos (verified 2026-05-30: @alexloh2828 has 356
    // posts but unique_id yields 0; sec_user_id yields them). Fall back to the
    // sec_uid we already have from the profile response. Keeps the common case
    // fast (one parallel call) and only pays a second request for the few
    // accounts TikHub's unique_id worker can't resolve.
    //
    // Track which key produced posts (`pageKey`) and the cursor state of the
    // response that produced them (`cursorResp`) so the deep-backfill loop below
    // continues paginating on the *same* key.
    let awemeList = postsResp.aweme_list ?? [];
    let pageKey: Record<string, unknown> = { unique_id: handle };
    let cursorResp: TtPostsResponse = postsResp;
    if (awemeList.length === 0 && user.sec_uid) {
      try {
        const bySec = await fetchPostsPage({ sec_user_id: user.sec_uid });
        awemeList = bySec.aweme_list ?? [];
        pageKey = { sec_user_id: user.sec_uid };
        cursorResp = bySec;
      } catch (err) {
        // Posts are supplementary and the profile is already validated above,
        // so a failed fallback must not sink the snapshot — keep posts empty.
        // (Previously this re-threw on any non-private error, discarding the
        // good follower data already fetched and contradicting this comment.)
        // Log rather than re-throw so an unexpected fallback failure stays
        // visible without taking down the profile snapshot.
        console.warn(
          `[tiktok] sec_uid posts fallback failed for ${profileUrl} (non-fatal)`,
          err,
        );
      }
    }

    // Deep backfill: when maxPosts is set, follow the v2 max_cursor / has_more
    // cursor to pull deep back-catalog posts (e.g. an old viral video beyond the
    // recent window). The default (no maxPosts) stays a single page so the daily
    // cron's per-profile cost is unchanged.
    const { maxPosts } = opts;
    if (maxPosts !== undefined && awemeList.length > 0) {
      const MAX_PAGES = 100; // safety bound against a non-advancing cursor
      let pages = 0;
      let cursor: number | string | undefined = cursorResp.max_cursor;
      let hasMore = Boolean(cursorResp.has_more);
      while (awemeList.length < maxPosts && hasMore && cursor !== undefined && pages < MAX_PAGES) {
        pages += 1;
        let next: TtPostsResponse;
        try {
          next = await fetchPostsPage({ ...pageKey, max_cursor: cursor });
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

    const posts: NormalizedPostSnapshot[] = [];
    for (const a of awemeList) {
      const mapped = mapPost(a);
      if (mapped) posts.push(mapped);
    }

    return {
      profile: mapProfile(user, posts),
      posts,
    };
  },
};
