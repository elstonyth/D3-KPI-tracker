/**
 * Unit tests for the Bright Data client's async collect path. global.fetch is
 * mocked, so these run offline and cost no Bright Data credits.
 *
 * Focus: the /progress→ready then /snapshot materialization race. /progress can
 * report `ready` a beat before /snapshot has materialized the array (it returns
 * a { status: "building" } envelope in between). collectSnapshot must treat that
 * transient envelope as NOT ready (retry next tick), an array as ready (even an
 * empty one), a genuinely malformed payload as a hard failure, and a failed
 * collector's free-text message as its classified error.
 */
import { collectSnapshot } from './brightdata-client';
import { ScrapeError } from './errors';

const SNAP = 'sd_test123';
const CTX = { platform: 'facebook', profileUrl: 'https://facebook.com/x' };

/** Minimal Response stand-in — brightdataFetchJson reads status/ok/json/text. */
function res(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Route the fetch mock by URL: /progress/<id> vs /snapshot/<id>. */
function mockFetch(progressBody: unknown, snapshotBody?: unknown): jest.Mock {
  const fn = jest.fn(async (url: string) =>
    String(url).includes('/progress/') ? res(progressBody) : res(snapshotBody),
  );
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const realFetch = global.fetch;
beforeAll(() => {
  process.env.BRIGHTDATA_API_KEY = 'test-key';
});
afterEach(() => {
  global.fetch = realFetch;
});

test('ready + array snapshot → { ready: true, items }', async () => {
  mockFetch({ status: 'ready' }, [{ post_id: 'a' }, { post_id: 'b' }]);
  await expect(collectSnapshot(SNAP, CTX)).resolves.toEqual({
    ready: true,
    items: [{ post_id: 'a' }, { post_id: 'b' }],
  });
});

test('ready + empty array → ready with no items (0-record is NOT not-ready)', async () => {
  mockFetch({ status: 'ready' }, []);
  await expect(collectSnapshot(SNAP, CTX)).resolves.toEqual({
    ready: true,
    items: [],
  });
});

test('ready + { status: "building" } envelope → not ready (materialization race)', async () => {
  mockFetch({ status: 'ready' }, { status: 'building' });
  await expect(collectSnapshot(SNAP, CTX)).resolves.toEqual({ ready: false });
});

test('progress still running → not ready, and the snapshot is never fetched', async () => {
  const fn = mockFetch({ status: 'running' }, [{ post_id: 'a' }]);
  await expect(collectSnapshot(SNAP, CTX)).resolves.toEqual({ ready: false });
  expect(fn).toHaveBeenCalledTimes(1); // progress only, no snapshot GET
});

test('ready + { data: [...] } wrapper → ready with the wrapped items', async () => {
  mockFetch({ status: 'ready' }, { data: [{ post_id: 'z' }] });
  await expect(collectSnapshot(SNAP, CTX)).resolves.toEqual({
    ready: true,
    items: [{ post_id: 'z' }],
  });
});

test('ready + malformed payload (no array, no status) → hard failure', async () => {
  mockFetch({ status: 'ready' }, { unexpected: true });
  const err = await collectSnapshot(SNAP, CTX).catch((e) => e);
  expect(err).toBeInstanceOf(ScrapeError);
  expect((err as ScrapeError).status).toBe('failed');
});

test('failed collector whose message says "not found" → classified not_found', async () => {
  mockFetch({ status: 'failed', message: 'profile not found' });
  const err = await collectSnapshot(SNAP, CTX).catch((e) => e);
  expect(err).toBeInstanceOf(ScrapeError);
  expect((err as ScrapeError).status).toBe('not_found');
});
