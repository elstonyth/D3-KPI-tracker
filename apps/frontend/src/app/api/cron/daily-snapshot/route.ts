/**
 * Snapshot cron — runs hourly via Vercel Cron (requires the Pro plan;
 * Hobby rejects sub-daily schedules at deploy validation).
 *
 * Schedule lives in vercel.json ("0 * * * *"). Each tick processes the
 * PROFILES_PER_RUN least-recently-scraped profiles; setProfileStatus stamps
 * last_scraped_at on every attempt, so a scraped profile sorts to the back
 * and the next tick advances to the next batch. Profiles already attempted
 * today (UTC) are skipped, so hourly ticks drain the roster (~81 profiles)
 * within a day and then no-op for the rest of the day — one scrape per profile
 * per day, no re-scraping. Was daily (02:00 UTC) but 5/day starved the tail.
 *
 * Auth model:
 *   Production: Vercel Cron requests carry x-vercel-cron-signature; we ALSO
 *   require Authorization: Bearer ${CRON_SECRET}. Set CRON_SECRET in Vercel
 *   project env, then add it as the cron's header in vercel.json. Local
 *   manual runs just use curl with the same bearer.
 *
 * Failure semantics:
 *   Sequential per profile. One profile's failure does NOT abort the loop.
 *   Each profile's status is updated to the appropriate scrape_status code
 *   so the UI can surface badges (Task 5 step 2).
 */

import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { runScraper, ScrapeError } from '@d3/scrapers';
import {
  listScrapeableProfiles,
  persistMediaForPosts,
  POST_MEDIA_DEADLINE_MS,
  requeueFacebookForFreshPost,
  setProfileStatus,
  upsertPostSnapshots,
  upsertProfileSnapshot,
} from '@d3/database';
import { withTimeout } from '@gitroom/frontend/lib/with-timeout';
import {
  MIN_SCRAPE_BUDGET_MS,
  WRAPUP_RESERVE_MS,
  facebookRefreshTarget,
  minScrapeBudgetMsFor,
  orderFacebookFirst,
  scrapeTimeoutMsFor,
} from '@gitroom/frontend/lib/scrape-budget';

// Cap dev/manual invocations to a reasonable budget. Vercel Functions
// default 300s timeout; spec says max 5 parallel concurrent Apify runs.
// We run SEQUENTIAL in v1 — at ~50s per IG scrape, that's ~6 profiles max
// per cron invocation before the function times out. Acceptable for MVP.
export const maxDuration = 300;

// Server-only — never prerender at build time.
export const dynamic = 'force-dynamic';

// Per-run capacity cap. Sequential scrapes run ~50s each; 5 × 50s = 250s
// leaves a 50s safety margin under the 300s function timeout. Profiles
// beyond this cap are deferred to the next cron tick — we sort by
// last_scraped_at NULLS FIRST so the least-recently-scraped go first.
//
// TODO: For real scale, migrate to Vercel Queues so each profile gets its
// own invocation budget instead of sharing one 300s window.
// See https://vercel.com/docs/queues
const PROFILES_PER_RUN = 5;

// Per-scrape timeout caps, start floors, and the wrap-up reserve live in
// lib/scrape-budget.ts. They are platform-aware: Facebook's Bright Data
// collector needs up to ~250s, everything else keeps the 120s cap — a flat
// 120s cap (PR #38) falsely failed every Facebook scrape.

interface ProfileResult {
  profile_id: string;
  platform: string;
  handle: string | null;
  status:
    | 'ok'
    | 'failed'
    | 'private'
    | 'not_found'
    | 'throttled'
    | 'handle_changed';
  posts_written?: number;
  error?: string;
}

function assertAuth(request: Request): Response | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // Be loud — never let a misconfigured prod silently accept anonymous traffic.
    console.error('[cron] CRON_SECRET not set — cron auth will fail');
    return NextResponse.json(
      {
        error:
          'CRON_SECRET not configured on the server — add it to Vercel project env vars',
      },
      { status: 500 },
    );
  }
  const auth = request.headers.get('authorization') || '';
  const expectedFull = `Bearer ${expected}`;
  // Length check first so timingSafeEqual doesn't throw on mismatched buffers.
  // The length-mismatch path leaks only "wrong length", not which character —
  // an acceptable oracle for a high-entropy random secret.
  if (
    auth.length !== expectedFull.length ||
    !timingSafeEqual(
      Buffer.from(auth, 'utf8'),
      Buffer.from(expectedFull, 'utf8'),
    )
  ) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const authFail = assertAuth(request);
  if (authFail) return authFail;

  const startedAt = new Date();
  let allProfiles;
  try {
    allProfiles = await listScrapeableProfiles();
  } catch (err) {
    return NextResponse.json(
      {
        error: 'listScrapeableProfiles failed',
        // Keep the stack, not just the message — this 500 is the only signal
        // when the roster query itself fails, so the response is the log.
        detail:
          err instanceof Error
            ? { message: err.message, stack: err.stack }
            : err,
      },
      { status: 500 },
    );
  }

  // Sort by last_scraped_at NULLS FIRST (never-scraped profiles win priority,
  // then oldest first). DB-side ORDER BY would be cleaner — the database lib
  // currently sorts by created_at; sorting here keeps the change surgical.
  const ordered = [...allProfiles].sort((a, b) => {
    if (a.last_scraped_at === null && b.last_scraped_at === null) return 0;
    if (a.last_scraped_at === null) return -1;
    if (b.last_scraped_at === null) return 1;
    return a.last_scraped_at.localeCompare(b.last_scraped_at);
  });

  // Drop profiles already attempted today (UTC) so the hourly cadence stays one
  // scrape per profile per day: once the roster is drained, later ticks find
  // nothing due and no-op instead of looping back to re-scrape the day's
  // earliest profiles — which would burn paid upstream calls (Facebook ~20x
  // TikHub). last_scraped_at is stamped on every attempt and shares the UTC day
  // boundary with the snapshot dedup key (captured_date = CURRENT_DATE).
  // PostgREST returns timestamptz as UTC ISO, so the leading YYYY-MM-DD is the
  // UTC date — compare by prefix (no Date parsing, can't throw on a bad value).
  const todayUtc = startedAt.toISOString().slice(0, 10);
  const due = ordered.filter(
    (p) => (p.last_scraped_at ?? '').slice(0, 10) !== todayUtc,
  );

  const totalEligible = due.length;
  // Facebook first within the batch: only ~1 FB scrape fits per tick at its
  // 250s cap, so it must start while the full wall-clock window remains — an
  // FB profile reached mid-batch would only ever see a partial window and be
  // deferred every tick.
  const profiles = orderFacebookFirst(due.slice(0, PROFILES_PER_RUN));
  const skipped = Math.max(0, totalEligible - profiles.length);

  if (totalEligible > PROFILES_PER_RUN) {
    console.warn('[daily-snapshot] capacity reached', {
      total: totalEligible,
      processed: PROFILES_PER_RUN,
      skipped,
    });
  }

  const results: ProfileResult[] = [];

  for (const profile of profiles) {
    // Cap each scrape by the smaller of its platform's cap and the function's
    // remaining wall-clock (reserving WRAPUP_RESERVE_MS for the upsert + status
    // write). A single hung upstream then can't burn the whole 300s window and
    // 504 the tick. When too little budget remains to finish a scrape, stop and
    // let the next hourly tick take the rest — recording a false 'failed' here
    // would skip a healthy profile until tomorrow (the due-filter is per-day).
    const scrapeBudgetMs =
      maxDuration * 1000 -
      (Date.now() - startedAt.getTime()) -
      WRAPUP_RESERVE_MS;
    if (scrapeBudgetMs < MIN_SCRAPE_BUDGET_MS) {
      console.warn('[daily-snapshot] budget low, deferring remainder', {
        deferred: profiles.length - results.length,
        budget_ms: Math.max(0, scrapeBudgetMs),
      });
      break;
    }
    // Platform floor: Facebook needs its full window up front — starting it on
    // a partial one would falsely fail it (and still bill Bright Data for the
    // abandoned records). Skip WITHOUT stamping so the profile stays due, and
    // let cheaper platforms later in the batch use the remaining budget.
    const platformFloorMs = minScrapeBudgetMsFor(profile.platform);
    if (scrapeBudgetMs < platformFloorMs) {
      console.warn('[daily-snapshot] budget below platform floor, deferring', {
        profile_id: profile.id,
        platform: profile.platform,
        floor_ms: platformFloorMs,
        budget_ms: scrapeBudgetMs,
      });
      continue;
    }
    const scrapeTimeoutMs = Math.min(
      scrapeTimeoutMsFor(profile.platform),
      scrapeBudgetMs,
    );

    try {
      const { profile: snap, posts } = await withTimeout(
        runScraper(profile.platform, profile.profile_url),
        scrapeTimeoutMs,
      );

      await upsertProfileSnapshot(profile.id, snap);
      // Copy post cover images into Storage while their signed CDN URLs are
      // still valid, so thumbnails survive signature expiry (best-effort).
      // Cap the persist step by the function's REMAINING wall-clock budget
      // (minus a reserve for the upsert + status write), so several profiles'
      // persist steps can't compound past maxDuration. When the budget is
      // exhausted the deadline is 0 → persist is skipped and the snapshot
      // (with original CDN URLs) is still written; the backfill heals later.
      const elapsedMs = Date.now() - startedAt.getTime();
      const remainingMs = maxDuration * 1000 - elapsedMs - WRAPUP_RESERVE_MS;
      const mediaDeadlineMs = Math.max(
        0,
        Math.min(POST_MEDIA_DEADLINE_MS, remainingMs),
      );
      const persistedPosts = await persistMediaForPosts(
        profile.id,
        posts,
        mediaDeadlineMs,
      );
      const { written } = await upsertPostSnapshots(profile.id, persistedPosts);
      await setProfileStatus(profile.id, 'ok');

      // Same-day Facebook refresh: a cross-posted video's highest view count is
      // usually on Facebook, but FB scrapes run early-UTC (before the day's post)
      // and only every ~1-3 days, so that number lags the leaderboard. When this
      // cheaper/fresher scrape just surfaced a new post, re-queue the creator's
      // FB profile so it re-scrapes today. Best-effort — never fail the tick.
      const refreshTarget = facebookRefreshTarget(
        profile.platform,
        posts,
        new Date(),
      );
      if (refreshTarget) {
        try {
          await requeueFacebookForFreshPost(profile.creator_id, refreshTarget);
        } catch (err) {
          console.warn('[daily-snapshot] FB refresh re-queue failed', {
            creator_id: profile.creator_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      results.push({
        profile_id: profile.id,
        platform: profile.platform,
        handle: profile.handle,
        status: 'ok',
        posts_written: written,
      });
    } catch (err) {
      const status = err instanceof ScrapeError ? err.status : 'failed';
      const message = err instanceof Error ? err.message : String(err);
      // Surface the failure in Vercel logs. Without this the per-profile error
      // is only visible in the JSON response, so a whole-platform outage (e.g.
      // BrightData "Customer is not active" taking down every Facebook scrape)
      // stays invisible until someone reads a cron response by hand.
      console.error('[daily-snapshot] scrape failed', {
        profile_id: profile.id,
        platform: profile.platform,
        handle: profile.handle,
        status,
        error: message,
      });
      try {
        await setProfileStatus(profile.id, status);
      } catch {
        // Status update itself failed — swallow so the loop continues.
      }
      results.push({
        profile_id: profile.id,
        platform: profile.platform,
        handle: profile.handle,
        status,
        error: message,
      });
    }
  }

  const finishedAt = new Date();
  const summary = {
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    elapsed_ms: finishedAt.getTime() - startedAt.getTime(),
    total_eligible: totalEligible,
    processed: results.length,
    deferred: profiles.length - results.length,
    skipped,
    capacity_per_run: PROFILES_PER_RUN,
    by_status: results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {}),
    results,
  };

  return NextResponse.json(summary, { status: 200 });
}
