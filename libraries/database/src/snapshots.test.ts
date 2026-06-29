/**
 * Unit tests for upsertPostSnapshots — de-dup (bug hunt 2026-06-01) plus
 * deep-backfill robustness (chunking + NUL stripping, 2026-06-03).
 * getSupabaseAdmin is mocked, so these run offline with no DB connection.
 */
jest.mock('./supabase-server', () => ({ getSupabaseAdmin: jest.fn() }));

import { getSupabaseAdmin } from './supabase-server';
import { upsertPostSnapshots, type PostSnapshotInput } from './snapshots';

const mockAdmin = getSupabaseAdmin as unknown as jest.Mock;

/** True if the string contains an unpaired UTF-16 surrogate. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        i++;
        continue;
      }
      return true; // lone high
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true; // lone low
  }
  return false;
}

function post(id: string, views: number): PostSnapshotInput {
  return {
    external_post_id: id,
    posted_at: null,
    caption_excerpt: null,
    views,
    likes: null,
    comments: null,
    shares: null,
    media_url: null,
    content_type: 'short',
    raw: {},
  };
}

test('dedupes posts by external_post_id before the batch upsert', async () => {
  // Without dedup, two rows with the same external_post_id share one ON CONFLICT
  // target and Postgres aborts the entire statement (error 21000), losing every
  // post for the profile that day. Capture the rows actually sent to upsert.
  let captured: any[] = [];
  mockAdmin.mockReturnValue({
    from: () => ({
      upsert: (rows: any[]) => {
        captured = rows;
        return { select: () => ({ data: rows.map((_, i) => ({ id: i })), error: null }) };
      },
    }),
  });

  const res = await upsertPostSnapshots('profile-1', [post('X', 1), post('Y', 9), post('X', 2)]);

  // 3 inputs with a duplicate "X" -> only 2 distinct rows reach the upsert.
  expect(captured).toHaveLength(2);
  expect(captured.map((r) => r.external_post_id).sort()).toEqual(['X', 'Y']);
  // Last write wins (matches the writer's documented idempotent intent).
  expect(captured.find((r) => r.external_post_id === 'X').views).toBe(2);
  expect(res.written).toBe(2);
});

// --- Deep-backfill robustness (2026-06-03) ---
// A deep backfill can upsert hundreds of fat-`raw` rows at once. A single
// statement of that size exceeds Postgres' statement_timeout and the whole
// batch is canceled, so the writer must chunk.

test('chunks large batches so one statement cannot time out', async () => {
  const calls: any[][] = [];
  mockAdmin.mockReturnValue({
    from: () => ({
      upsert: (rows: any[]) => {
        calls.push(rows);
        return { select: () => ({ data: rows.map((_, i) => ({ id: i })), error: null }) };
      },
    }),
  });

  const posts = Array.from({ length: 120 }, (_, i) => post('p' + i, i));
  const res = await upsertPostSnapshots('profile-1', posts);

  expect(calls.length).toBeGreaterThan(1); // split across multiple statements
  expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(50); // each chunk bounded
  expect(calls.reduce((n, c) => n + c.length, 0)).toBe(120); // every distinct post sent once
  expect(res.written).toBe(120); // written count sums across chunks
});

// Postgres jsonb AND text both reject the NUL byte. A scraped caption or raw
// payload that contains one ("invalid input syntax for type json") aborts the
// entire batch, so the writer must strip it. (The NUL char and its JSON-escaped
// form are built at runtime to avoid escape ambiguity in source.)
test('strips NUL bytes from raw and caption so the batch is never rejected', async () => {
  const NUL = String.fromCharCode(0);
  const ESCAPED_NUL = JSON.stringify(NUL).slice(1, -1); // the 6-char sequence in stringified JSON

  let captured: any[] = [];
  mockAdmin.mockReturnValue({
    from: () => ({
      upsert: (rows: any[]) => {
        captured = rows;
        return { select: () => ({ data: rows.map((_, i) => ({ id: i })), error: null }) };
      },
    }),
  });

  const poisoned: PostSnapshotInput = {
    ...post('Z', 1),
    caption_excerpt: `hi${NUL}there`,
    raw: { desc: `bad${NUL}nul`, nested: { t: `x${NUL}y` } },
  };
  await upsertPostSnapshots('profile-1', [poisoned]);

  const row = captured[0];
  expect(JSON.stringify(row.raw)).not.toContain(ESCAPED_NUL); // no escaped NUL survives in raw
  expect(row.caption_excerpt).not.toContain(NUL); // no literal NUL survives in caption
  expect(row.caption_excerpt).toBe('hithere');
});

// Caption truncation can slice an emoji's surrogate PAIR in half, leaving a lone
// surrogate (invalid UTF-8). Postgres then rejects the entire request body as
// "invalid input syntax for type json" (observed 2026-06-03 on heriya_369).
// The writer must drop lone surrogates while keeping valid emoji pairs.
test('strips lone surrogates (split emoji) from caption + raw but keeps valid pairs', async () => {
  const loneHigh = String.fromCharCode(0xd83d); // the leading half of an emoji
  const emoji = String.fromCharCode(0xd83d, 0xde00); // 😀 — a valid pair

  let captured: any[] = [];
  mockAdmin.mockReturnValue({
    from: () => ({
      upsert: (rows: any[]) => {
        captured = rows;
        return { select: () => ({ data: rows.map((_, i) => ({ id: i })), error: null }) };
      },
    }),
  });

  const poisoned: PostSnapshotInput = {
    ...post('S', 1),
    caption_excerpt: `link${loneHigh}`,
    raw: { desc: `keep ${emoji} drop ${loneHigh} end` },
  };
  await upsertPostSnapshots('profile-1', [poisoned]);

  const row = captured[0];
  expect(hasLoneSurrogate(row.caption_excerpt)).toBe(false);
  expect(row.caption_excerpt).toBe('link');
  expect(hasLoneSurrogate(JSON.stringify(row.raw))).toBe(false);
  // The valid emoji pair must survive the scrub (only the lone half is dropped).
  expect((row.raw as { desc: string }).desc).toBe(`keep ${emoji} drop  end`);
});

// --- Data-window guard (2026-06-05) ---
// The product's data window starts 2025-01-01. A one-time cleanup deleted the
// pre-2025 backlog; the writer must drop pre-window posts so a re-scrape can't
// re-introduce them (a Douyin heal had re-added 4 Dec-2024 reels). A post we
// cannot date (null posted_at) is kept — never silently drop an undatable post.
function dated(id: string, postedAt: string | null): PostSnapshotInput {
  return { ...post(id, 1), posted_at: postedAt };
}

test('drops posts published before the 2025-01-01 window, keeps boundary/in-window/undated/unparseable', async () => {
  let captured: any[] = [];
  mockAdmin.mockReturnValue({
    from: () => ({
      upsert: (rows: any[]) => {
        captured = rows;
        return { select: () => ({ data: rows.map((_, i) => ({ id: i })), error: null }) };
      },
    }),
  });

  const res = await upsertPostSnapshots('profile-1', [
    dated('old', '2024-12-16T00:00:00Z'), // before window -> dropped
    dated('boundary', '2025-01-01T00:00:00Z'), // exactly the start -> kept (>= cutoff)
    dated('recent', '2026-03-01T10:00:00Z'), // in window -> kept
    dated('undated', null), // null date -> kept
    dated('unparseable', 'not-a-valid-date'), // unparseable date -> kept (never drop what we can't date)
  ]);

  expect(captured.map((r) => r.external_post_id).sort()).toEqual([
    'boundary',
    'recent',
    'undated',
    'unparseable',
  ]);
  expect(captured.map((r) => r.external_post_id)).not.toContain('old');
  expect(res.written).toBe(4);
});

test('skips the DB entirely when every post is before the data window', async () => {
  let upsertCalled = false;
  mockAdmin.mockReturnValue({
    from: () => ({
      upsert: (rows: any[]) => {
        upsertCalled = true;
        return { select: () => ({ data: rows.map((_, i) => ({ id: i })), error: null }) };
      },
    }),
  });

  const res = await upsertPostSnapshots('profile-1', [dated('a', '2024-06-01T00:00:00Z')]);

  expect(res.written).toBe(0);
  expect(upsertCalled).toBe(false); // returns before touching the DB
});
