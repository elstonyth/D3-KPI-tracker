/**
 * Admin Top-30 ranking. `import type` only — no runtime import of
 * metrics-windowed (which pulls supabase-server) so this stays unit-testable.
 *
 * A follower delta with no in-window baseline (`insufficient`) is not a real
 * growth number, so those creators can't be ranked by growth: rank the
 * sufficient ones by Δ desc, then append the insufficient ones (they render
 * "Building history…"). With ~1 snapshot day in prod today, most rows are
 * insufficient — expected, per the no-fake-deltas decision.
 */
import type { CreatorMetricWindowRow } from './metrics-windowed';

export function rankCreatorsByFollowerDelta(
  rows: CreatorMetricWindowRow[],
): CreatorMetricWindowRow[] {
  const sufficient = rows.filter((r) => !r.insufficient);
  const insufficient = rows.filter((r) => r.insufficient);

  sufficient.sort((a, b) => {
    if (b.followersDelta !== a.followersDelta) return b.followersDelta - a.followersDelta;
    if (b.followers !== a.followers) return b.followers - a.followers;
    return (a.displayName ?? '').localeCompare(b.displayName ?? '');
  });
  insufficient.sort((a, b) => b.followers - a.followers);

  return [...sufficient, ...insufficient];
}
