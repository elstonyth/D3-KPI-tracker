/**
 * One-time DEEP BACKFILL — admin only.
 *
 * POST /api/admin/backfill-posts/[profileId]?count=<n>   (default 300, max 1000)
 *
 * Why this exists: the daily cron and the manual /api/scrape route both do a
 * SHALLOW scrape (a profile's most-recent ~12 posts) to keep per-profile cost
 * low. That misses a creator's older viral posts — e.g. a reel from months ago
 * that out-performs anything recent — so they never reach the leaderboard's
 * Top Content. This route does a DEEP scrape ONCE: it asks the adapter to
 * follow its pagination up to `count` posts, then ingests them through the
 * exact same path as a normal scrape (profile snapshot → media persistence →
 * post snapshots), so the back-catalog viral posts land in post_snapshot with
 * permanent Storage thumbnails.
 *
 * Run it once per profile (onboarding / a backfill batch) — NOT on a schedule.
 * New viral posts are already captured by the cheap recent-N cron because they
 * are recent when they blow up. Keeping the deep scan one-off is the whole
 * point: accuracy without a recurring upstream-cost increase.
 *
 * Admin-only: a deep scrape spends more upstream credits than a normal one, so
 * there is no creator self-serve here (unlike /api/scrape). Mirrors that
 * route's write path; see apps/frontend/src/app/api/scrape/[profileId]/route.ts.
 */

import { NextResponse } from 'next/server';

import { runScraper, ScrapeError } from '@d3/scrapers';
import {
  getSupabaseAdmin,
  persistMediaForPosts,
  setProfileStatus,
  upsertPostSnapshots,
  upsertProfileSnapshot,
  type ProfileRow,
  type ScrapeStatus,
} from '@d3/database';

import { getSupabaseRoute } from '../../../../../lib/supabase-route';
import { isUuid } from '../../../../../lib/ids';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_MAX_POSTS = 300;
const MAX_ALLOWED = 1000;

interface RouteContext {
  params: Promise<{ profileId: string }>;
}

function jsonError(status: number, error: string): Response {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { profileId } = await ctx.params;
  if (!isUuid(profileId)) {
    return jsonError(400, 'invalid profile id');
  }

  // 1. Auth — admins only (deep scrapes cost more upstream credits).
  const route = await getSupabaseRoute();
  const {
    data: { user },
    error: userErr,
  } = await route.auth.getUser();
  if (userErr || !user) {
    return jsonError(401, 'unauthorized');
  }
  const adminCheck = await route.rpc('is_admin');
  if (adminCheck.error) {
    console.error('[backfill-posts] is_admin check failed', adminCheck.error);
    return jsonError(500, 'internal error');
  }
  if (adminCheck.data !== true) {
    return jsonError(403, 'forbidden');
  }

  // 2. How deep? ?count=<n>, clamped to a sane ceiling.
  const parsed = Number(new URL(request.url).searchParams.get('count'));
  const maxPosts =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(Math.floor(parsed), MAX_ALLOWED)
      : DEFAULT_MAX_POSTS;

  // 3. Load the profile (admin client — RLS would deny cross-creator reads).
  const admin = getSupabaseAdmin();
  const profileRes = await admin
    .from('profile')
    .select('*')
    .eq('id', profileId)
    .maybeSingle();
  if (profileRes.error) {
    console.error('[backfill-posts] load profile failed', profileRes.error);
    return jsonError(500, 'internal error');
  }
  const profile = profileRes.data as ProfileRow | null;
  if (!profile) {
    return jsonError(404, 'profile not found');
  }

  // 4. Deep scrape + write — same path as the normal scrape, just with maxPosts.
  try {
    const { profile: snap, posts } = await runScraper(
      profile.platform,
      profile.profile_url,
      { maxPosts },
    );

    const profileWrite = await upsertProfileSnapshot(profile.id, snap);
    const persistedPosts = await persistMediaForPosts(profile.id, posts);
    const postsWrite = await upsertPostSnapshots(profile.id, persistedPosts);
    await setProfileStatus(profile.id, 'ok');

    return NextResponse.json(
      {
        ok: true,
        maxPosts,
        scraped: posts.length,
        written: { profile: profileWrite.written, posts: postsWrite.written },
      },
      { status: 200 },
    );
  } catch (err) {
    const status: ScrapeStatus =
      err instanceof ScrapeError ? (err.status as ScrapeStatus) : 'failed';
    try {
      await setProfileStatus(profile.id, status);
    } catch {
      // Best-effort — surface the original scrape error below.
    }
    return NextResponse.json(
      {
        ok: false,
        status,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 200 },
    );
  }
}
