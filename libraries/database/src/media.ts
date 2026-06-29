/**
 * Post-media persistence.
 *
 * Social-CDN cover-image URLs (cdninstagram / fbcdn / tiktokcdn) are signed
 * with short-lived tokens — TikTok ~24h, Meta ~3 days — and return 403 once
 * the signature expires. Storing those raw URLs in post_snapshot.media_url
 * therefore guarantees broken thumbnails as soon as the window lapses.
 *
 * Fix: copy each post's cover image into our own PUBLIC Storage bucket AT
 * SCRAPE TIME, while the signature is still valid, and store that permanent
 * Supabase URL instead of the ephemeral CDN URL.
 *
 * Best-effort + time-bounded by design:
 *   - A fetch/upload failure leaves that post's media_url as the original CDN
 *     URL (still valid for hours/days; healed later by the media backfill).
 *   - A per-profile wall-clock deadline stops new fetches so a batch of slow
 *     or dead images can never blow the cron's function budget.
 *   - The scrape itself NEVER fails because an image couldn't be copied.
 */

import { getSupabaseAdmin } from './supabase-server';

export const POST_MEDIA_BUCKET = 'post-media';

/** Per-image header-receipt timeout (mirrors the image proxy's 8s ceiling, tightened). */
const FETCH_TIMEOUT_MS = 6000;
/** Concurrent image copies per profile. */
const CONCURRENCY = 8;
/**
 * Default per-profile wall-clock ceiling for the whole persist step. Past this
 * we stop STARTING new fetches and leave the remaining posts on their
 * (still-valid) CDN URLs — the backfill picks them up. Exported so the daily
 * cron can cap it further against the function's remaining 300s budget.
 */
export const POST_MEDIA_DEADLINE_MS = 30_000;

/**
 * Hard cap on a single image we'll buffer in memory before upload. Thumbnails
 * are tens of KB; this guards against a hostile/oversized upstream response
 * OOMing the function. Enforced via content-length AND a streaming byte count
 * (a lying or absent content-length can't bypass it).
 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * SSRF allowlist. media_url comes from third-party scraper responses (TikHub /
 * BrightData), so it's NOT fully trusted — a compromised/crafted upstream could
 * inject an internal URL. Only fetch from the known social-CDN suffixes (the
 * same set the image proxy permits). Anything else is left on its original URL.
 */
const ALLOWED_IMAGE_HOST_SUFFIXES = [
  '.cdninstagram.com',
  '.fbcdn.net',
  '.tiktokcdn.com',
  '.tiktokcdn-us.com',
  '.muscdn.com',
  '.xhscdn.com',
  '.rednotecdn.com',
  '.douyinpic.com',
];

function isAllowedImageHost(host: string): boolean {
  const lower = host.toLowerCase();
  return ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

const PROXY_UA =
  'Mozilla/5.0 (compatible; D3CreatorImageProxy/0.1; +https://www.d3creator.com)';

/** Map an image content-type to a file extension (cosmetic — the stored
 *  content-type is what governs serving). Defaults to jpg. */
function extFromContentType(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes('png')) return 'png';
  if (t.includes('webp')) return 'webp';
  if (t.includes('gif')) return 'gif';
  return 'jpg';
}

/** Keep Storage object keys to a safe charset (post ids are normally
 *  alphanumeric, but never trust upstream). */
function sanitizeKeySegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
}

/** True when the URL already points at our own Storage (nothing to copy). */
function isAlreadyPersisted(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.supabase.co');
  } catch {
    return false;
  }
}

/**
 * Read a response body into memory, aborting if it exceeds maxBytes. Rejects
 * up front on an oversized content-length, then counts streamed bytes so a
 * missing or dishonest content-length can't smuggle past the cap.
 */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<ArrayBuffer | null> {
  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > maxBytes) return null;
  }
  if (!res.body) {
    const buf = await res.arrayBuffer();
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/**
 * Fetch image bytes server-side (no Referer — the same trick the image proxy
 * uses to dodge CDN Referer gates). Returns null on any failure / non-image.
 * Validates the host against the SSRF allowlist and caps the body size.
 */
async function fetchImage(
  url: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!isAllowedImageHost(parsed.hostname)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': PROXY_UA, Accept: 'image/*,*/*;q=0.8' },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) return null;
    const body = await readBodyCapped(res, MAX_IMAGE_BYTES);
    if (!body || body.byteLength === 0) return null;
    return { body, contentType };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Copy one post image into Storage and return its permanent public URL.
 * Returns the source URL unchanged if it's already a Storage URL, or null if
 * the bytes couldn't be fetched/uploaded.
 */
export async function persistPostMedia(
  profileId: string,
  externalPostId: string,
  sourceUrl: string,
): Promise<string | null> {
  if (isAlreadyPersisted(sourceUrl)) return sourceUrl;

  const img = await fetchImage(sourceUrl);
  if (!img) return null;

  const sb = getSupabaseAdmin();
  const key = `${sanitizeKeySegment(profileId)}/${sanitizeKeySegment(
    externalPostId,
  )}.${extFromContentType(img.contentType)}`;

  const up = await sb.storage.from(POST_MEDIA_BUCKET).upload(key, img.body, {
    contentType: img.contentType,
    upsert: true, // re-scrape overwrites with fresh bytes — idempotent
  });
  if (up.error) {
    console.error('[media] upload failed', key, up.error.message);
    return null;
  }

  const pub = sb.storage.from(POST_MEDIA_BUCKET).getPublicUrl(key);
  return pub.data.publicUrl ?? null;
}

/**
 * Rewrite each post's media_url to a permanent Storage URL — best-effort and
 * time-bounded. Posts without media, already-persisted media, or whose copy
 * fails / times out keep their original media_url. Returns NEW post objects
 * (does not mutate the input).
 */
export async function persistMediaForPosts<
  T extends { external_post_id: string; media_url: string | null },
>(profileId: string, posts: T[], deadlineMs: number = POST_MEDIA_DEADLINE_MS): Promise<T[]> {
  const out = posts.slice();
  const startedAt = Date.now();
  let next = 0;

  async function worker(): Promise<void> {
    while (next < out.length) {
      const idx = next++;
      // Budget spent (or zero) — leave this and the rest on their (still-valid)
      // CDN URLs. >= so a deadline of 0 short-circuits immediately.
      if (Date.now() - startedAt >= deadlineMs) return;
      const post = out[idx];
      const src = post.media_url;
      if (!src || !src.startsWith('http')) continue;
      const permanent = await persistPostMedia(profileId, post.external_post_id, src);
      if (permanent && permanent !== src) {
        out[idx] = { ...post, media_url: permanent };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, out.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Avatar persistence — same problem as post media (signed social-CDN URLs
// expire → broken images), same fix (copy into our public Storage bucket at
// scrape time). One object per profile, overwritten each scrape.
// ---------------------------------------------------------------------------

// Avatar field names each adapter writes, in the SAME precedence as the
// frontend's extractRawProfileFields — so persisted + fallback avatars agree.
const AVATAR_RAW_KEYS = [
  'profile_pic_url',
  'avatar_url',
  'profile_pic',
  'profilePicUrlHD',
  'profilePicUrl',
] as const;

/** Pull the avatar URL out of a scraped profile `raw` blob (null if none). */
export function avatarUrlFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  for (const k of AVATAR_RAW_KEYS) {
    const v = r[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Return a copy of `raw` with the avatar field rewritten to `persistedUrl`.
 * Overwrites the first present avatar key (the one avatarUrlFromRaw reads), so
 * the read path (extractRawProfileFields) picks up the permanent Storage URL —
 * with NO new column or migration. Falls back to setting `avatar_url`.
 */
export function withPersistedAvatar(raw: unknown, persistedUrl: string): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  for (const k of AVATAR_RAW_KEYS) {
    if (typeof r[k] === 'string' && (r[k] as string).length > 0) {
      return { ...r, [k]: persistedUrl };
    }
  }
  return { ...r, avatar_url: persistedUrl };
}

/**
 * Copy a profile avatar into Storage and return its permanent public URL. One
 * object per profile (avatars/<profileId>.<ext>), upserted so each scrape
 * overwrites with the freshest avatar. Same best-effort contract as
 * persistPostMedia: returns the source unchanged if it's already a Storage URL,
 * or null if the bytes couldn't be fetched/uploaded.
 */
export async function persistAvatar(
  profileId: string,
  sourceUrl: string,
): Promise<string | null> {
  if (isAlreadyPersisted(sourceUrl)) return sourceUrl;

  const img = await fetchImage(sourceUrl);
  if (!img) return null;

  const sb = getSupabaseAdmin();
  const key = `avatars/${sanitizeKeySegment(profileId)}.${extFromContentType(
    img.contentType,
  )}`;

  const up = await sb.storage.from(POST_MEDIA_BUCKET).upload(key, img.body, {
    contentType: img.contentType,
    upsert: true,
  });
  if (up.error) {
    console.error('[media] avatar upload failed', key, up.error.message);
    return null;
  }

  const pub = sb.storage.from(POST_MEDIA_BUCKET).getPublicUrl(key);
  return pub.data.publicUrl ?? null;
}

/**
 * Persist a profile's avatar to Storage AND point its creator's `avatar_url`
 * column at the permanent URL. That column is what the windowed RPC, the admin
 * views, and the public creator page all read — so writing the persisted URL
 * there is what actually removes the proxy hop (and the expired-CDN 502) from
 * those surfaces, with no read-path change needed.
 *
 * onlyIfUnpersisted=true (scrape path): only overwrites creator.avatar_url when
 * it's currently empty or still a CDN URL, so a daily scrape never clobbers an
 * already-persisted (and possibly higher-follower) avatar the backfill picked.
 * The Storage object is keyed per profile and upserted every scrape, so the
 * bytes behind an already-persisted URL stay fresh regardless.
 *
 * Returns the persisted Storage URL (or null on fetch/upload failure) and
 * whether the creator row was updated.
 */
export async function persistAvatarForProfile(
  profileId: string,
  sourceUrl: string,
  onlyIfUnpersisted = false,
): Promise<{ persisted: string | null; creatorUpdated: boolean }> {
  const persisted = await persistAvatar(profileId, sourceUrl);
  if (!persisted) return { persisted: null, creatorUpdated: false };

  const sb = getSupabaseAdmin();
  const prof = await sb
    .from('profile')
    .select('creator_id')
    .eq('id', profileId)
    .maybeSingle();
  const creatorId = (prof.data?.creator_id as string | null | undefined) ?? null;
  if (prof.error || !creatorId) {
    if (prof.error) {
      console.error('[media] avatar creator lookup failed', profileId, prof.error.message);
    }
    return { persisted, creatorUpdated: false };
  }

  if (onlyIfUnpersisted) {
    const cur = await sb
      .from('creator')
      .select('avatar_url')
      .eq('id', creatorId)
      .maybeSingle();
    // A read failure must NOT be treated as "unpersisted" — that would let a
    // transient error overwrite the backfill's chosen avatar on the scrape path.
    // Preserve the guard: skip the update and let the next scrape/backfill retry.
    if (cur.error) {
      console.error('[media] creator avatar_url read failed', creatorId, cur.error.message);
      return { persisted, creatorUpdated: false };
    }
    const existing = (cur.data?.avatar_url as string | null | undefined) ?? null;
    // Already pointing at our Storage — leave it (and the backfill's best pick).
    if (existing && isAlreadyPersisted(existing)) {
      return { persisted, creatorUpdated: false };
    }
  }

  const upd = await sb.from('creator').update({ avatar_url: persisted }).eq('id', creatorId);
  if (upd.error) {
    console.error('[media] creator avatar_url update failed', creatorId, upd.error.message);
    return { persisted, creatorUpdated: false };
  }
  return { persisted, creatorUpdated: true };
}

export interface AvatarBackfillResult {
  dryRun: boolean;
  /** Creators whose avatar_url is empty or still a CDN URL. */
  candidate_creators: number;
  /** Avatar copied to Storage + creator.avatar_url updated. */
  persisted: number;
  /** Had a candidate avatar, but every source URL was dead/expired. */
  failed: number;
  /** Creator had no avatar in any profile's latest snapshot. */
  no_avatar: number;
}

/**
 * Page a PostgREST select past its ~1000-row response cap. `select(from, to)`
 * must return a query already filtered + ordered by a STABLE key and ranged to
 * [from, to]; we keep requesting pages until one comes back short. Mirrors the
 * post-media backfill's paging (and queries.ts `fetchAllRows`) so a large
 * creator / profile set is never silently truncated.
 */
async function fetchAllRows<T>(
  select: (
    from: number,
    to: number,
  ) => Promise<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await select(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const page = data ?? [];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

/**
 * Backfill creator avatars — copy each not-yet-persisted creator's best avatar
 * into Storage and point creator.avatar_url at the permanent URL. The "best"
 * avatar is the highest-follower profile's latest-snapshot avatar; if that
 * source URL is already dead it falls back to the next profile. Idempotent:
 * creators already on a Storage URL are skipped, and expired-everywhere
 * creators are left for a fresh scrape to recover. Mirrors persistMediaForPosts
 * / the post-media backfill, for avatars.
 */
export async function backfillCreatorAvatars(dryRun = false): Promise<AvatarBackfillResult> {
  const sb = getSupabaseAdmin();

  // Page past the PostgREST row cap — a deployment can have >1000 creators, and
  // an unpaged select would only see the first page (making the backfill + the
  // daily cron silently skip every creator beyond it).
  const creators = await fetchAllRows<{ id: string; avatar_url: string | null }>(
    async (from, to) => {
      const r = await sb
        .from('creator')
        .select('id, avatar_url')
        .order('id', { ascending: true })
        .range(from, to);
      return { data: r.data, error: r.error };
    },
    'backfillCreatorAvatars creators',
  );
  const needing = creators.filter((c) => {
    const a = c.avatar_url ?? null;
    return !a || !isAlreadyPersisted(a);
  });

  const result: AvatarBackfillResult = {
    dryRun,
    candidate_creators: needing.length,
    persisted: 0,
    failed: 0,
    no_avatar: 0,
  };
  if (dryRun || needing.length === 0) return result;

  const creatorIds = needing.map((c) => c.id);
  // Page profiles too — >1000 profiles across the candidate creators would
  // otherwise be truncated, mis-marking creators as no_avatar or picking a
  // lower-priority avatar.
  const profiles = await fetchAllRows<{ id: string; creator_id: string }>(
    async (from, to) => {
      const r = await sb
        .from('profile')
        .select('id, creator_id')
        .in('creator_id', creatorIds)
        .order('id', { ascending: true })
        .range(from, to);
      return { data: r.data, error: r.error };
    },
    'backfillCreatorAvatars profiles',
  );
  const profIds = profiles.map((p) => p.id);
  if (profIds.length === 0) {
    result.no_avatar = needing.length;
    return result;
  }

  // Latest snapshot raw + followers per profile (paged; first row per profile,
  // ordered captured_date desc, is the latest).
  const latest = new Map<string, { raw: unknown; followers: number | null }>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const snapRes = await sb
      .from('profile_snapshot')
      .select('profile_id, followers, raw, captured_date')
      .in('profile_id', profIds)
      .order('captured_date', { ascending: false })
      .range(from, from + PAGE - 1);
    if (snapRes.error) {
      throw new Error(`backfillCreatorAvatars snapshots: ${snapRes.error.message}`);
    }
    const page = snapRes.data ?? [];
    for (const r of page) {
      const pid = r.profile_id as string;
      if (!latest.has(pid)) {
        latest.set(pid, { raw: r.raw, followers: (r.followers as number | null) ?? null });
      }
    }
    if (page.length < PAGE) break;
  }

  const profsByCreator = new Map<string, string[]>();
  for (const p of profiles) {
    const arr = profsByCreator.get(p.creator_id) ?? [];
    arr.push(p.id);
    profsByCreator.set(p.creator_id, arr);
  }

  for (const c of needing) {
    const cid = c.id;
    const candidates = (profsByCreator.get(cid) ?? [])
      .map((pid) => {
        const snap = latest.get(pid);
        return { pid, followers: snap?.followers ?? 0, avatar: avatarUrlFromRaw(snap?.raw) };
      })
      .filter((x): x is { pid: string; followers: number; avatar: string } => !!x.avatar)
      .sort((a, b) => b.followers - a.followers);

    if (candidates.length === 0) {
      result.no_avatar++;
      continue;
    }

    let done = false;
    for (const cand of candidates) {
      // Force-set (onlyIfUnpersisted=false): the backfill is the authority on
      // which avatar a creator gets — the highest-follower one that's still live.
      // Require creatorUpdated too: a persisted URL whose creator write failed
      // hasn't actually healed creator.avatar_url, so keep trying fallbacks.
      const { persisted, creatorUpdated } = await persistAvatarForProfile(
        cand.pid,
        cand.avatar,
        false,
      );
      if (persisted && creatorUpdated) {
        result.persisted++;
        done = true;
        break;
      }
    }
    if (!done) result.failed++; // every candidate URL was dead/expired or unwritable
  }

  return result;
}
