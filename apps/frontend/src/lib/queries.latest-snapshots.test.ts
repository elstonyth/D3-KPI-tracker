/**
 * latestSnapshotsForProfiles must fetch the latest snapshot PER PROFILE with a
 * bounded query per profile — not one unbounded `.in()` over full snapshot
 * history. PostgREST caps any single response at ~1000 rows, so the old
 * unbounded-history approach silently dropped a profile's latest row once the
 * combined history of the creator's profiles exceeded the cap (~200 days at
 * 5 profiles), rendering null followers on /creators/<handle>.
 */
jest.mock('./supabase-server', () => ({ getSupabaseRead: jest.fn() }));

import { getSupabaseRead } from './supabase-server';
import { latestSnapshotsForProfiles } from './queries';

const mockRead = getSupabaseRead as unknown as jest.Mock;

type Result = { data: unknown[] | null; error: { message: string } | null };

/** Fake PostgREST builder: records the .eq() profile id and resolves the
 *  per-profile result at .limit(). Chain shape: select→eq→order→order→limit. */
function fakeClient(byProfile: Record<string, Result>) {
  const limits: number[] = [];
  const from = jest.fn(() => {
    const q = {
      _id: '',
      select: jest.fn(() => q),
      eq: jest.fn((_col: string, id: string) => {
        q._id = id;
        return q;
      }),
      order: jest.fn(() => q),
      limit: jest.fn((n: number) => {
        limits.push(n);
        return Promise.resolve(byProfile[q._id] ?? { data: [], error: null });
      }),
    };
    return q;
  });
  return { client: { from }, from, limits };
}

const snap = (profileId: string, followers: number) => ({
  profile_id: profileId,
  followers,
  following: 1,
  total_posts: 2,
  total_views: 3,
  total_likes: 4,
  captured_at: '2026-06-10T00:00:00Z',
  raw: {},
});

beforeEach(() => mockRead.mockReset());

test('fetches latest snapshot per profile with limit(1) — no unbounded history scan', async () => {
  const { client, from, limits } = fakeClient({
    a: { data: [snap('a', 100)], error: null },
    b: { data: [snap('b', 200)], error: null },
  });
  mockRead.mockReturnValue(client);

  const map = await latestSnapshotsForProfiles(['a', 'b']);

  expect(map.get('a')?.followers).toBe(100);
  expect(map.get('b')?.followers).toBe(200);
  // One bounded query per profile — the shape that cannot be truncated.
  expect(from).toHaveBeenCalledTimes(2);
  expect(limits).toEqual([1, 1]);
});

test('one profile erroring does not drop the others', async () => {
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const { client } = fakeClient({
      a: { data: null, error: { message: 'boom' } },
      b: { data: [snap('b', 200)], error: null },
    });
    mockRead.mockReturnValue(client);

    const map = await latestSnapshotsForProfiles(['a', 'b']);

    expect(map.has('a')).toBe(false);
    expect(map.get('b')?.followers).toBe(200);
    expect(err).toHaveBeenCalled();
  } finally {
    err.mockRestore();
  }
});

test('duplicate profile ids are deduped to a single query', async () => {
  const { client, from } = fakeClient({
    a: { data: [snap('a', 100)], error: null },
  });
  mockRead.mockReturnValue(client);

  const map = await latestSnapshotsForProfiles(['a', 'a', 'a']);

  expect(map.get('a')?.followers).toBe(100);
  expect(from).toHaveBeenCalledTimes(1);
});

test('empty profileIds short-circuits without touching the client', async () => {
  const { client, from } = fakeClient({});
  mockRead.mockReturnValue(client);

  const map = await latestSnapshotsForProfiles([]);

  expect(map.size).toBe(0);
  expect(from).not.toHaveBeenCalled();
});
