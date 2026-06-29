/**
 * Shared resolver for a profile's human-readable display name.
 *
 * Why this exists: some platforms (notably Facebook) use a NUMERIC id as the
 * profile handle (e.g. /profile.php?id=61570810834400) and leave
 * profile.display_name null. The readable name only lives in the latest
 * snapshot's `raw` blob under a platform-specific key. Without resolving it,
 * the UI falls through `display_name ?? handle` and shows the bare number.
 *
 * `rawProfileName` mirrors the field-name tolerance already used by
 * queries.ts/extractRawProfileFields so every surface resolves names the same
 * way:
 *   - Instagram: full_name
 *   - TikTok / Douyin / RedNote: nickname
 *   - Facebook: page_name
 *   - Legacy Apify rows: fullName
 */

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** Best readable name from a snapshot.raw blob, or null. */
export function rawProfileName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return (
    asStr(r.full_name) ??
    asStr(r.nickname) ??
    asStr(r.page_name) ??
    asStr(r.fullName) ??
    null
  );
}

/**
 * Resolve the name to show for a profile, in priority order:
 *   stored display_name → name from latest snapshot raw → handle → null.
 * Callers keep their own final fallback to the profile URL if they want one.
 */
export function resolveProfileName(
  displayName: string | null | undefined,
  raw: unknown,
  handle: string | null | undefined,
): string | null {
  return asStr(displayName) ?? rawProfileName(raw) ?? asStr(handle) ?? null;
}
