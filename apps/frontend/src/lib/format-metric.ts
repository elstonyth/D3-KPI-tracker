/**
 * Shared presentational helper for windowed metrics.
 *
 * A windowed value (views gained, follower delta) is meaningless until there is
 * a baseline to diff against. The Phase 0 RPCs return `insufficient = true` in
 * that case. Rather than show a misleading number (e.g. a lifetime total
 * masquerading as a 30-day delta), the UI shows this neutral sentinel until
 * enough daily snapshots have accrued.
 */
export const BUILDING_HISTORY = 'Building history…';

/**
 * Decide what to render for one windowed metric cell.
 * @param insufficient  the RPC's insufficient flag for this row/scope
 * @param value         the numeric value (null = not computable yet)
 * @param formatter     how to render a real number (e.g. compactFormatter.format)
 */
export function formatWindowedValue(
  insufficient: boolean,
  value: number | null,
  formatter: (n: number) => string,
): string {
  if (insufficient || value == null) return BUILDING_HISTORY;
  return formatter(value);
}
