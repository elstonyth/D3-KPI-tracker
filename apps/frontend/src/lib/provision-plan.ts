/**
 * Normalize a raw list of profile-URL inputs from the provisioning form:
 * trim each entry, drop blanks, and de-duplicate case-insensitively while
 * preserving first-seen order. Pure + dependency-free so it is unit-testable
 * (no `@d3/database` import — platform detection/validation happens in the
 * server action, where `detectPlatform`/`findOrCreateProfile` are available).
 */
export function normalizeProvisionUrls(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const url = entry.trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}
