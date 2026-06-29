/**
 * CreatorStats — the 3-KPI body of /me for the selected time window.
 * Followers (absolute + window delta), Views gained in window, Engagement for
 * the window. Engagement is private to /me. Yellow-mono delta; insufficient
 * history → "Building history…".
 */
import type { CreatorMetricWindowRow } from '@gitroom/frontend/lib/metrics-windowed';
import {
  formatCompact,
  formatDelta,
  formatPercent,
} from '@gitroom/frontend/lib/creator-metrics';
import { BUILDING_HISTORY, formatWindowedValue } from '@gitroom/frontend/lib/format-metric';

function deltaClass(n: number): string {
  if (n === 0) return 'text-fgSubtle';
  return n > 0 ? 'text-fg' : 'text-fgMuted';
}
function deltaCaret(n: number): string {
  if (n === 0) return '— ';
  return n > 0 ? '▲ ' : '▼ ';
}

export function CreatorStats({ row }: { row: CreatorMetricWindowRow }) {
  return (
    <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {/* Followers — absolute count + window delta */}
      <div className="glass-elevated rounded-2xl p-6 flex flex-col justify-between min-h-[140px]">
        <div className="text-label text-fgMuted">Followers</div>
        <div>
          <div className="text-display-2 text-fg tabular-nums leading-none">
            {formatCompact(row.followers)}
          </div>
          <div
            className={`text-caption mt-1 tabular-nums ${
              row.insufficient ? 'text-fgSubtle' : deltaClass(row.followersDelta)
            }`}
          >
            {row.insufficient
              ? BUILDING_HISTORY
              : `${deltaCaret(row.followersDelta)}${formatDelta(row.followersDelta)} this window`}
          </div>
        </div>
      </div>

      <Kpi
        label="Views"
        value={formatWindowedValue(false, row.viewsGained, formatCompact)}
        hint="gained this window"
      />
      <Kpi
        label="Engagement"
        value={formatWindowedValue(false, row.engagement, formatPercent)}
        hint="likes ÷ views"
      />
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="glass-subtle border border-borderGlass rounded-2xl p-5 flex flex-col justify-between min-h-[140px]">
      <div className="text-label text-fgMuted">{label}</div>
      <div>
        <div className="text-section text-fg tabular-nums">{value}</div>
        {hint && <div className="text-caption text-fgSubtle mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}
