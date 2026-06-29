/**
 * Unit tests for the Facebook adapter (BrightData posts dataset).
 * runDataset is mocked, so these run offline and cost no BrightData credits.
 *
 * Focus: the deep-backfill knob must keep the daily cron cheap. BrightData
 * bills per delivered record, so the default scrape MUST request exactly
 * POSTS_PER_SCRAPE (30); only an explicit { maxPosts } (the admin one-off
 * backfill route) may request more.
 */
import { facebookAdapter } from './facebook';
import { ScrapeError } from '../errors';

jest.mock('../brightdata-client', () => ({ runDataset: jest.fn() }));

import { runDataset } from '../brightdata-client';

const mockRun = runDataset as unknown as jest.Mock;
const PROFILE_URL = 'https://www.facebook.com/profile.php?id=100087382420636';

/** A minimal valid BrightData FB post item (carries the page_* profile fields). */
const fbItem = (over: Record<string, unknown> = {}) => ({
  post_id: 'r1',
  url: 'https://www.facebook.com/reel/123/',
  content: 'hello world',
  date_posted: '2026-05-01T00:00:00Z',
  num_comments: 5,
  num_shares: 2,
  likes: 100,
  video_view_count: 341639,
  has_video: true,
  post_type: 'Reel',
  page_name: 'Test Page',
  page_followers: 13300,
  page_is_verified: true,
  ...over,
});

beforeEach(() => mockRun.mockReset());

test('default scrape requests num_of_posts=30 (daily cron cost unchanged)', async () => {
  mockRun.mockResolvedValue([fbItem()]);

  await facebookAdapter.scrape(PROFILE_URL);

  expect(mockRun).toHaveBeenCalledTimes(1);
  expect(mockRun.mock.calls[0][0].inputs).toEqual([
    { url: PROFILE_URL, num_of_posts: 30 },
  ]);
});

test('deep mode passes maxPosts through as num_of_posts (admin one-off backfill)', async () => {
  mockRun.mockResolvedValue([fbItem()]);

  await facebookAdapter.scrape(PROFILE_URL, { maxPosts: 150 });

  expect(mockRun.mock.calls[0][0].inputs).toEqual([
    { url: PROFILE_URL, num_of_posts: 150 },
  ]);
});

test('maxPosts above the cap is clamped to MAX_POSTS_PER_SCRAPE (200)', async () => {
  mockRun.mockResolvedValue([fbItem()]);

  await facebookAdapter.scrape(PROFILE_URL, { maxPosts: 500 });

  expect(mockRun.mock.calls[0][0].inputs).toEqual([
    { url: PROFILE_URL, num_of_posts: 200 },
  ]);
});

test.each([0, -5, 12.5, NaN])(
  'an invalid maxPosts (%p) throws and never calls Bright Data',
  async (bad) => {
    await expect(
      facebookAdapter.scrape(PROFILE_URL, { maxPosts: bad as number }),
    ).rejects.toThrow(/Invalid maxPosts/);
    expect(mockRun).not.toHaveBeenCalled();
  },
);

// A zero-row delivery is NOT proof of a dead page — Bright Data can return an
// empty `ready` snapshot transiently (block/timeout on their side), and a live
// page with zero recent posts also yields no rows. The cron's due-filter
// permanently excludes `not_found` profiles (human reset required), so empty
// deliveries must surface as retryable `failed`. `not_found` is reserved for
// an explicit per-row error_code (throwForErrorCode).
test('an empty delivery is a retryable failure, not a permanent not_found', async () => {
  mockRun.mockResolvedValue([]);

  const err = await facebookAdapter.scrape(PROFILE_URL).catch((e) => e);

  expect(err).toBeInstanceOf(ScrapeError);
  expect((err as ScrapeError).status).toBe('failed');
});

test('a row with no error code and no page identity is retryable, not not_found', async () => {
  mockRun.mockResolvedValue([{}]);

  const err = await facebookAdapter.scrape(PROFILE_URL).catch((e) => e);

  expect(err).toBeInstanceOf(ScrapeError);
  expect((err as ScrapeError).status).toBe('failed');
});

test('an explicit dead-page error_code still maps to not_found', async () => {
  mockRun.mockResolvedValue([{ error_code: 'dead_page', error: 'page deleted' }]);

  const err = await facebookAdapter.scrape(PROFILE_URL).catch((e) => e);

  expect(err).toBeInstanceOf(ScrapeError);
  expect((err as ScrapeError).status).toBe('not_found');
});

test('maps profile followers + reel views/engagement from the dataset items', async () => {
  mockRun.mockResolvedValue([fbItem()]);

  const res = await facebookAdapter.scrape(PROFILE_URL);

  expect(res.profile.followers).toBe(13300);
  expect(res.profile.total_views).toBe(341639);
  expect(res.posts).toHaveLength(1);
  expect(res.posts[0].external_post_id).toBe('r1');
  expect(res.posts[0].views).toBe(341639);
  expect(res.posts[0].content_type).toBe('video');
  expect(res.posts[0].likes).toBe(100);
  expect(res.posts[0].shares).toBe(2);
  expect(res.posts[0].comments).toBe(5);
});

test('a reel prefers play_count over the lower video_view_count (FB displays plays)', async () => {
  mockRun.mockResolvedValue([
    fbItem({ post_id: 'r2', play_count: 1142280, video_view_count: 692463 }),
  ]);

  const res = await facebookAdapter.scrape(PROFILE_URL);

  expect(res.posts[0].views).toBe(1142280);
  expect(res.profile.total_views).toBe(1142280);
});

test('an image post (no views) maps with null views, not zero', async () => {
  mockRun.mockResolvedValue([
    fbItem({
      post_id: 'i1',
      post_type: 'Post',
      has_video: false,
      video_view_count: undefined,
      play_count: undefined,
      num_views: undefined,
    }),
  ]);

  const res = await facebookAdapter.scrape(PROFILE_URL);

  expect(res.posts[0].views).toBeNull();
  expect(res.posts[0].content_type).toBe('image');
});
