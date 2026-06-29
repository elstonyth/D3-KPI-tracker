'use client';

import { useState } from 'react';
import Image from 'next/image';
import clsx from 'clsx';
import { GlassCard } from '../ui/glass-card';
import { EmptyState } from '../ui/empty-state';
import { Button } from '../ui/button';
import { PLATFORM_ICONS, type PlatformKey } from '../ui/platform-icons';
import { compactFormatter } from '../dashboard-showcase/showcase-data';
import { buildPostUrl, postInteractions } from '../../lib/queries';
import type { TopContentRow } from '../../lib/metrics-windowed';

function toPlatformKey(platform: string): PlatformKey {
  return platform === 'rednote' ? 'xiaohongshu' : (platform as PlatformKey);
}

export interface ViewLeaderboardProps {
  rows: TopContentRow[];
  title?: string;
  subtitle?: string;
  /** Which metric to surface on each card. */
  metric?: 'views' | 'interactions';
}

const PAGE_SIZE = 12;

export function ViewLeaderboard({
  rows,
  title = 'Top Content',
  subtitle = 'Top posts by views',
  metric = 'views',
}: ViewLeaderboardProps) {
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  // Clamp in case `rows` shrank since the last render (keeps page in range).
  const current = Math.min(page, totalPages - 1);
  const start = current * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  return (
    <GlassCard variant="base" padding="md" radius="2xl" className="flex flex-col">
      <div className="flex flex-col gap-1 mb-5">
        <span className="text-label text-fg font-medium">{title}</span>
        <span className="text-body-sm text-fgMuted">{subtitle}</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState size="sm" title="No content ranked yet — building history…" />
      ) : (
        <>
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
            {pageRows.map((row, i) => {
              const rank = start + i + 1;
              return (
                <ContentCard
                  key={`${row.externalPostId}-${rank}`}
                  row={row}
                  rank={rank}
                  metric={metric}
                />
              );
            })}
          </ul>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-borderGlass pt-4">
              <span className="text-caption text-fgSubtle tabular-nums">
                {`${start + 1}–${start + pageRows.length} of ${rows.length}`}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={current === 0}
                  aria-label="Previous page"
                >
                  Prev
                </Button>
                <span className="text-caption text-fgMuted tabular-nums min-w-[64px] text-center">
                  {`Page ${current + 1} / ${totalPages}`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={current >= totalPages - 1}
                  aria-label="Next page"
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </GlassCard>
  );
}

function ContentCard({
  row,
  rank,
  metric,
}: {
  row: TopContentRow;
  rank: number;
  metric: 'views' | 'interactions';
}) {
  const platformKey = toPlatformKey(row.platform);
  const Icon = PLATFORM_ICONS[platformKey];
  const isWinner = rank === 1;
  const href = buildPostUrl(platformKey, {}, row.externalPostId, row.handle);
  const value =
    metric === 'views' ? row.currentViews : postInteractions(row);
  const unit = metric === 'views' ? 'views' : 'interactions';

  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="group block relative aspect-[9/16] rounded-xl overflow-hidden bg-customColor1 border border-borderGlass hover:border-borderGlassStrong transition-colors outline-none focus-visible:ring-1 focus-visible:ring-brand-500"
      >
        {row.thumbnailUrl ? (
          <Image
            src={row.thumbnailUrl}
            alt={row.captionExcerpt ?? 'Post thumbnail'}
            fill
            sizes="(max-width: 640px) 50vw, (max-width: 1280px) 25vw, 16vw"
            unoptimized
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-fgSubtle">
            <Icon size={28} />
          </div>
        )}

        <span
          className={clsx(
            'absolute top-2 left-2 size-7 rounded-full flex items-center justify-center text-caption font-mono tabular-nums',
            isWinner ? 'bg-brand-500 text-brand-darker font-semibold' : 'bg-black/60 text-fg',
          )}
        >
          {String(rank).padStart(2, '0')}
        </span>
        <span className="absolute top-2 right-2 size-7 rounded-full bg-black/60 flex items-center justify-center text-fg">
          <Icon size={13} />
        </span>

        <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 via-black/45 to-transparent">
          <div className="text-fg font-mono tabular-nums text-heading leading-tight">
            {compactFormatter.format(value)}
          </div>
          <div className="text-caption text-fgMuted">{unit}</div>
          <div className="text-caption text-fgSubtle truncate mt-0.5">
            {row.creatorName ?? row.handle ?? ''}
          </div>
          {row.alsoOn && row.alsoOn.length > 0 && (
            <div className="flex items-center gap-1 mt-1 text-fgSubtle">
              <span className="text-micro">also on</span>
              {row.alsoOn.map((p) => {
                const AlsoIcon = PLATFORM_ICONS[toPlatformKey(p)];
                return AlsoIcon ? <AlsoIcon key={p} size={11} /> : null;
              })}
            </div>
          )}
        </div>
      </a>
    </li>
  );
}
