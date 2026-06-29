/**
 * Media backfill — copy still-valid social-CDN images into the public
 * post-media Storage bucket so the read paths serve permanent Supabase URLs
 * instead of expiring (403/502-via-proxy) CDN URLs. Two passes:
 *   - posts:   rewrite post_snapshot.media_url to the permanent URL.
 *   - avatars: set creator.avatar_url to the persisted URL (the column the
 *              windowed RPC, admin views, and public creator page all read).
 *
 * Re-runnable and idempotent: rows/creators already on supabase.co are
 * excluded, and expired CDN URLs simply fail the fetch and are skipped (they
 * need a fresh scrape to recover). Pairs with the best-effort inline
 * persistence in the scrape path — this heals anything the inline step skipped,
 * plus any media scraped before persistence shipped.
 *
 *   GET /api/admin/backfill-media                 -> backfill posts + avatars
 *   GET /api/admin/backfill-media?only=avatars    -> avatars only
 *   GET /api/admin/backfill-media?only=posts      -> posts only
 *   GET /api/admin/backfill-media?dryRun=1        -> report candidate counts only
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} (same gate as the crons).
 */

import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import {
  getSupabaseAdmin,
  persistPostMedia,
  backfillCreatorAvatars,
  type AvatarBackfillResult,
} from '@d3/database';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CONCURRENCY = 8;

function assertAuth(request: Request): Response | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'CRON_SECRET not configured on the server' },
      { status: 500 },
    );
  }
  const auth = request.headers.get('authorization') || '';
  const expectedFull = `Bearer ${expected}`;
  if (
    auth.length !== expectedFull.length ||
    !timingSafeEqual(Buffer.from(auth, 'utf8'), Buffer.from(expectedFull, 'utf8'))
  ) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

interface CandidateRow {
  profile_id: string;
  external_post_id: string;
  media_url: string;
  captured_date: string;
}

export async function GET(request: Request): Promise<Response> {
  const authFail = assertAuth(request);
  if (authFail) return authFail;

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  // Scope: default heals BOTH post media and creator avatars (the daily cron
  // hits this route with no query string). ?only=posts / ?only=avatars isolates
  // a single pass.
  const only = url.searchParams.get('only');
  // Reject typos (e.g. ?only=avatar): an unrecognized value must NOT silently
  // fall through to running BOTH passes — that turns a scoped run into a full
  // write run. Only null (no param), 'posts', or 'avatars' are valid.
  if (only !== null && only !== 'posts' && only !== 'avatars') {
    return NextResponse.json(
      { error: "invalid 'only' parameter; expected 'posts' or 'avatars'" },
      { status: 400 },
    );
  }
  const doPosts = only !== 'avatars';
  const doAvatars = only !== 'posts';
  const sb = getSupabaseAdmin();

  interface PostBackfillSummary {
    candidate_posts: number;
    candidate_rows?: number;
    persisted?: number;
    failed?: number;
    update_failed?: number;
    rows_updated?: number;
  }
  let posts: PostBackfillSummary | null = null;

  if (doPosts) {
    // Candidate rows: an http(s) media_url that isn't already on our Storage.
    // PostgREST caps a single response at 1000 rows, so page explicitly (ordered
    // by the stable PK so pages don't overlap/skip).
    const PAGE = 1000;
    const rows: CandidateRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const res = await sb
        .from('post_snapshot')
        .select('profile_id, external_post_id, media_url, captured_date')
        .like('media_url', 'http%')
        .not('media_url', 'ilike', '%supabase.co%')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (res.error) {
        return NextResponse.json(
          { error: 'candidate query failed', detail: res.error.message },
          { status: 500 },
        );
      }
      const page = (res.data ?? []) as CandidateRow[];
      rows.push(...page);
      if (page.length < PAGE) break;
    }

    // Dedupe to the latest snapshot per (profile, post) — that's the row the
    // read path displays. We heal all rows for the post in one UPDATE below.
    const latest = new Map<string, CandidateRow>();
    for (const r of rows) {
      const key = `${r.profile_id}::${r.external_post_id}`;
      const cur = latest.get(key);
      if (!cur || r.captured_date > cur.captured_date) latest.set(key, r);
    }
    const candidates = [...latest.values()];

    if (dryRun) {
      posts = { candidate_posts: candidates.length, candidate_rows: rows.length };
    } else {
      let persisted = 0; // image copied to Storage
      let failed = 0; // image fetch/upload failed (kept on its CDN URL)
      let updateFailed = 0; // image copied but the DB heal errored
      let rowsUpdated = 0; // snapshot rows pointed at the permanent URL
      let next = 0;

      const worker = async (): Promise<void> => {
        while (next < candidates.length) {
          const c = candidates[next++];
          const permanent = await persistPostMedia(
            c.profile_id,
            c.external_post_id,
            c.media_url,
          );
          if (!permanent || permanent === c.media_url) {
            failed++;
            continue;
          }
          persisted++;
          // Heal every snapshot row for this post (historical rows share the image).
          const upd = await sb
            .from('post_snapshot')
            .update({ media_url: permanent })
            .eq('profile_id', c.profile_id)
            .eq('external_post_id', c.external_post_id)
            .like('media_url', 'http%')
            .not('media_url', 'ilike', '%supabase.co%')
            .select('id');
          if (upd.error) {
            // Bytes are safe in Storage, but the row still points at the CDN URL —
            // surface it so the run's counts reflect the partial failure.
            updateFailed++;
            console.error(
              '[backfill-media] row update failed',
              c.profile_id,
              c.external_post_id,
              upd.error.message,
            );
            continue;
          }
          rowsUpdated += upd.data?.length ?? 0;
        }
      };

      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

      posts = {
        candidate_posts: candidates.length,
        persisted,
        failed,
        update_failed: updateFailed,
        rows_updated: rowsUpdated,
      };
    }
  }

  // Avatar pass — same idea for creator avatars (creator.avatar_url column).
  const avatars: AvatarBackfillResult | null = doAvatars
    ? await backfillCreatorAvatars(dryRun)
    : null;

  return NextResponse.json({ dryRun, posts, avatars });
}
