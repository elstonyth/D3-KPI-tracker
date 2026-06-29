/**
 * Instagram adapter — TikHub REST.
 *
 * Endpoints used:
 *   GET /api/v1/instagram/v1/fetch_user_info_by_username?username=<handle>
 *   GET /api/v1/instagram/v2/fetch_user_posts?username=<handle>
 *   GET /api/v1/instagram/v2/fetch_user_reels?username=<handle>
 *
 * The grid feed (fetch_user_posts) misses reels the creator hid from the
 * profile grid — found 2026-06-12 when a 937K-view reel (DVGYK3-ExJn) was
 * absent from 266 captured posts. The reels feed is fetched as a second
 * supplementary page (same response envelope) and merged by external id;
 * the grid version wins when a post appears in both.
 *
 * Endpoint history: the V3 get_user_posts endpoint broke on TikHub's backend
 * (generic 400 for every username — verified 2026-05-28), so posts come from
 * V2 fetch_user_posts. The V3 get_user_profile endpoint then ALSO started
 * returning 400 (verified 2026-06-03 — V2 posts stayed 200), so the profile
 * now comes from V1 fetch_user_info_by_username, which is healthy. That
 * endpoint nests the user under `data.user` and reports counts via the
 * GraphQL-style edge_followed_by / edge_follow / edge_owner_to_timeline_media
 * (no flat *_count fields) — both shapes are tolerated below.
 *
 * V2 returns up to ~12 posts by default — smaller window than the spec's
 * "up to 30" target but still useful for the engagement rollup. Pagination
 * via the response's pagination_token is possible if we ever need more
 * (not wired today).
 *
 * Output mapping:
 *   Profile
 *     - followers / following / total_posts: TikHub's user.*_count fields
 *     - total_views: sum of play_count across the fetched window (TikHub IG
 *       does not expose a lifetime view total; window-only per spec §6).
 *     - total_likes: sum of like_count across the fetched window.
 *
 * Migrated from Apify Actor apify/instagram-scraper (2026-05-28).
 */

import { tikhubGet } from '../tikhub-client';
import {
  ProfileNotFoundError,
  ProfilePrivateError,
  ScrapeError,
} from '../errors';
import type {
  ContentType,
  NormalizedPostSnapshot,
  NormalizedProfileSnapshot,
  PlatformAdapter,
  ScrapeOptions,
  ScrapeResult,
} from '../types';

const PLATFORM = 'instagram';
const POSTS_PER_SCRAPE = 30;
const CAPTION_LIMIT = 280;

/**
 * Extract username from a normalized instagram.com URL.
 * Kept local to this file; mirrors @d3/database/profile-url PATTERNS.instagram.
 */
function extractHandle(profileUrl: string): string {
  const u = new URL(profileUrl);
  const m = u.pathname.match(/^\/@?([A-Za-z0-9._]+)\/?$/);
  if (!m) {
    throw new ScrapeError(
      'failed',
      `Cannot extract Instagram handle from path "${u.pathname}"`,
      PLATFORM,
      profileUrl,
    );
  }
  return m[1];
}

interface IgUser {
  pk?: string | number;
  id?: string;
  username?: string;
  full_name?: string | null;
  biography?: string | null;
  profile_pic_url?: string | null;
  profile_pic_url_hd?: string | null;
  is_private?: boolean;
  is_verified?: boolean;
  follower_count?: number | null;
  following_count?: number | null;
  media_count?: number | null;
  /** Some IG payloads use *_count, some use edge_*.count. Tolerate both. */
  edge_followed_by?: { count?: number };
  edge_follow?: { count?: number };
  edge_owner_to_timeline_media?: { count?: number };
}

interface IgProfileResponse {
  user?: IgUser;
  /** V1 fetch_user_info_by_username nests the user under data.user. */
  data?: { user?: IgUser };
  /** Some IG endpoints return the user object directly at root. */
  pk?: string | number;
  username?: string;
  follower_count?: number;
  following_count?: number;
  media_count?: number;
}

interface IgCaption {
  text?: string | null;
}

interface IgImageCandidate {
  url?: string;
  width?: number;
  height?: number;
}

interface IgImageVersions {
  /** v3 endpoint shape — image_versions2.candidates[]. */
  candidates?: IgImageCandidate[];
  /** v2 endpoint shape — image_versions.items[]. */
  items?: IgImageCandidate[];
}

interface IgPost {
  pk?: string | number;
  id?: string;
  code?: string; // shortcode for /p/{code}
  shortcode?: string; // alternate name
  /** 1 = image, 2 = video, 8 = carousel album. */
  media_type?: number;
  /** 'clips' for reels, 'feed' for posts, 'igtv' for longform. */
  product_type?: string | null;
  caption?: IgCaption | string | null;
  like_count?: number | null;
  comment_count?: number | null;
  play_count?: number | null;
  view_count?: number | null;
  video_view_count?: number | null;
  /** Some v2 payloads use this instead of play_count. */
  ig_play_count?: number | null;
  taken_at?: number | string | null;
  taken_at_timestamp?: number | null;
  /** v3 endpoint field name. */
  image_versions2?: IgImageVersions;
  /** v2 endpoint field name (currently in use; see file header). */
  image_versions?: IgImageVersions;
  display_url?: string | null;
  thumbnail_url?: string | null;
  carousel_media?: unknown[];
  has_audio?: boolean;
}

interface IgPostsResponse {
  /** v3 shape — items at top of unwrapped data. */
  items?: IgPost[];
  /** v2 shape — items nested under data.data. tikhubGet strips the outer
   *  envelope so we see data.{data: {items}} here. */
  data?: {
    items?: IgPost[];
    pagination_token?: string | null;
  };
  /** v2 fetch_user_posts cursor — a SIBLING of `data` on the unwrapped
   *  envelope (verified 2026-06-03), not nested inside it. Pass it back as the
   *  `pagination_token` query param to page deeper. */
  pagination_token?: string | null;
  /** Some endpoints nest under data.user.edge_owner_to_timeline_media.edges */
  edges?: { node?: IgPost }[];
  num_results?: number;
  more_available?: boolean;
}

function truncate(s: string | null | undefined, n: number): string | null {
  if (!s) return null;
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function unwrapCaption(c: IgPost['caption']): string | null {
  if (c === null || c === undefined) return null;
  if (typeof c === 'string') return c;
  return c.text ?? null;
}

function unwrapTimestamp(p: IgPost): string | null {
  const takenAt = p.taken_at;
  if (typeof takenAt === 'number' && Number.isFinite(takenAt)) {
    return new Date(takenAt * 1000).toISOString();
  }
  if (typeof takenAt === 'string' && takenAt.trim() !== '') {
    // A numeric string ('1716800000') is unix seconds masquerading as a string.
    const numeric = Number(takenAt);
    if (Number.isFinite(numeric)) {
      return new Date(numeric * 1000).toISOString();
    }
    // Otherwise it should be a real date string — only return it if it actually
    // parses, so a malformed value can't slip through and fail the timestamptz
    // write (the very failure this guard exists to prevent).
    const parsed = Date.parse(takenAt);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  // Fall back to the numeric taken_at_timestamp field.
  if (
    typeof p.taken_at_timestamp === 'number' &&
    Number.isFinite(p.taken_at_timestamp)
  ) {
    return new Date(p.taken_at_timestamp * 1000).toISOString();
  }
  return null;
}

function pickContentType(p: IgPost): ContentType {
  const product = (p.product_type || '').toLowerCase();
  if (product === 'clips') return 'reel';
  if (product === 'igtv' || p.media_type === 2) return 'video';
  if (
    p.media_type === 8 ||
    (Array.isArray(p.carousel_media) && p.carousel_media.length > 0)
  ) {
    return 'image';
  }
  return 'image';
}

function pickMediaUrl(p: IgPost): string | null {
  if (p.display_url) return p.display_url;
  if (p.thumbnail_url) return p.thumbnail_url;
  // v3 used image_versions2.candidates; v2 uses image_versions.items.
  // Check both so a future endpoint swap (or a payload variant) keeps working.
  const v3 = p.image_versions2?.candidates?.[0]?.url;
  if (v3) return v3;
  const v2 = p.image_versions?.items?.[0]?.url;
  return v2 ?? null;
}

function mapPost(p: IgPost): NormalizedPostSnapshot | null {
  const externalId =
    p.code ?? p.shortcode ?? (p.pk !== undefined ? String(p.pk) : p.id);
  if (!externalId) return null;
  // v2 prefers ig_play_count; v3 uses play_count; older payloads use view_count
  // or video_view_count. Fall through in that order.
  const views =
    p.play_count ??
    p.ig_play_count ??
    p.view_count ??
    p.video_view_count ??
    null;
  return {
    external_post_id: externalId,
    posted_at: unwrapTimestamp(p),
    caption_excerpt: truncate(unwrapCaption(p.caption), CAPTION_LIMIT),
    views,
    likes: p.like_count ?? null,
    comments: p.comment_count ?? null,
    shares: null, // IG doesn't expose share count publicly
    media_url: pickMediaUrl(p),
    content_type: pickContentType(p),
    raw: p,
  };
}

/** Unwrap TikHub's profile response. V1 fetch_user_info_by_username nests the
 *  user under data.user; older endpoints used .user or returned it at root. */
function unwrapUser(resp: IgProfileResponse): IgUser {
  return resp.data?.user ?? resp.user ?? (resp as unknown as IgUser);
}

/**
 * Unwrap TikHub's posts response.
 * v2 fetch_user_posts → data.data.items[] (after tikhubGet strips the
 *   outer envelope, we see resp.data.items).
 * v3 get_user_posts   → data.items[] (resp.items at this layer).
 * Some endpoints use GraphQL-style edges[].node — kept as fallback.
 */
function unwrapPosts(resp: IgPostsResponse): IgPost[] {
  const v2Items = resp.data?.items;
  if (Array.isArray(v2Items) && v2Items.length > 0) return v2Items;
  if (Array.isArray(resp.items) && resp.items.length > 0) return resp.items;
  if (Array.isArray(resp.edges) && resp.edges.length > 0) {
    return resp.edges.map((e) => e.node).filter((n): n is IgPost => Boolean(n));
  }
  return [];
}

function mapProfile(
  user: IgUser,
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
  const followers = user.follower_count ?? user.edge_followed_by?.count ?? null;
  const following = user.following_count ?? user.edge_follow?.count ?? null;
  const totalPosts =
    user.media_count ?? user.edge_owner_to_timeline_media?.count ?? null;
  return {
    followers,
    following,
    total_posts: totalPosts,
    total_views: viewsSeen ? totalViews : null,
    total_likes: likesSeen ? totalLikes : null,
    raw: {
      username: user.username,
      full_name: user.full_name,
      biography: user.biography,
      profile_pic_url: user.profile_pic_url_hd ?? user.profile_pic_url ?? null,
      is_verified: user.is_verified ?? null,
      sample_size: posts.length,
    },
  };
}

/**
 * Collect a feed's items, following pagination_token only in deep mode.
 * No maxPosts → first page as-is (cron stays cheap). A mid-pagination failure
 * keeps what was already collected.
 */
async function collectFeed(
  first: IgPostsResponse,
  fetchPage: (token: string) => Promise<IgPostsResponse>,
  maxPosts: number | undefined,
): Promise<IgPost[]> {
  const items: IgPost[] = [...unwrapPosts(first)];
  if (maxPosts === undefined) return items;
  let token = first.pagination_token ?? null;
  const MAX_PAGES = 100; // safety bound against a non-advancing cursor
  let pages = 0;
  while (items.length < maxPosts && token && pages < MAX_PAGES) {
    pages += 1;
    let pageResp: IgPostsResponse;
    try {
      pageResp = await fetchPage(token);
    } catch {
      break;
    }
    const pageItems = unwrapPosts(pageResp);
    if (pageItems.length === 0) break;
    items.push(...pageItems);
    const next = pageResp.pagination_token ?? null;
    if (next === token) break; // cursor not advancing — avoid an infinite loop
    token = next;
  }
  if (items.length > maxPosts) items.length = maxPosts;
  return items;
}

export const instagramAdapter: PlatformAdapter = {
  platform: 'instagram',
  sourceId: 'tikhub:instagram/v3',
  async scrape(
    profileUrl: string,
    opts: ScrapeOptions = {},
  ): Promise<ScrapeResult> {
    const handle = extractHandle(profileUrl);

    const fetchPostsPage = (paginationToken?: string) =>
      tikhubGet<IgPostsResponse>({
        path: '/api/v1/instagram/v2/fetch_user_posts',
        query: { username: handle, pagination_token: paginationToken },
        platform: PLATFORM,
        profileUrl,
      });

    const fetchReelsPage = (paginationToken?: string) =>
      tikhubGet<IgPostsResponse>({
        path: '/api/v1/instagram/v2/fetch_user_reels',
        query: { username: handle, pagination_token: paginationToken },
        platform: PLATFORM,
        profileUrl,
      });

    // Parallel: profile (v3 — healthy) + first posts page (v2 — v3 backend
    // currently returns 400 universally; see file header) + first reels page
    // (v2 — catches reels hidden from the profile grid).
    const [profileResp, firstPosts, firstReels] = await Promise.all([
      tikhubGet<IgProfileResponse>({
        path: '/api/v1/instagram/v1/fetch_user_info_by_username',
        query: { username: handle },
        platform: PLATFORM,
        profileUrl,
      }),
      fetchPostsPage().catch((err) => {
        // Posts are supplementary — a private/missing posts tab must not sink
        // the profile snapshot (followers etc.). The profile response below
        // still decides not_found/private. Degrade to empty posts.
        if (
          err instanceof ProfilePrivateError ||
          err instanceof ProfileNotFoundError
        ) {
          return {} as IgPostsResponse;
        }
        throw err;
      }),
      // The reels feed is strictly supplementary on top of the grid feed —
      // any failure degrades to grid-only rather than sinking the scrape.
      fetchReelsPage().catch(() => ({}) as IgPostsResponse),
    ]);

    const user = unwrapUser(profileResp);
    if (!user || (!user.username && !user.pk && !user.id)) {
      throw new ProfileNotFoundError(PLATFORM, profileUrl);
    }
    if (user.is_private) {
      // Private accounts return a thin user object — we can still see follower
      // counts, but no posts. Surface as a recoverable state so the UI can
      // badge the profile and the cron leaves it alone (per spec).
      throw new ProfilePrivateError(PLATFORM, profileUrl);
    }

    // Deep backfill: when maxPosts is set, follow the v2 pagination_token to
    // pull deep back-catalog posts (e.g. an old viral reel beyond the recent
    // window). The default (no maxPosts) stays a single page per feed so the
    // daily cron's per-profile cost is bounded. maxPosts applies per feed.
    const { maxPosts } = opts;
    const rawPosts = await collectFeed(firstPosts, fetchPostsPage, maxPosts);
    const rawReels = await collectFeed(firstReels, fetchReelsPage, maxPosts);

    // Merge grid + reels by external id — the grid version wins when a post
    // appears in both feeds, reels-only posts are appended after.
    const posts: NormalizedPostSnapshot[] = [];
    const seen = new Set<string>();
    for (const p of [...rawPosts, ...rawReels]) {
      const mapped = mapPost(p);
      if (mapped && !seen.has(mapped.external_post_id)) {
        seen.add(mapped.external_post_id);
        posts.push(mapped);
      }
    }

    return {
      profile: mapProfile(user, posts),
      posts,
    };
  },
};
