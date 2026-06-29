/**
 * Unit tests for the Douyin adapter — deep-backfill pagination (2026-06-03).
 * tikhubGet is mocked, so these run offline and cost no API credits.
 *
 * Douyin's feed reports play_count=0, so the adapter backfills real views from
 * the app/v3 fetch_multi_video_statistics endpoint. The mocks below stub that
 * endpoint too so the deep window's views resolve.
 */
jest.mock('../tikhub-client', () => ({ tikhubGet: jest.fn() }));

import { tikhubGet } from '../tikhub-client';
import { douyinAdapter } from './douyin';

const mockGet = tikhubGet as unknown as jest.Mock;
const PROFILE_URL = 'https://www.douyin.com/user/SEC_ABC';

const healthyProfile = {
  user: {
    uid: '1',
    sec_uid: 'SEC_ABC',
    follower_count: 500,
    following_count: 5,
    aweme_count: 40,
    total_favorited: 12345,
  },
};

const aweme = (id: string) => ({
  aweme_id: id,
  create_time: 1716800000,
  // feed always reports play_count=0 on Douyin; real views come from stats.
  statistics: { play_count: 0, digg_count: 1, comment_count: 1, share_count: 0 },
});

/** Stub fetch_multi_video_statistics: echo a fixed play_count for each id. */
function statsFor(opts: any) {
  const ids = String(opts.query?.aweme_ids ?? '')
    .split(',')
    .filter(Boolean);
  return {
    statistics_list: ids.map((id) => ({
      aweme_id: id,
      play_count: 1000,
      digg_count: 10,
      share_count: 1,
    })),
  };
}

beforeEach(() => mockGet.mockReset());

test('deep mode (maxPosts) paginates via max_cursor across pages', async () => {
  mockGet.mockImplementation(async (opts: any) => {
    if (opts.path.includes('handler_user_profile')) return healthyProfile;
    if (opts.path.includes('fetch_multi_video_statistics')) return statsFor(opts);
    const cursor = Number(opts.query?.max_cursor ?? 0);
    if (cursor === 0) return { aweme_list: [aweme('d1'), aweme('d2')], has_more: 1, max_cursor: 100 };
    if (cursor === 100) return { aweme_list: [aweme('d3')], has_more: 0, max_cursor: 200 };
    return { aweme_list: [], has_more: 0 };
  });

  const res = await douyinAdapter.scrape(PROFILE_URL, { maxPosts: 100 });
  expect(res.posts.map((p) => p.external_post_id)).toEqual(['d1', 'd2', 'd3']);
  // Stats backfill must run across the full deep window, not just page one.
  expect(res.posts.every((p) => p.views === 1000)).toBe(true);
});

test('default scrape fetches a single posts page (cron stays cheap)', async () => {
  let postsCalls = 0;
  mockGet.mockImplementation(async (opts: any) => {
    if (opts.path.includes('handler_user_profile')) return healthyProfile;
    if (opts.path.includes('fetch_multi_video_statistics')) return statsFor(opts);
    postsCalls++;
    return { aweme_list: [aweme('d1')], has_more: 1, max_cursor: 100 };
  });

  const res = await douyinAdapter.scrape(PROFILE_URL);
  expect(postsCalls).toBe(1);
  expect(res.posts).toHaveLength(1);
});

test('a failed stats backfill degrades views to null — never the feed\'s bogus 0', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    mockGet.mockImplementation(async (opts: any) => {
      if (opts.path.includes('handler_user_profile')) return healthyProfile;
      if (opts.path.includes('fetch_multi_video_statistics')) {
        throw new Error('TikHub 500');
      }
      return { aweme_list: [aweme('d1'), aweme('d2')], has_more: 0 };
    });

    const res = await douyinAdapter.scrape(PROFILE_URL);

    // The feed always reports play_count=0 (Douyin hides views there), so
    // falling back to it would WRITE "0 views" for posts with possibly
    // millions — a wrong real value that poisons the snapshot time series.
    // Views must be null (unknown), and the profile window total too.
    expect(res.posts.map((p) => p.views)).toEqual([null, null]);
    expect(res.profile.total_views).toBeNull();
    // Engagement counts the feed DOES report truthfully still flow through.
    expect(res.posts[0].likes).toBe(1);
    expect(res.posts[0].comments).toBe(1);
  } finally {
    warn.mockRestore();
  }
});

test('deep mode stops at maxPosts even if more pages remain', async () => {
  mockGet.mockImplementation(async (opts: any) => {
    if (opts.path.includes('handler_user_profile')) return healthyProfile;
    if (opts.path.includes('fetch_multi_video_statistics')) return statsFor(opts);
    const n = Number(opts.query?.max_cursor ?? 0);
    return { aweme_list: [aweme('x' + n)], has_more: 1, max_cursor: n + 1 };
  });

  const res = await douyinAdapter.scrape(PROFILE_URL, { maxPosts: 3 });
  expect(res.posts).toHaveLength(3);
});
