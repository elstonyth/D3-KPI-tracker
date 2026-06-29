/**
 * Resolve a stored post-media URL into something the browser can load.
 *
 * `post_snapshot.media_url` holds one of two kinds of URL:
 *
 *   1. Permanent Supabase Storage URLs
 *      (https://<ref>.supabase.co/storage/v1/object/public/post-media/...),
 *      persisted at scrape time. These never expire and are served from our
 *      own origin/CDN — load them directly (CSP `img-src` allows *.supabase.co).
 *
 *   2. Ephemeral social-CDN URLs (cdninstagram / fbcdn / tiktokcdn / …),
 *      signed with short-lived tokens and Referer-gated. These must go through
 *      /api/proxy-image (server-side fetch, no Referer) and only render until
 *      their signature expires. This is the pre-persistence fallback for a
 *      post that was just scraped but whose bytes aren't in Storage yet.
 *
 * Returns null for missing / non-http / malformed input.
 */
export function resolveMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!url.startsWith('http')) return null;

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  // Permanent storage URL — load directly, no proxy hop.
  if (host.endsWith('.supabase.co')) return url;

  // Ephemeral CDN URL — route through the same-origin proxy.
  return `/api/proxy-image?url=${encodeURIComponent(url)}`;
}
