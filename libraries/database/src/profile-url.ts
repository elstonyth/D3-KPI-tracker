/**
 * Profile URL parsing + validation.
 *
 * Two responsibilities:
 *  1. detectPlatform(url) — auto-fill the Add Profile modal's platform
 *     dropdown (per spec Section 3 step 1).
 *  2. validateProfileUrl(platform, url) — ensure the URL actually matches
 *     the platform before we save it. Also extracts the public handle so
 *     it can be stored in profile.handle.
 *
 * Patterns are intentionally permissive — Apify actors are robust to query
 * strings, trailing slashes, www. prefixes. Reject only genuinely wrong
 * inputs (cross-platform mismatch, non-profile URLs like /posts/123).
 */

import type { Platform } from './types';

interface PlatformPattern {
  platform: Platform;
  /** Used by detectPlatform — must match the host portion. */
  hostMatch: RegExp;
  /** Used by validateProfileUrl — must capture the handle. */
  handleExtract: RegExp;
  /**
   * Canonical host the normalized URL is rewritten to, so host variants of
   * the same creator (m.instagram.com, no-www, web.facebook.com) collapse to
   * ONE row under the (platform, lower(profile_url)) unique index. Adapters
   * parse the handle from the path only, so the host rewrite is safe.
   */
  canonical: string;
}

const PATTERNS: PlatformPattern[] = [
  {
    platform: 'instagram',
    hostMatch: /(^|\.)instagram\.com$/i,
    // /@handle or /handle (no /p/, /reel/, /tv/ — those are post URLs)
    handleExtract: /^\/(?!p\/|reel\/|tv\/|explore\/|stories\/)@?([A-Za-z0-9._]+)\/?$/,
    canonical: 'www.instagram.com',
  },
  {
    platform: 'tiktok',
    hostMatch: /(^|\.)tiktok\.com$/i,
    // /@handle or /@handle/video/... — accept profile root only
    handleExtract: /^\/@([A-Za-z0-9._]+)\/?$/,
    canonical: 'www.tiktok.com',
  },
  {
    platform: 'facebook',
    hostMatch: /(^|\.)(facebook|fb)\.com$/i,
    // /handle or /pages/Name/123... or /profile.php?id=123 (handled separately)
    handleExtract: /^\/(?!share|reel|posts|watch|groups|events|story\.php)([A-Za-z0-9.\-]+)\/?$/,
    canonical: 'www.facebook.com',
  },
  {
    platform: 'rednote',
    hostMatch: /(^|\.)(xiaohongshu|xhslink)\.com$/i,
    // /user/profile/<id>
    handleExtract: /^\/user\/profile\/([A-Za-z0-9]+)\/?$/,
    canonical: 'www.xiaohongshu.com',
  },
  {
    platform: 'douyin',
    hostMatch: /(^|\.)douyin\.com$/i,
    // /user/<sec_uid> — long alphanumeric
    handleExtract: /^\/user\/([A-Za-z0-9_-]+)\/?$/,
    canonical: 'www.douyin.com',
  },
];

/**
 * Prepend https:// when the user pasted a bare URL with no scheme.
 * People constantly paste "instagram.com/handle" or "www.tiktok.com/@x"
 * without the protocol; without this new URL() throws and the paste is
 * rejected as "malformed".
 *
 * Leaves anything that already has a scheme (https://, ftp://, mailto:)
 * untouched so the downstream protocol/host checks still reject bad input.
 */
function ensureScheme(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  // "scheme://..." or "scheme:..." (mailto:, javascript:) → leave as-is.
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  return `https://${t}`;
}

/**
 * Redirect/short-link hosts we can't resolve without an HTTP round-trip.
 * Reject with an actionable message (telling the user the full-URL form to
 * paste) instead of a confusing "not a profile" error. Auto-resolution
 * (following the redirect) is intentionally out of scope here.
 */
const SHORTLINK_HOSTS: Array<{ re: RegExp; full: string }> = [
  { re: /(^|\.)xhslink\.com$/i, full: 'xiaohongshu.com/user/profile/<id>' },
  { re: /^(vm|vt)\.tiktok\.com$/i, full: 'tiktok.com/@<handle>' },
  { re: /^v\.douyin\.com$/i, full: 'douyin.com/user/<id>' },
];

/** Facebook profile sub-tabs a user might paste along with the profile root. */
const FB_TAB =
  '(?:about|reels_tab|photos|videos|followers|following|friends|reviews|likes|map|mentions|sports)';

/** Detect platform from URL host. Returns null if no match. */
export function detectPlatform(rawUrl: string): Platform | null {
  let u: URL;
  try {
    u = new URL(ensureScheme(rawUrl));
  } catch {
    return null;
  }
  const found = PATTERNS.find((p) => p.hostMatch.test(u.hostname));
  return found?.platform ?? null;
}

export interface ProfileUrlValidation {
  ok: true;
  platform: Platform;
  /** Normalized form: lowercased host, no query/hash, no trailing slash. */
  normalizedUrl: string;
  /** Public handle / numeric id pulled from the path. */
  handle: string;
}

export interface ProfileUrlValidationError {
  ok: false;
  error: string;
}

/**
 * Validate a profile URL is well-formed AND matches the asserted platform.
 * Special-cases facebook.com/profile.php?id=... since the id sits in query.
 */
export function validateProfileUrl(
  platform: Platform,
  rawUrl: string,
): ProfileUrlValidation | ProfileUrlValidationError {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { ok: false, error: 'URL is required' };

  let u: URL;
  try {
    u = new URL(ensureScheme(trimmed));
  } catch {
    return { ok: false, error: 'URL is malformed' };
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: 'URL must use http(s)' };
  }

  // Short-link / redirector hosts can't be resolved without an HTTP round-trip,
  // so they'd pass host validation but fail extraction on every cron. Reject
  // up-front with the full-URL form to paste instead of a cryptic path error.
  const shortlink = SHORTLINK_HOSTS.find((s) => s.re.test(u.hostname));
  if (shortlink) {
    return {
      ok: false,
      error: `Short links (${u.hostname}) aren't supported. Open the link in a browser and paste the full ${shortlink.full} URL.`,
    };
  }

  const pattern = PATTERNS.find((p) => p.platform === platform);
  if (!pattern) {
    return { ok: false, error: `Unknown platform: ${platform}` };
  }
  if (!pattern.hostMatch.test(u.hostname)) {
    return {
      ok: false,
      error: `URL host "${u.hostname}" does not match platform ${platform}`,
    };
  }

  // Facebook has several distinct profile URL shapes — resolve them all here
  // and canonicalize numeric-id forms to /profile.php?id= so the same person
  // pasted two different ways dedupes to one row.
  if (platform === 'facebook') {
    // 1. /profile.php?id=12345 — id lives in the query.
    if (u.pathname === '/profile.php') {
      const id = u.searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) {
        return { ok: false, error: 'Facebook profile.php URL missing numeric ?id=' };
      }
      return {
        ok: true,
        platform,
        normalizedUrl: `https://www.facebook.com/profile.php?id=${id}`,
        handle: id,
      };
    }
    // 2. /people/Some-Name/12345 → canonicalize to profile.php?id=.
    const people = u.pathname.match(/^\/people\/[^/]+\/(\d+)\/?$/);
    if (people) {
      return {
        ok: true,
        platform,
        normalizedUrl: `https://www.facebook.com/profile.php?id=${people[1]}`,
        handle: people[1],
      };
    }
    // 3. /vanity, optionally with a profile sub-tab (/about, /reels_tab, …).
    const vanity = u.pathname.match(
      new RegExp(
        `^/(?!share|reel|posts|watch|groups|events|story\\.php|people|profile\\.php)([A-Za-z0-9.\\-]+)(?:/${FB_TAB})?/?$`,
      ),
    );
    if (vanity) {
      return {
        ok: true,
        platform,
        normalizedUrl: `https://${pattern.canonical}/${vanity[1]}`,
        handle: vanity[1],
      };
    }
    return {
      ok: false,
      error: `URL path "${u.pathname}" is not a Facebook profile (expected a vanity name, /profile.php?id=, or /people/Name/id).`,
    };
  }

  const m = u.pathname.match(pattern.handleExtract);
  if (!m) {
    return {
      ok: false,
      error: `URL path "${u.pathname}" is not a ${platform} profile (expected profile root, not a post/reel/page section)`,
    };
  }

  const handle = m[1];
  // Canonical host so m./web./no-www variants of the same creator dedupe.
  const normalizedUrl = `https://${pattern.canonical}${u.pathname.replace(/\/+$/, '')}`;
  return { ok: true, platform, normalizedUrl, handle };
}

/**
 * SSRF guard for resolveShortLink's redirect following. resolveShortLink chases
 * Location headers from allowlisted short-link services; this blocks any hop
 * whose host is a loopback/private/link-local/cloud-metadata address so the
 * server never fetches an internal endpoint. Hostname/IP-literal check only —
 * does NOT defend against DNS rebinding (a public name resolving to a private
 * IP); acceptable given hops originate from reputable allowlisted platforms.
 */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    return false;
  }
  // IPv6 loopback / link-local / unique-local
  if (h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

/**
 * Resolve an allowlisted short/redirector link to its final URL so it can be
 * validated like any normal profile URL. Only hosts in SHORTLINK_HOSTS trigger
 * a network round-trip; everything else returns unchanged with no fetch.
 *
 * Return contract: on success, returns the resolved (possibly URL-normalised)
 * final URL after following redirects; only on failure (network error, timeout,
 * redirect loop, or hop cap exceeded) does it return the original `rawUrl`
 * unchanged.
 *
 * Safety: we only INITIATE requests to known short-link domains, follow at most
 * 5 redirects with a 3s timeout, and never throw — on any failure we return the
 * original input so the caller's validateProfileUrl rejects it with the usual
 * short-link message (fail closed). The final URL is still validated downstream
 * (must be a known platform PROFILE host), so a redirect elsewhere is rejected.
 */
export async function resolveShortLink(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let u: URL;
  try {
    u = new URL(ensureScheme(rawUrl.trim()));
  } catch {
    return rawUrl;
  }
  if (!SHORTLINK_HOSTS.some((s) => s.re.test(u.hostname))) return rawUrl;

  let current = u.toString();
  for (let hop = 0; hop < 5; hop++) {
    let host: string;
    try {
      host = new URL(current).hostname;
    } catch {
      return rawUrl; // unparseable → fail closed
    }
    if (isPrivateOrLoopbackHost(host)) return rawUrl; // SSRF guard → fail closed
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      return rawUrl; // network error / timeout → fail closed
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return rawUrl;
      let next: string;
      try {
        next = new URL(loc, current).toString();
      } catch {
        return rawUrl;
      }
      if (next === current) return rawUrl; // self-loop
      current = next;
      continue;
    }
    return current; // non-redirect → resolved
  }
  return rawUrl; // exceeded redirect cap
}

/**
 * Fold a handle for cross-platform fuzzy matching used by Auto-Discovery.
 *
 * Steps:
 *  1. lowercase
 *  2. strip separators (. _ -) since they're cosmetic across platforms
 *     (e.g. "j.smith" on IG vs "jsmith" on TikTok vs "j_smith" on Douyin)
 *  3. strip trailing platform-suffix conventions ("official", "real", "tv",
 *     "ig", "tt") creators commonly add to disambiguate alt accounts
 *
 * Returns the folded form. Empty input → "".
 *
 * Mirrors the profile_handle_folded index expression in migration
 * 20260529000001_profile_claim.sql so SQL = TS produces the same value.
 */
export function normalizeHandle(handle: string | null | undefined): string {
  if (!handle) return '';
  const lowered = handle.toLowerCase();
  const stripped = lowered.replace(/[._\-]+/g, '');
  return stripped.replace(/(official|real|tv|ig|tt)$/i, '');
}

