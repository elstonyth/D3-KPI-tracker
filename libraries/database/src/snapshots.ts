/**
 * Snapshot writes — called by the daily cron and the manual scrape trigger.
 *
 * Uniqueness is enforced by the unique indexes from migration
 * 20260527135229_init_v1_core_tables:
 *   profile_snapshot_unique_day  (profile_id, captured_date)
 *   post_snapshot_unique_day     (profile_id, external_post_id, captured_date)
 *
 * Both writers UPSERT with onConflict so re-running on the same day is
 * idempotent (the latest values win — last write wins, intentional).
 */

import { getSupabaseAdmin } from './supabase-server';
import {
  avatarUrlFromRaw,
  persistAvatarForProfile,
  withPersistedAvatar,
} from './media';
import type { ProfileRow, ScrapeStatus } from './types';

/** A deep backfill can upsert hundreds of fat-`raw` rows at once. A single
 *  statement of that size exceeds Postgres' statement_timeout and the whole
 *  batch is canceled (observed 2026-06-03 on the largest catalogs). Splitting
 *  into bounded chunks keeps each statement well under the limit. */
const POST_UPSERT_CHUNK = 50;

/** The product's data window starts here. Posts published before this date are
 *  out of scope and dropped on write: a one-time cleanup deleted the pre-2025
 *  backlog, but without this guard any re-scrape (daily cron or admin backfill)
 *  would re-introduce old posts a platform still returns among a profile's
 *  recent items. Only post_snapshot is windowed — profile_snapshot is a daily
 *  aggregate with no post date. */
export const DATA_WINDOW_START = '2025-01-01';
const DATA_WINDOW_START_MS = Date.parse(`${DATA_WINDOW_START}T00:00:00Z`);

/** True only when posted_at definitively parses to an instant before the data
 *  window. A null or unparseable date returns false — never silently drop a
 *  post we cannot date. Comparing instants (not strings) matches the DB's
 *  `posted_at < '2025-01-01'` semantics across timezone offsets. */
function isBeforeDataWindow(postedAt: string | null): boolean {
  if (!postedAt) return false;
  const t = Date.parse(postedAt);
  return !Number.isNaN(t) && t < DATA_WINDOW_START_MS;
}

// Postgres rejects two things inside otherwise-valid JSON/text that scraped
// payloads can contain, and either aborts the whole UPSERT:
//   1. an embedded NUL byte (text & jsonb both reject it), and
//   2. a lone (unpaired) UTF-16 surrogate — produced when a caption truncation
//      slices an emoji's surrogate pair in half. Both surface as "invalid input
//      syntax for type json". We strip the NUL and any lone surrogate while
//      keeping valid emoji pairs. (Literals are built from char codes so no
//      NUL/surrogate ever has to appear in this source file.)
const NUL = String.fromCharCode(0);
const ESCAPED_NUL = JSON.stringify(NUL).slice(1, -1); // "" as it appears in stringified JSON
const SURROGATE_ESCAPE = String.fromCharCode(92) + 'ud'; // "\ud" — prefix of every surrogate escape

/** Drop NUL bytes and lone surrogates from a string; keep valid surrogate pairs. */
function scrubText(s: string): string {
  let needs = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0 || (c >= 0xd800 && c <= 0xdfff)) {
      needs = true;
      break;
    }
  }
  if (!needs) return s; // fast path — the overwhelming majority of fields
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue; // NUL
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i] + s[i + 1]; // valid pair — keep both halves
        i++;
        continue;
      }
      continue; // lone high surrogate
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue; // lone low surrogate
    out += s[i];
  }
  return out;
}

/** Deep-scrub every string (and key) so a poisoned field can't 400 the jsonb write. */
function scrubDeep(v: unknown): unknown {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v))
      out[scrubText(k)] = scrubDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** Sanitize a value bound for a jsonb column. Cheap stringify check first; only
 *  pay the deep-walk when a NUL or surrogate escape is actually present. */
function sanitizeJsonForPg(value: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return value; // non-serializable — leave as-is (shouldn't happen for raw)
  }
  if (json === undefined) return value;
  const lower = json.toLowerCase();
  if (
    lower.indexOf(ESCAPED_NUL) === -1 &&
    lower.indexOf(SURROGATE_ESCAPE) === -1
  ) {
    return value; // fast path — no NUL, no surrogates at all
  }
  return scrubDeep(value);
}

/** Shape returned by the scraper layer (mirror of @d3/scrapers NormalizedProfileSnapshot). */
export interface ProfileSnapshotInput {
  followers: number | null;
  following: number | null;
  total_posts: number | null;
  total_views: number | null;
  total_likes: number | null;
  raw: unknown;
}

/** Shape returned by the scraper layer (mirror of NormalizedPostSnapshot). */
export interface PostSnapshotInput {
  external_post_id: string;
  posted_at: string | null;
  caption_excerpt: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  media_url: string | null;
  content_type: string;
  raw: unknown;
}

// scrape_status values that need a human to re-enable (private profile / dead
// page / renamed handle). The cron skips them and the FB refresh re-queue leaves
// them alone — kept as one PostgREST `in` list so the two filters can't drift.
const HUMAN_GATED_STATUSES = '("private","not_found","handle_changed")';

/** Profiles the cron should attempt today. */
export async function listScrapeableProfiles(): Promise<ProfileRow[]> {
  const sb = getSupabaseAdmin();
  // Skip statuses that require user action to re-enable; the rest are fair game.
  const res = await sb
    .from('profile')
    .select('*')
    .not('scrape_status', 'in', HUMAN_GATED_STATUSES)
    .order('created_at', { ascending: true });
  if (res.error) {
    throw new Error(`listScrapeableProfiles failed: ${res.error.message}`);
  }
  return (res.data ?? []) as ProfileRow[];
}

/**
 * Idempotent UPSERT keyed on (profile_id, captured_date).
 * Returns the count of rows actually written so callers can report real
 * observability data instead of an assumed 1.
 */
export async function upsertProfileSnapshot(
  profileId: string,
  snap: ProfileSnapshotInput,
): Promise<{ written: number }> {
  const sb = getSupabaseAdmin();

  // Persist the avatar to Storage (best-effort) so it survives CDN signature
  // expiry — same rationale as post media. On success we (a) point the
  // creator's `avatar_url` column at the permanent Storage URL — that column is
  // what the windowed RPC, admin views, and public creator page read, so this
  // is what removes the proxy hop + expired-CDN 502 — and (b) rewrite the
  // avatar field INSIDE `raw` too, so raw-based readers also get the permanent
  // URL. `onlyIfUnpersisted` keeps a daily scrape from clobbering the backfill's
  // best (highest-follower) pick. A failure leaves the original CDN URL (still
  // valid for hours/days; the next daily scrape/backfill re-persists it). The
  // scrape NEVER fails because an avatar couldn't copy.
  let raw = snap.raw;
  const rawAvatar = avatarUrlFromRaw(raw);
  if (rawAvatar) {
    try {
      const { persisted } = await persistAvatarForProfile(
        profileId,
        rawAvatar,
        true,
      );
      if (persisted && persisted !== rawAvatar)
        raw = withPersistedAvatar(raw, persisted);
    } catch {
      // Keep the original raw (CDN avatar) — healed on the next scrape/backfill.
    }
  }

  const res = await sb
    .from('profile_snapshot')
    .upsert(
      {
        profile_id: profileId,
        followers: snap.followers,
        following: snap.following,
        total_posts: snap.total_posts,
        total_views: snap.total_views,
        total_likes: snap.total_likes,
        raw,
      },
      { onConflict: 'profile_id,captured_date', ignoreDuplicates: false },
    )
    .select('id');
  if (res.error) {
    throw new Error(`upsertProfileSnapshot failed: ${res.error.message}`);
  }
  return { written: res.data?.length ?? 0 };
}

/**
 * Idempotent batch UPSERT of post snapshots. Returns counts for observability.
 * Empty input is a no-op (some platforms may produce 0 posts).
 */
export async function upsertPostSnapshots(
  profileId: string,
  posts: PostSnapshotInput[],
): Promise<{ written: number }> {
  if (posts.length === 0) return { written: 0 };

  // Enforce the data window on the write path so a re-scrape can't re-introduce
  // the pre-2025 backlog the one-time cleanup removed. Dropping here (the single
  // chokepoint for every writer: cron, admin backfill, manual scrape) covers
  // all paths at once.
  const inWindow = posts.filter((p) => !isBeforeDataWindow(p.posted_at));
  if (inWindow.length < posts.length) {
    console.warn(
      `[upsertPostSnapshots] profile ${profileId}: skipped ${posts.length - inWindow.length} post(s) published before ${DATA_WINDOW_START}`,
    );
  }
  if (inWindow.length === 0) return { written: 0 };

  const sb = getSupabaseAdmin();
  // De-duplicate by external_post_id before the batch UPSERT. Every row shares
  // the same (profile_id, captured_date), so two rows with the same
  // external_post_id hit the same ON CONFLICT target and Postgres aborts the
  // entire statement with "ON CONFLICT DO UPDATE command cannot affect row a
  // second time" (21000) — losing every post for the profile that day. Feeds
  // routinely repeat a post (a pinned item also appearing in the timeline).
  // Last write wins, matching this writer's documented idempotent intent.
  const byId = new Map<string, PostSnapshotInput>();
  for (const p of inWindow) byId.set(p.external_post_id, p);
  const rows = [...byId.values()].map((p) => ({
    profile_id: profileId,
    external_post_id: p.external_post_id,
    posted_at: p.posted_at,
    // Strip NUL + lone surrogates so one poisoned field can't 400 the batch.
    caption_excerpt:
      p.caption_excerpt === null ? null : scrubText(p.caption_excerpt),
    views: p.views,
    likes: p.likes,
    comments: p.comments,
    shares: p.shares,
    media_url: p.media_url,
    content_type: p.content_type,
    raw: sanitizeJsonForPg(p.raw),
  }));

  // Chunk the UPSERT: a deep backfill's hundreds of fat-`raw` rows in one
  // statement exceed Postgres' statement_timeout (the whole batch is canceled).
  // Rows are already de-duped, so each external_post_id lands in exactly one
  // chunk — no cross-chunk ON CONFLICT collision.
  let written = 0;
  for (let i = 0; i < rows.length; i += POST_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + POST_UPSERT_CHUNK);
    const res = await sb
      .from('post_snapshot')
      .upsert(chunk, {
        onConflict: 'profile_id,external_post_id,captured_date',
        ignoreDuplicates: false,
      })
      .select('id');
    if (res.error) {
      throw new Error(`upsertPostSnapshots failed: ${res.error.message}`);
    }
    written += res.data?.length ?? 0;
  }
  return { written };
}

/**
 * Re-queue a creator's Facebook profile for a same-day refresh when a fresher
 * platform just surfaced a post the FB scrape predates.
 *
 * Why: FB scrapes are slow (~250s) and run in the early-UTC cron window, before
 * this roster's creators post (~mid-day UTC), so a new video's FB view count —
 * usually the creator's highest — lags 1–3 days and is missing from / under-ranks
 * on the leaderboard until FB's next cadence scrape. The cheap IG/TikTok scrape
 * catches the post next-day-early; this then expires the FB profile's
 * last_scraped_at so the hourly cron re-scrapes FB the same day. (Trigger gating
 * — which platforms, how fresh — lives in lib/scrape-budget facebookRefreshTarget.)
 *
 * Mechanics: the cron's due-filter keys on last_scraped_at's UTC *date* and sorts
 * oldest-first, so writing yesterday-00:00-UTC makes the FB profile due again
 * today and high-priority. Scoped to Facebook and gated on
 * last_scraped_at < newestPostedAt, so it fires at most one extra FB scrape per
 * new post and can't loop (the FB re-scrape stamps last_scraped_at = now > post).
 * not_found / private / handle_changed are left alone — they need a human, mirroring
 * listScrapeableProfiles. Best-effort: callers swallow errors so a re-queue
 * failure never sinks the scrape.
 *
 * Returns the number of FB profiles re-queued (0 or 1 in practice).
 */
export async function requeueFacebookForFreshPost(
  creatorId: string,
  newestPostedAt: string,
): Promise<{ requeued: number }> {
  const sb = getSupabaseAdmin();
  // Yesterday 00:00 UTC: a guaranteed prior UTC date (so the due-filter re-admits
  // it today) that also sorts ahead of anything scraped today.
  const dueAgain = new Date();
  dueAgain.setUTCDate(dueAgain.getUTCDate() - 1);
  dueAgain.setUTCHours(0, 0, 0, 0);

  const res = await sb
    .from('profile')
    .update({ last_scraped_at: dueAgain.toISOString() })
    .eq('creator_id', creatorId)
    .eq('platform', 'facebook')
    .not('scrape_status', 'in', HUMAN_GATED_STATUSES)
    // Only when FB actually predates the post. `.lt` excludes a null
    // last_scraped_at — a never-scraped FB profile is already due (NULLS FIRST).
    .lt('last_scraped_at', newestPostedAt)
    .select('id');
  if (res.error) {
    throw new Error(`requeueFacebookForFreshPost failed: ${res.error.message}`);
  }
  return { requeued: res.data?.length ?? 0 };
}

/** Update profile.scrape_status + last_scraped_at after a scrape attempt. */
export async function setProfileStatus(
  profileId: string,
  status: ScrapeStatus,
  scrapedAt: Date = new Date(),
): Promise<void> {
  const sb = getSupabaseAdmin();
  const res = await sb
    .from('profile')
    .update({
      scrape_status: status,
      last_scraped_at: scrapedAt.toISOString(),
    })
    .eq('id', profileId);
  if (res.error) {
    throw new Error(`setProfileStatus failed: ${res.error.message}`);
  }
}
