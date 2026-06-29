/**
 * Shared time-window definitions for the public period filters (dashboard Total
 * Views hero + leaderboard Top Content). One source of truth so the dashboard
 * pills and the leaderboard pills stay in lock-step.
 *
 * Window semantics = posts PUBLISHED in the window (matches the dashboard's
 * windowed-views RPC). `viewPeriodCutoff` returns the epoch-ms boundary; a post
 * is in-window when its postedAt is on/after it. `lifetime` ⇒ null ⇒ no filter.
 */

export type ViewPeriod = '1d' | '1w' | '1m' | '3m' | '6m' | '12m' | 'lifetime';

export const VIEW_PERIODS: { value: ViewPeriod; label: string; caption: string }[] = [
  { value: '1d', label: '1D', caption: 'last 24 hours' },
  { value: '1w', label: '1W', caption: 'last 7 days' },
  { value: '1m', label: '1M', caption: 'last 30 days' },
  { value: '3m', label: '3M', caption: 'last 3 months' },
  { value: '6m', label: '6M', caption: 'last 6 months' },
  { value: '12m', label: '12M', caption: 'last 12 months' },
  { value: 'lifetime', label: 'Lifetime', caption: 'all-time, across tracked posts' },
];

const PERIOD_DAYS: Record<ViewPeriod, number | null> = {
  '1d': 1,
  '1w': 7,
  '1m': 30,
  '3m': 90,
  '6m': 180,
  '12m': 365,
  lifetime: null,
};

/**
 * Epoch-ms cutoff for a period: posts with postedAt >= cutoff are in-window.
 * Returns null for `lifetime` (no date filter).
 */
export function viewPeriodCutoff(period: ViewPeriod, nowMs: number): number | null {
  const days = PERIOD_DAYS[period];
  return days == null ? null : nowMs - days * 86_400_000;
}
