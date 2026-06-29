/**
 * Regression guard for the media-backfill cron.
 *
 * `/api/admin/backfill-media` is the automatic healing step that re-copies post
 * thumbnails whose inline (scrape-time) persistence was skipped, while their
 * short-lived social-CDN signatures are still valid. The route being deployed
 * is NOT enough — it only ever runs if vercel.json schedules it. It shipped
 * once unscheduled, so skipped thumbnails 403'd with no automatic recovery.
 * This test fails if the cron is ever dropped from vercel.json again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface CronJob {
  path: string;
  schedule: string;
}

const BACKFILL_PATH = '/api/admin/backfill-media';

const vercelConfig = JSON.parse(
  readFileSync(join(__dirname, '../../vercel.json'), 'utf8'),
) as { crons?: CronJob[] };

describe('vercel.json cron jobs', () => {
  const crons = vercelConfig.crons ?? [];

  it('schedules the media-backfill healing route', () => {
    const paths = crons.map((c) => c.path);
    expect(paths).toContain(BACKFILL_PATH);
  });

  it('runs the backfill heal at 03:00 UTC — after the 02:00 scrape + 02:30 purge', () => {
    const backfill = crons.find((c) => c.path === BACKFILL_PATH);
    expect(backfill).toBeDefined();
    // Pin the exact schedule (not just "5 fields") so retiming the heal window
    // is a conscious change: it must stay after daily-snapshot (02:00) so it
    // heals that run's skipped thumbnails while their CDN URLs are still fresh.
    expect(backfill?.schedule).toBe('0 3 * * *');
  });
});
