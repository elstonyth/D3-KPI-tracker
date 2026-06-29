/**
 * Top 30 creators by 30-day follower growth. Server-rendered dense table.
 * No engagement column (private-only). Delta uses yellow-mono caret +
 * intensity; `insufficient` rows show "Building history…".
 */
import Link from 'next/link';

import type { CreatorMetricWindowRow } from '@gitroom/frontend/lib/metrics-windowed';
import { formatCompact, formatDelta } from '@gitroom/frontend/lib/creator-metrics';
import { BUILDING_HISTORY } from '@gitroom/frontend/lib/format-metric';
import { PlatformPill } from '@gitroom/frontend/components/ui/platform-pill';
import type { PlatformKey } from '@gitroom/frontend/components/ui/platform-icons';

function toPlatformKey(platform: string | null): PlatformKey | null {
  if (!platform) return null;
  return platform === 'rednote' ? 'xiaohongshu' : (platform as PlatformKey);
}
function deltaClass(n: number): string {
  if (n === 0) return 'text-fgSubtle';
  return n > 0 ? 'text-fg' : 'text-fgMuted';
}
function deltaCaret(n: number): string {
  if (n === 0) return '— ';
  return n > 0 ? '▲ ' : '▼ ';
}

export function Top30Creators({ rows }: { rows: CreatorMetricWindowRow[] }) {
  return (
    <section className="glass-base border border-borderGlass rounded-2xl overflow-hidden">
      <div className="p-5 border-b border-borderGlass">
        <span className="text-micro uppercase text-fgSubtle tracking-[0.04em]">
          Top Creators
        </span>
        <div className="text-caption text-fgMuted">
          Top 30 by follower growth · last 30 days
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="p-6 text-body text-fgMuted">
          No creators ranked yet — building history…
        </div>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="text-micro uppercase text-fgSubtle tracking-[0.04em]">
              <th className="font-normal px-4 py-2.5 w-10">#</th>
              <th className="font-normal px-4 py-2.5">Creator</th>
              <th className="font-normal px-4 py-2.5">Platform</th>
              <th className="font-normal px-4 py-2.5 text-right">Followers</th>
              <th className="font-normal px-4 py-2.5 text-right">Δ30D</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <CreatorRow key={row.creatorId} row={row} rank={i + 1} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CreatorRow({ row, rank }: { row: CreatorMetricWindowRow; rank: number }) {
  const pk = toPlatformKey(row.primaryPlatform);
  const name = row.displayName ?? '—';
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <tr className="border-t border-borderGlass hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-2.5 font-mono tabular-nums text-caption text-fgSubtle">
        {String(rank).padStart(2, '0')}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="size-7 rounded-full bg-white/[0.04] border border-borderGlass flex items-center justify-center overflow-hidden shrink-0">
            {row.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- external avatar, dims vary
              <img src={row.avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              <span className="text-caption text-fgMuted">{initial}</span>
            )}
          </span>
          {row.primaryHandle ? (
            <Link
              href={`/creators/${row.primaryHandle}`}
              className="text-body text-fg truncate hover:text-aurora-cta transition-colors"
            >
              {name}
            </Link>
          ) : (
            <span className="text-body text-fg truncate">{name}</span>
          )}
        </div>
      </td>
      <td className="px-4 py-2.5">
        {pk ? (
          <PlatformPill platform={pk} iconSize={12} className="!px-2 !py-1">
            {''}
          </PlatformPill>
        ) : (
          <span className="text-caption text-fgSubtle">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-body text-fg">
        {formatCompact(row.followers)}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-caption">
        {row.insufficient ? (
          <span className="text-fgSubtle">{BUILDING_HISTORY}</span>
        ) : (
          <span className={deltaClass(row.followersDelta)}>
            {deltaCaret(row.followersDelta)}
            {formatDelta(row.followersDelta)}
          </span>
        )}
      </td>
    </tr>
  );
}
