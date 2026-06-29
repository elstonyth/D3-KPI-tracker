import {
  compactFormatter,
  exactFormatter,
  formatShowcase,
} from './showcase-data';

/**
 * Responsive showcase number for the Top Creators tables.
 *
 * On phones (< `sm`) it renders the compact abbreviation ("30.1M", "683.8K")
 * so the wide full-digit form does not crowd / overlap the adjacent Creator
 * name. From `sm` up it shows the full-digit millions ("30,053,805") via
 * `formatShowcase()`, exactly as before.
 *
 * Pass `exact` to spell out the full-digit value on desktop for EVERY
 * magnitude ("155,873" instead of "155.9K") — `formatShowcase()` otherwise
 * still compacts sub-million values. Mobile stays compact regardless, to keep
 * the wide form from crowding the adjacent Creator name.
 *
 * Two spans toggled by CSS (not a JS media query) — SSR-safe, no hydration
 * drift, and the hidden span (display:none) does not contribute to the grid
 * column's `auto` width, so the column shrinks to the compact value on mobile.
 */
export function ShowcaseNumber({
  value,
  exact = false,
}: {
  value: number;
  exact?: boolean;
}) {
  return (
    <>
      <span className="sm:hidden">{compactFormatter.format(value)}</span>
      <span className="hidden sm:inline">
        {exact ? exactFormatter.format(value) : formatShowcase(value)}
      </span>
    </>
  );
}
