/**
 * Per-platform scrape budget policy for the snapshot cron.
 *
 * One flat 120s cap (PR #38) falsely failed every Facebook scrape: the FB
 * adapter polls Bright Data's posts collector under an internal 240s budget
 * (libraries/scrapers/src/adapters/facebook.ts, FB_BUDGET_MS), so the wrapper
 * killed it mid-poll on every attempt — all 21 FB profiles stamped 'failed'
 * each tick from the 2026-06-09 deploy on. A timed-out trigger still bills
 * for the delivered records we abandon, so each false failure also wasted
 * Bright Data spend.
 *
 * Policy: Facebook gets a cap above the adapter's own budget (so the adapter
 * times out first, with its richer error mapping), everything else keeps the
 * 120s cap. The floor to *start* a scrape is the full FB window for Facebook
 * (a partial window would still falsely fail), the generic 60s for the rest.
 */

// Per-scrape wall-clock ceiling for TikHub-backed platforms. A healthy scrape
// is ~50s; 120s leaves slack for a slow-but-live upstream while capping a HUNG
// one (runScraper takes no AbortSignal — see lib/with-timeout.ts).
export const DEFAULT_SCRAPE_TIMEOUT_MS = 120_000;

// Facebook ceiling: must exceed the adapter's internal 240s Bright Data
// budget, and FACEBOOK_SCRAPE_TIMEOUT_MS + WRAPUP_RESERVE_MS must fit inside
// the route's 300s maxDuration. 250s satisfies both with margin for the
// snapshot upsert.
export const FACEBOOK_SCRAPE_TIMEOUT_MS = 250_000;

// Floor for starting a scrape on the default-cap platforms: don't begin one
// unless at least a typical scrape's worth of budget remains. A scrape started
// with too little budget would time out and be stamped 'failed', and because
// the due-filter keys on last_scraped_at's UTC *date*, that false failure
// would skip the (healthy) profile until tomorrow.
export const MIN_SCRAPE_BUDGET_MS = 60_000;

// Wall-clock reserved at the end of the function budget for the snapshot
// upsert + status write that must run even when media persistence is skipped.
export const WRAPUP_RESERVE_MS = 15_000;

export function scrapeTimeoutMsFor(platform: string): number {
  return platform === 'facebook'
    ? FACEBOOK_SCRAPE_TIMEOUT_MS
    : DEFAULT_SCRAPE_TIMEOUT_MS;
}

export function minScrapeBudgetMsFor(platform: string): number {
  return platform === 'facebook'
    ? FACEBOOK_SCRAPE_TIMEOUT_MS
    : MIN_SCRAPE_BUDGET_MS;
}

/**
 * Put Facebook profiles at the front of a tick's batch, preserving the
 * least-recently-scraped order within each group. Only ~1 FB scrape fits per
 * tick at 250s, so FB must run while the full window is still available — an
 * FB profile reached mid-batch would only ever see a partial window and be
 * deferred forever.
 */
export function orderFacebookFirst<T extends { platform: string }>(
  profiles: T[],
): T[] {
  return [
    ...profiles.filter((p) => p.platform === 'facebook'),
    ...profiles.filter((p) => p.platform !== 'facebook'),
  ];
}

// How recent the newest just-scraped post must be to trigger a same-day
// Facebook refresh. The cheap IG/TikTok scrape catches a new post next-day-early,
// so 2 days covers detection + slack while ignoring dormant creators and deep
// backfills of old content (which would otherwise re-queue FB pointlessly).
export const FB_REFRESH_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * After a successful scrape, decide whether to trigger a same-day Facebook
 * refresh and on which post date.
 *
 * Facebook is the slow (~250s) / expensive laggard: its scrape runs in the early
 * cron window, before this roster's creators post (~mid-day UTC), so a new
 * video's FB view count — usually the creator's highest — is missing from the
 * leaderboard for 1–3 days until FB's next cadence scrape. The cheaper IG/TikTok
 * scrape surfaces the same post sooner; when it does, we re-queue the creator's
 * FB profile (see requeueFacebookForFreshPost) so FB re-scrapes the same day.
 *
 * Returns the newest post's ISO timestamp when a FRESH post was just surfaced,
 * else null. A Facebook scrape never triggers this (no self-loop). A stale
 * newest post (dormant creator / old-content backfill) or a bogus future-dated
 * one is ignored — only recently-published content is chased. Pure for tests.
 */
export function facebookRefreshTarget(
  scrapedPlatform: string,
  posts: ReadonlyArray<{ posted_at: string | null }>,
  now: Date,
): string | null {
  if (scrapedPlatform === 'facebook') return null;
  let newestMs = -Infinity;
  let newestIso: string | null = null;
  for (const p of posts) {
    if (!p.posted_at) continue;
    const t = Date.parse(p.posted_at);
    if (Number.isNaN(t)) continue;
    if (t > newestMs) {
      newestMs = t;
      newestIso = p.posted_at;
    }
  }
  if (newestIso === null) return null;
  // Too old (dormant/backfill) or implausibly future-dated (bad upstream data,
  // which would otherwise re-queue FB every day forever) → don't chase it.
  if (newestMs < now.getTime() - FB_REFRESH_LOOKBACK_MS) return null;
  if (newestMs > now.getTime() + FB_REFRESH_LOOKBACK_MS) return null;
  return newestIso;
}
