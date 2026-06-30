/**
 * Admin per-creator daily KPI section: summary cards, followers-gained/day bars,
 * views-gained/day bars + cumulative line, and a daily table. Server-rendered
 * from rows fetched in page.tsx. Range switching is the <DaysTabs> links.
 */
import { DailyBars } from '@gitroom/frontend/components/insights/daily-bars';
import { Sparkline } from '@gitroom/frontend/components/dashboard-showcase/sparkline';
import { EmptyState } from '@gitroom/frontend/components/ui/empty-state';
import {
  formatCompact,
  formatDelta,
} from '@gitroom/frontend/lib/creator-metrics';
import type { CreatorDailyKpiRow } from '@gitroom/frontend/lib/metrics-daily';
import type { DaysOption } from '@gitroom/frontend/lib/daily-window';
import { DaysTabs } from './days-tabs';

function deltaClass(n: number): string {
  if (n === 0) return 'text-fgSubtle';
  return n > 0 ? 'text-fg' : 'text-fgMuted';
}
function caret(n: number): string {
  if (n === 0) return '— ';
  return n > 0 ? '▲ ' : '▼ ';
}
function fmtDay(iso: string): string {
  // iso is YYYY-MM-DD; append T00:00 so it parses as local, not UTC-shifted.
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function DailyKpis({
  creatorId,
  days,
  rows,
}: {
  creatorId: string;
  days: DaysOption;
  rows: CreatorDailyKpiRow[];
}) {
  // Show the section whenever there's real data — not only when a prior-day
  // baseline exists. A creator with one day of totals (all rows insufficient, no
  // deltas yet) still gets cards + cumulative line; deltas render as "—".
  const hasData = rows.some((r) => r.followersTotal > 0 || r.viewsTotal > 0);

  const chrono = rows;
  const newestFirst = [...rows].reverse();

  // Insufficient days have no valid prior-day baseline for that metric, so their
  // "gained" is the opening cumulative, not a daily gain — count it as 0 in the
  // sums and bars (the table still shows "—" for those days). Followers and views
  // are flagged independently since views can start later than followers.
  const followersGainedSeries = chrono.map((r) =>
    r.followersInsufficient ? 0 : r.followersGained,
  );
  const viewsGainedSeries = chrono.map((r) =>
    r.viewsInsufficient ? 0 : r.viewsGained,
  );

  const followersNow = rows.length ? rows[rows.length - 1].followersTotal : 0;
  const viewsNow = rows.length ? rows[rows.length - 1].viewsTotal : 0;
  const followersGainedWindow = followersGainedSeries.reduce(
    (a, b) => a + b,
    0,
  );
  const viewsGainedWindow = viewsGainedSeries.reduce((a, b) => a + b, 0);

  return (
    <section className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-section text-fg">KPIs</h2>
        <DaysTabs creatorId={creatorId} current={days} />
      </div>

      {!hasData ? (
        <EmptyState
          icon={
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M3 3v18h18" />
              <path d="M7 15l3-3 3 2 4-5" />
            </svg>
          }
          title="No KPI history yet"
          description="Daily followers and views will appear here after the first scrape lands for this creator."
        />
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="glass-elevated rounded-2xl p-6 flex flex-col justify-between min-h-[120px]">
              <div className="text-label text-fgMuted">Followers</div>
              <div>
                <div className="text-display-2 text-fg tabular-nums leading-none">
                  {formatCompact(followersNow)}
                </div>
                <div
                  className={`text-caption mt-1 tabular-nums ${deltaClass(followersGainedWindow)}`}
                >
                  {caret(followersGainedWindow)}
                  {formatDelta(followersGainedWindow)} in {days}d
                </div>
              </div>
            </div>
            <div className="glass-elevated rounded-2xl p-6 flex flex-col justify-between min-h-[120px]">
              <div className="text-label text-fgMuted">Views</div>
              <div>
                <div className="text-display-2 text-fg tabular-nums leading-none">
                  {formatCompact(viewsGainedWindow)}
                </div>
                <div className="text-caption mt-1 text-fgSubtle tabular-nums">
                  gained in {days}d · {formatCompact(viewsNow)} total
                </div>
              </div>
            </div>
          </div>

          {/* Followers gained / day */}
          <div className="glass-subtle border border-borderGlass rounded-2xl p-5">
            <div className="text-label text-fgMuted mb-3">
              Followers gained / day
            </div>
            <div className="h-[160px]">
              <DailyBars
                values={followersGainedSeries}
                ariaLabel="Followers gained per day"
              />
            </div>
          </div>

          {/* Views gained / day + cumulative line */}
          <div className="glass-subtle border border-borderGlass rounded-2xl p-5 flex flex-col gap-4">
            <div>
              <div className="text-label text-fgMuted mb-3">
                Views gained / day
              </div>
              <div className="h-[160px]">
                <DailyBars
                  values={viewsGainedSeries}
                  ariaLabel="Views gained per day"
                />
              </div>
            </div>
            <div>
              <div className="text-label text-fgMuted mb-3">
                Cumulative views
              </div>
              <div className="h-[120px]">
                <Sparkline
                  values={chrono.map((r) => r.viewsTotal)}
                  ariaLabel="Cumulative views"
                />
              </div>
            </div>
          </div>

          {/* Daily table */}
          <div className="glass-subtle border border-borderGlass rounded-2xl overflow-hidden">
            <div className="max-h-[360px] overflow-auto">
              <table className="w-full text-caption">
                <thead className="sticky top-0 bg-canvas">
                  <tr className="text-fgMuted text-left">
                    <th className="font-medium px-4 py-2.5">Date</th>
                    <th className="font-medium px-4 py-2.5 text-right">
                      Followers
                    </th>
                    <th className="font-medium px-4 py-2.5 text-right">
                      Followers Δ
                    </th>
                    <th className="font-medium px-4 py-2.5 text-right">
                      Views
                    </th>
                    <th className="font-medium px-4 py-2.5 text-right">
                      Views Δ
                    </th>
                  </tr>
                </thead>
                <tbody className="text-fg tabular-nums">
                  {newestFirst.map((r) => (
                    <tr key={r.day} className="border-t border-white/[0.04]">
                      <td className="px-4 py-2.5 text-fgMuted">
                        {fmtDay(r.day)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {formatCompact(r.followersTotal)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right ${r.followersInsufficient ? 'text-fgSubtle' : deltaClass(r.followersGained)}`}
                      >
                        {r.followersInsufficient
                          ? '—'
                          : `${caret(r.followersGained)}${formatDelta(r.followersGained)}`}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {formatCompact(r.viewsTotal)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right ${r.viewsInsufficient ? 'text-fgSubtle' : deltaClass(r.viewsGained)}`}
                      >
                        {r.viewsInsufficient
                          ? '—'
                          : `${caret(r.viewsGained)}${formatDelta(r.viewsGained)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
