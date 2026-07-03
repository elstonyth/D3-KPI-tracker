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

import {
  runScraper,
  ScrapeError,
  triggerFacebook,
  collectFacebook,
  type NormalizedPostSnapshot,
  type NormalizedProfileSnapshot,
} from '@d3/scrapers';
import {
  clearFacebookJob,
  listScrapeableProfiles,
  persistMediaForPosts,
  POST_MEDIA_DEADLINE_MS,
  requeueFacebookForFreshPost,
  setFacebookJob,
  setProfileStatus,
  upsertPostSnapshots,
  upsertProfileSnapshot,
} from '@d3/database';
import { withTimeout } from '@gitroom/frontend/lib/with-timeout';
import {
  MIN_SCRAPE_BUDGET_MS,
  WRAPUP_RESERVE_MS,
  facebookRefreshTarget,
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

// Facebook async trigger-then-collect knobs. A trigger is a single Bright Data
// POST (~seconds); the client already bounds each request at 30s, so this outer
// cap is just belt-and-suspenders. A snapshot still building after the stale
// window is abandoned (marked failed, cleared) so it re-triggers next day
// instead of holding the profile's slot forever — the hourly cron gives ~2
// collect attempts before that.
const FB_TRIGGER_TIMEOUT_MS = 30_000;
const FB_JOB_STALE_MS = 2 * 60 * 60 * 1000;

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
    | 'handle_changed'
    // Facebook async phases (not scrape_status values — observability only):
    // an FB snapshot was just triggered, or is still building this tick.
    | 'triggered'
    | 'collecting';
  posts_written?: number;
  error?: string;
}

/**
 * Persist a scrape result: profile snapshot → post media (best-effort, budget
 * capped) → post snapshots → status 'ok'. Shared by the synchronous per-platform
 * loop and the async Facebook collect pass. Returns the post count written.
 */
async function persistScrapeResult(
  profileId: string,
  snap: NormalizedProfileSnapshot,
  posts: NormalizedPostSnapshot[],
  startedAt: Date,
): Promise<number> {
  await upsertProfileSnapshot(profileId, snap);
  // Copy post cover images into Storage while their signed CDN URLs are still
  // valid. Cap by the function's REMAINING wall-clock (minus a wrap-up reserve)
  // so several profiles' persist steps can't compound past maxDuration; when the
  // budget is exhausted the deadline is 0 → persist is skipped and the snapshot
  // (with original CDN URLs) is still written; the backfill heals it later.
  const remainingMs =
    maxDuration * 1000 - (Date.now() - startedAt.getTime()) - WRAPUP_RESERVE_MS;
  const mediaDeadlineMs = Math.max(
    0,
    Math.min(POST_MEDIA_DEADLINE_MS, remainingMs),
  );
  const persistedPosts = await persistMediaForPosts(
    profileId,
    posts,
    mediaDeadlineMs,
  );
  const { written } = await upsertPostSnapshots(profileId, persistedPosts);
  await setProfileStatus(profileId, 'ok');
  return written;
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
  // Facebook first within the batch: an FB "scrape" here is now just a cheap
  // trigger (the collect happens on a later tick), so ordering it first gets the
  // fast POSTs out of the way and leaves the wall-clock window for the
  // synchronous TikHub scrapes that actually consume it.
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

  // --- Facebook async collect pass -----------------------------------------
  // Collect any in-flight FB snapshots triggered on a previous tick. Runs
  // OUTSIDE the due-filter/PROFILES_PER_RUN batch (a trigger never stamps
  // last_scraped_at, so a pending FB profile stays "due" until its result
  // lands). Each check is one cheap GET; only a ready snapshot does the full
  // upsert. A snapshot still building past FB_JOB_STALE_MS is abandoned so it
  // re-triggers rather than holding the slot forever. (An orphaned job on a
  // profile since marked private/not_found is dropped from listScrapeableProfiles
  // and simply won't be collected — a human reset re-scrapes it.)
  // `ordered` is the full sorted roster (defined above); use it — NOT `profiles`
  // — so pending jobs collect regardless of the PROFILES_PER_RUN trigger cap.
  const pendingFb = ordered.filter((p) => p.fb_snapshot_id);
  for (const profile of pendingFb) {
    const snapshotId = profile.fb_snapshot_id as string;
    // A ready collect does an upsert + media persist, so guard the same way as a
    // scrape: if too little wall-clock remains, leave the job and collect next tick.
    const budgetMs =
      maxDuration * 1000 -
      (Date.now() - startedAt.getTime()) -
      WRAPUP_RESERVE_MS;
    if (budgetMs < MIN_SCRAPE_BUDGET_MS) {
      console.warn('[daily-snapshot] budget low, deferring FB collects', {
        budget_ms: Math.max(0, budgetMs),
      });
      break;
    }
    try {
      const collected = await collectFacebook(snapshotId, profile.profile_url);
      if (!collected.ready) {
        const triggeredMs = Date.parse(profile.fb_snapshot_triggered_at ?? '');
        const isStale =
          Number.isFinite(triggeredMs) &&
          Date.now() - triggeredMs > FB_JOB_STALE_MS;
        if (isStale) {
          // Give up on a snapshot Bright Data never finished building.
          await clearFacebookJob(profile.id);
          try {
            await setProfileStatus(profile.id, 'failed');
          } catch {
            // Status write failed — job already cleared; loop continues.
          }
          console.warn('[daily-snapshot] FB snapshot stale, abandoning', {
            profile_id: profile.id,
            snapshot_id: snapshotId,
          });
          results.push({
            profile_id: profile.id,
            platform: profile.platform,
            handle: profile.handle,
            status: 'failed',
            error: `Bright Data snapshot ${snapshotId} still building after ${FB_JOB_STALE_MS}ms — abandoned`,
          });
        } else {
          // Still building — try again next tick.
          results.push({
            profile_id: profile.id,
            platform: profile.platform,
            handle: profile.handle,
            status: 'collecting',
          });
        }
        continue;
      }

      const written = await persistScrapeResult(
        profile.id,
        collected.result.profile,
        collected.result.posts,
        startedAt,
      );
      await clearFacebookJob(profile.id);
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
      console.error('[daily-snapshot] FB collect failed', {
        profile_id: profile.id,
        snapshot_id: snapshotId,
        status,
        error: message,
      });
      // Terminal for this job: clear it so tomorrow re-triggers a fresh one.
      try {
        await clearFacebookJob(profile.id);
      } catch {
        // ignore — best-effort cleanup
      }
      try {
        await setProfileStatus(profile.id, status);
      } catch {
        // ignore — loop continues
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

  for (const profile of profiles) {
    // Facebook is async (trigger-then-collect) so a slow Bright Data job can't
    // block one function past its budget. If a job is already in flight, the
    // collect pass above owns it — skip. Otherwise TRIGGER a new snapshot
    // (fast: one POST) and store its id for a later tick to collect.
    if (profile.platform === 'facebook') {
      if (profile.fb_snapshot_id) continue;
      const budgetMs =
        maxDuration * 1000 -
        (Date.now() - startedAt.getTime()) -
        WRAPUP_RESERVE_MS;
      if (budgetMs < FB_TRIGGER_TIMEOUT_MS) {
        // Not enough budget to trigger safely — leave it due for the next tick.
        continue;
      }
      try {
        const snapshotId = await withTimeout(
          triggerFacebook(profile.profile_url),
          FB_TRIGGER_TIMEOUT_MS,
        );
        await setFacebookJob(profile.id, snapshotId);
        results.push({
          profile_id: profile.id,
          platform: profile.platform,
          handle: profile.handle,
          status: 'triggered',
        });
      } catch (err) {
        const status = err instanceof ScrapeError ? err.status : 'failed';
        const message = err instanceof Error ? err.message : String(err);
        console.error('[daily-snapshot] FB trigger failed', {
          profile_id: profile.id,
          handle: profile.handle,
          status,
          error: message,
        });
        try {
          await setProfileStatus(profile.id, status);
        } catch {
          // ignore — loop continues
        }
        results.push({
          profile_id: profile.id,
          platform: profile.platform,
          handle: profile.handle,
          status,
          error: message,
        });
      }
      continue;
    }

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
        budget_ms: Math.max(0, scrapeBudgetMs),
      });
      break;
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

      const written = await persistScrapeResult(
        profile.id,
        snap,
        posts,
        startedAt,
      );

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
    // processed counts every action taken this tick: synchronous scrapes, plus
    // the async Facebook trigger/collect steps (statuses 'triggered'/'collecting').
    processed: results.length,
    fb_pending_checked: pendingFb.length,
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
