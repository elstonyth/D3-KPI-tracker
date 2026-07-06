/**
 * Central Bright Data Web Scraper API service.
 *
 * Used by the Facebook adapter (Bright Data has prebuilt FB datasets that
 * surface profile counters TikHub/other backends do not). Mirrors the
 * tikhub-client.ts patterns:
 *   - API key handling (BRIGHTDATA_API_KEY env, fail-fast on missing)
 *   - error normalization (404 → not_found, 429 → throttled, 5xx → failed)
 *   - timeouts (default 5 min — matches cron maxDuration)
 *   - polling (5s interval — most FB scrapes resolve in 30s-2min)
 *
 * Bright Data Web Scraper API flow (https://api.brightdata.com/datasets/v3):
 *   1. POST /trigger?dataset_id=<id>&format=json&include_errors=true
 *        body: [{ url: "<profile_url>" }]
 *        → 200 { snapshot_id: "s_..." }
 *   2. GET /progress/<snapshot_id>
 *        → 200 { status: "running" | "ready" | "failed", records?: number }
 *   3. GET /snapshot/<snapshot_id>?format=json
 *        → 200 [{ ...item }, ...]
 *
 * Production runs in Vercel Functions.
 */

import { ProfileNotFoundError, ScrapeError } from './errors';

const DEFAULT_BASE = 'https://api.brightdata.com/datasets/v3';

/** Per-request network timeout (trigger/progress/snapshot each). */
const PER_REQUEST_TIMEOUT_MS = 30_000;

type ProgressStatus =
  | 'running'
  | 'ready'
  | 'failed'
  | 'collecting'
  | 'building';

interface ProgressResponse {
  status?: ProgressStatus;
  records?: number;
  errors?: number;
  message?: string;
}

interface TriggerResponse {
  snapshot_id?: string;
}

/** Minimal context for a progress/snapshot call — just error-message tagging. */
export interface DatasetContext {
  /** Platform tag for error messages. */
  platform: string;
  /** Profile URL — surfaced in error context. */
  profileUrl: string;
}

export interface RunDatasetOptions extends DatasetContext {
  /** Bright Data dataset_id, e.g. 'gd_lkay758p1eanlolqw8'. */
  datasetId: string;
  /** Items to scrape — each becomes one row in the result snapshot. */
  inputs: Array<{ url: string } | Record<string, unknown>>;
  /** Total budget in ms. Default 300_000 (5 min). */
  timeoutMs?: number;
  /** Poll interval in ms. Default 5_000 (5 s). */
  pollIntervalMs?: number;
}

function getBaseUrl(): string {
  return process.env.BRIGHTDATA_API_BASE || DEFAULT_BASE;
}

function requireToken(): string {
  const token = process.env.BRIGHTDATA_API_KEY;
  if (!token) {
    throw new Error(
      'BRIGHTDATA_API_KEY env var is required. Set it in .env (local) or Vercel project env (prod). See .env.example.',
    );
  }
  return token;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireToken()}`,
    Accept: 'application/json',
  };
}

function looksLikeNotFound(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('not found') ||
    m.includes('does not exist') ||
    m.includes('no records') ||
    m.includes('404')
  );
}

function looksLikePrivate(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes('private') ||
    m.includes('restricted') ||
    m.includes('login required')
  );
}

/**
 * Fetch a Bright Data endpoint and parse its JSON body inside a SINGLE
 * per-request timeout window.
 *
 * The timer stays armed until JSON parsing finishes (or fails), so a stalled
 * body read is aborted too — not just a hung connection. The signal passed to
 * fetch also governs the response body stream it produces, so an abort while
 * `res.json()` is draining rejects that read. Clearing the timer before the
 * body was consumed (the previous bug) let a slow body defeat the timeout.
 *
 * A non-JSON 2xx body (maintenance/HTML/proxy page) maps to a ScrapeError
 * rather than a raw SyntaxError that would bypass the status-mapping layer.
 */
async function brightdataFetchJson<T>(
  method: 'GET' | 'POST',
  path: string,
  platform: string,
  profileUrl: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, getBaseUrl() + '/').toString();
  const headers: Record<string, string> = authHeaders();
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PER_REQUEST_TIMEOUT_MS);

  // An abort/timeout surfaces as either a DOMException or a plain Error named
  // AbortError/TimeoutError depending on runtime — match on the name only.
  const isAbort = (err: unknown): boolean => {
    const name = (err as { name?: unknown } | null)?.name;
    return name === 'AbortError' || name === 'TimeoutError';
  };

  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (err) {
      throw new ScrapeError(
        'failed',
        isAbort(err)
          ? `Bright Data request timed out after ${PER_REQUEST_TIMEOUT_MS}ms on ${path}`
          : `Bright Data fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        platform,
        profileUrl,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new ScrapeError(
        'failed',
        `Bright Data auth rejected (${res.status}) — check BRIGHTDATA_API_KEY`,
        platform,
        profileUrl,
      );
    }
    if (res.status === 402) {
      throw new ScrapeError(
        'failed',
        `Bright Data returned 402 — out of credits or dataset not in plan`,
        platform,
        profileUrl,
      );
    }
    if (res.status === 429) {
      throw new ScrapeError(
        'throttled',
        'Bright Data rate-limited the request (429)',
        platform,
        profileUrl,
      );
    }
    if (res.status === 404) {
      // 404 here means the dataset_id / snapshot_id was unknown — not a
      // missing profile. Surface as 'failed' so the cron retries next day
      // rather than marking the profile not_found.
      throw new ScrapeError(
        'failed',
        `Bright Data 404 on ${path} — dataset_id or snapshot_id invalid`,
        platform,
        profileUrl,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ScrapeError(
        'failed',
        `Bright Data HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`,
        platform,
        profileUrl,
      );
    }

    // Parse while the timer is still armed so a stalled body read is aborted.
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new ScrapeError(
        'failed',
        isAbort(err)
          ? `Bright Data body read timed out after ${PER_REQUEST_TIMEOUT_MS}ms on ${path}`
          : 'Bright Data returned a non-JSON body',
        platform,
        profileUrl,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Trigger a Bright Data snapshot and return its snapshot_id WITHOUT polling.
 *
 * The async trigger phase: a caller stores the returned id and collects the
 * result on a later run (collectSnapshot), so no single invocation blocks on a
 * slow collector. runDataset uses this internally for the synchronous path.
 */
export async function triggerScrape(opts: RunDatasetOptions): Promise<string> {
  const path = `trigger?dataset_id=${encodeURIComponent(opts.datasetId)}&format=json&include_errors=true`;
  const body = await brightdataFetchJson<TriggerResponse>(
    'POST',
    path,
    opts.platform,
    opts.profileUrl,
    opts.inputs,
  );
  if (!body.snapshot_id) {
    throw new ScrapeError(
      'failed',
      `Bright Data trigger returned no snapshot_id: ${JSON.stringify(body)}`,
      opts.platform,
      opts.profileUrl,
    );
  }
  return body.snapshot_id;
}

/** Map a `status:"failed"` progress body onto our status taxonomy and throw. */
function throwForFailedProgress(
  body: ProgressResponse,
  ctx: DatasetContext,
): never {
  const msg = body.message || 'collector failed';
  if (looksLikePrivate(msg)) {
    // Re-throw via the higher-level adapter check — keep client generic.
    throw new ScrapeError(
      'private',
      `Bright Data: ${msg}`,
      ctx.platform,
      ctx.profileUrl,
    );
  }
  if (looksLikeNotFound(msg)) {
    throw new ProfileNotFoundError(ctx.platform, ctx.profileUrl);
  }
  throw new ScrapeError(
    'failed',
    `Bright Data: ${msg}`,
    ctx.platform,
    ctx.profileUrl,
  );
}

/** One progress GET. Returns 'ready' or 'building'; throws on a failed collector. */
async function checkProgress(
  snapshotId: string,
  ctx: DatasetContext,
): Promise<'ready' | 'building'> {
  const body = await brightdataFetchJson<ProgressResponse>(
    'GET',
    `progress/${encodeURIComponent(snapshotId)}`,
    ctx.platform,
    ctx.profileUrl,
  );
  const status = (body.status || '').toLowerCase();
  if (status === 'ready') return 'ready';
  if (status === 'failed') throwForFailedProgress(body, ctx);
  // running / collecting / building → not done yet
  return 'building';
}

async function pollProgress(
  snapshotId: string,
  opts: RunDatasetOptions,
): Promise<void> {
  const budget = opts.timeoutMs ?? 300_000;
  const interval = opts.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + budget;

  while (Date.now() < deadline) {
    if ((await checkProgress(snapshotId, opts)) === 'ready') return;
    // running / collecting / building → keep polling
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new ScrapeError(
    'failed',
    `Bright Data snapshot ${snapshotId} did not become ready within ${budget}ms`,
    opts.platform,
    opts.profileUrl,
  );
}

/**
 * Fetch a snapshot's items.
 *
 * Returns `{ ready: false }` for the known race where `/progress` flips to
 * `ready` a beat before `/snapshot?format=json` has materialized the file:
 * in that window the snapshot endpoint returns a `{ status: 'building' | ... }`
 * envelope (often HTTP 202) instead of the array. That is NOT a failure — the
 * caller retries. A genuinely malformed payload (no array, no status) throws.
 */
async function fetchSnapshot<T>(
  snapshotId: string,
  ctx: DatasetContext,
): Promise<CollectResult<T>> {
  const body = await brightdataFetchJson<T[] | { data?: T[]; status?: string }>(
    'GET',
    `snapshot/${encodeURIComponent(snapshotId)}?format=json`,
    ctx.platform,
    ctx.profileUrl,
  );
  if (Array.isArray(body)) return { ready: true, items: body };
  // Some endpoints wrap in { data: [...] } — tolerate.
  if (body && Array.isArray((body as { data?: T[] }).data)) {
    return { ready: true, items: (body as { data: T[] }).data };
  }
  // A { status: <non-ready> } envelope = file not materialized yet → retry.
  const status = (body as { status?: string } | null)?.status;
  if (typeof status === 'string' && status.toLowerCase() !== 'ready') {
    return { ready: false };
  }
  throw new ScrapeError(
    'failed',
    'Bright Data snapshot returned non-array payload',
    ctx.platform,
    ctx.profileUrl,
  );
}

/**
 * Run a Bright Data Web Scraper dataset end-to-end:
 * trigger → poll until ready → fetch snapshot items.
 *
 * After `/progress` reports ready the snapshot file can lag a few seconds, so
 * the fetch is retried (bounded by the same budget) until it materializes.
 */
export async function runDataset<T = unknown>(
  opts: RunDatasetOptions,
): Promise<T[]> {
  const snapshotId = await triggerScrape(opts);
  await pollProgress(snapshotId, opts);

  const interval = opts.pollIntervalMs ?? 5_000;
  // pollProgress already consumed part of the budget; give the materialization
  // wait a bounded tail rather than the full budget again.
  const deadline = Date.now() + Math.min(opts.timeoutMs ?? 300_000, 60_000);
  for (;;) {
    const fetched = await fetchSnapshot<T>(snapshotId, opts);
    if (fetched.ready) return fetched.items;
    if (Date.now() >= deadline) {
      throw new ScrapeError(
        'failed',
        `Bright Data snapshot ${snapshotId} reported ready but never materialized its file`,
        opts.platform,
        opts.profileUrl,
      );
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Result of a one-shot collect: still building, or ready with the items. */
export type CollectResult<T> = { ready: false } | { ready: true; items: T[] };

/**
 * Collect an async snapshot in a SINGLE pass — one progress check, then fetch
 * only if ready. Unlike runDataset it never polls/blocks: a still-building
 * snapshot returns `{ ready: false }` so the caller can try again on a later
 * run. A failed collector throws a classified ScrapeError (private/not_found/
 * failed), same as the synchronous path.
 */
export async function collectSnapshot<T = unknown>(
  snapshotId: string,
  ctx: DatasetContext,
): Promise<CollectResult<T>> {
  // checkProgress throws on a failed collector (private/not_found/failed).
  if ((await checkProgress(snapshotId, ctx)) !== 'ready') {
    return { ready: false };
  }
  // Progress says ready — but the snapshot file may lag a few seconds. fetch
  // returns { ready: false } in that window so the caller retries next run.
  return fetchSnapshot<T>(snapshotId, ctx);
}
