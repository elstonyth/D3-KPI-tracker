'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { GlassCard } from '../ui/glass-card';
import { PLATFORM_ICONS, PLATFORM_LABELS } from '../ui/platform-icons';
import { ImageWithFallback } from '../ui/image-with-fallback';
import {
  exactFormatter,
  formatShowcase,
  handleToSlug,
  demoCreatorRows,
  type PlatformFilter,
} from '../dashboard-showcase/showcase-data';
import { ShowcaseNumber } from '../dashboard-showcase/showcase-number';
import type { LiveCreatorRow } from '@gitroom/frontend/lib/queries';
import type { TopContentRow } from '@gitroom/frontend/lib/metrics-windowed';
import {
  VIEW_PERIODS,
  type ViewPeriod,
} from '@gitroom/frontend/lib/view-periods';
import { ViewLeaderboard } from './view-leaderboard';

interface TabDef {
  value: PlatformFilter;
  label: string;
}

const TABS: TabDef[] = [
  { value: 'all', label: 'All Platforms' },
  { value: 'facebook', label: PLATFORM_LABELS.facebook },
  { value: 'instagram', label: PLATFORM_LABELS.instagram },
  { value: 'tiktok', label: PLATFORM_LABELS.tiktok },
  { value: 'douyin', label: PLATFORM_LABELS.douyin },
  // xiaohongshu (RedNote) archived — hidden from the platform filter.
];

/** Human-readable label for the active platform filter ("All platforms" or the platform name). */
function filterLabel(filter: PlatformFilter): string {
  return filter === 'all' ? 'All platforms' : PLATFORM_LABELS[filter];
}

/** A creator resolved for the active platform filter (combined totals). */
interface LbRow {
  key: string;
  name: string;
  avatarUrl: string | null;
  slug: string | null;
  followers: number;
  totalViews: number;
  totalEngagement: number;
}

/** Resolve creators for the active filter into ranked rows with combined totals, sorted by views (desc). */
function resolveRows(
  creators: LiveCreatorRow[],
  filter: PlatformFilter,
): LbRow[] {
  const rows: LbRow[] =
    filter === 'all'
      ? creators.map((c) => ({
          key: c.creatorId,
          name: c.displayName,
          avatarUrl: c.avatarUrl,
          slug: c.primaryHandle ? handleToSlug(c.primaryHandle) : null,
          followers: c.followers,
          totalViews: c.totalViews,
          totalEngagement: c.totalEngagement,
        }))
      : creators.flatMap((c) => {
          const slot = c.platforms.find((p) => p.platform === filter);
          if (!slot) return [];
          return [
            {
              key: c.creatorId,
              name: c.displayName,
              avatarUrl: c.avatarUrl, // avatar is creator-level, not per-platform
              slug: slot.handle ? handleToSlug(slot.handle) : null,
              followers: slot.followers,
              totalViews: slot.totalViews,
              totalEngagement: slot.totalEngagement,
            },
          ];
        });
  // Top-views ranking.
  return rows.sort((a, b) => b.totalViews - a.totalViews);
}

/** Top content ranked by views and by interactions, per time window. */
export type TopContentByWindow = Record<
  ViewPeriod,
  { byViews: TopContentRow[]; byInteractions: TopContentRow[] }
>;

export interface LeaderboardShowcaseProps {
  liveCreators?: LiveCreatorRow[] | null;
  topContentByWindow?: TopContentByWindow | null;
}

/**
 * Public leaderboard showcase: summary tiles, top creators by views, and
 * top content by views and by interactions. Falls back to synthetic demo rows
 * until live creator data exists.
 */
export function LeaderboardShowcase({
  liveCreators,
  topContentByWindow,
}: LeaderboardShowcaseProps = {}) {
  const [filter, setFilter] = useState<PlatformFilter>('all');
  const [contentPeriod, setContentPeriod] = useState<ViewPeriod>('lifetime');
  const isLive = !!(liveCreators && liveCreators.length > 0);
  const baseCreators = useMemo(
    () => (isLive ? liveCreators! : demoCreatorRows()),
    [isLive, liveCreators],
  );

  const rows = useMemo(
    () => resolveRows(baseCreators, filter),
    [baseCreators, filter],
  );

  const stats = useMemo(() => {
    let followers = 0;
    let views = 0;
    let engagement = 0;
    for (const r of rows) {
      followers += r.followers;
      views += r.totalViews;
      engagement += r.totalEngagement;
    }
    return { creators: rows.length, followers, views, engagement };
  }, [rows]);

  const content = topContentByWindow?.[contentPeriod];

  return (
    <div className="flex flex-col gap-5">
      <PlatformTabBar value={filter} onChange={setFilter} />

      {/* Summary — readable labels. Stacks on mobile so full-digit million
          totals (e.g. 30,053,805) aren't clipped in a cramped 3-up row. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <SummaryStat
          label="Total Followers"
          value={formatShowcase(stats.followers)}
          note={`${exactFormatter.format(stats.creators)} creator${stats.creators === 1 ? '' : 's'}`}
        />
        <SummaryStat
          label="Total Views"
          value={formatShowcase(stats.views)}
          note="across recent posts"
        />
        <SummaryStat
          label="Total Engagement"
          value={formatShowcase(stats.engagement)}
          note="likes, comments & shares"
        />
      </div>

      {/* Ranking 1 — Top creators by followers */}
      <RankSection
        title="Top Creators"
        subtitle={`${filterLabel(filter)} · by views`}
      >
        {rows.length === 0 ? (
          <EmptyRow label="No creators on this platform yet." />
        ) : (
          <CreatorTable rows={rows} />
        )}
      </RankSection>

      {/* Time filter governing both content rankings (posts published in window) */}
      <ContentPeriodBar value={contentPeriod} onChange={setContentPeriod} />

      {/* Ranking 2 — Top content by views */}
      <ViewLeaderboard
        rows={content?.byViews ?? []}
        title="Top Content"
        subtitle="Most-viewed posts"
        metric="views"
      />

      {/* Ranking 3 — Top content by interactions */}
      <ViewLeaderboard
        rows={content?.byInteractions ?? []}
        title="Top Engaging Content"
        subtitle="Most likes, comments & shares"
        metric="interactions"
      />

      {!isLive && (
        <p className="text-caption text-fgSubtle text-center pt-2 tabular-nums">
          Showcase preview · synthetic data. Live numbers replace this the
          moment the scraper switches on.
        </p>
      )}
    </div>
  );
}

// --- Tab bar --------------------------------------------------------------

interface PlatformTabBarProps {
  value: PlatformFilter;
  onChange: (next: PlatformFilter) => void;
}

/** Platform filter tab bar (All + one tab per platform) for the leaderboard showcase. */
function PlatformTabBar({ value, onChange }: PlatformTabBarProps) {
  return (
    <div
      role="tablist"
      aria-label="Platform filter"
      className="border border-borderGlass rounded-2xl bg-customColor1 p-1.5 flex items-center gap-1 overflow-x-auto"
    >
      {TABS.map((tab) => {
        const isActive = tab.value === value;
        const Icon = tab.value === 'all' ? null : PLATFORM_ICONS[tab.value];
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.value)}
            className={clsx(
              'inline-flex items-center gap-2 h-9 px-3.5 rounded-xl text-label whitespace-nowrap',
              'transition-colors duration-150 ease-out',
              isActive
                ? 'bg-customColor16 text-fg border border-borderGlassStrong'
                : 'border border-transparent text-fgMuted hover:text-fg hover:bg-white/[0.04]',
            )}
          >
            {Icon ? <Icon size={14} /> : null}
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// --- Content time-period bar ----------------------------------------------

/** Shared time filter for both content rankings. Window = posts PUBLISHED in it. */
function ContentPeriodBar({
  value,
  onChange,
}: {
  value: ViewPeriod;
  onChange: (next: ViewPeriod) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-caption text-fgSubtle">Posted in</span>
      <div
        role="tablist"
        aria-label="Content time period"
        className="flex flex-wrap items-center gap-1"
      >
        {VIEW_PERIODS.map((period) => {
          const isActive = period.value === value;
          return (
            <button
              key={period.value}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onChange(period.value)}
              className={clsx(
                'h-7 px-2.5 rounded-lg text-caption whitespace-nowrap',
                'transition-colors duration-150 ease-out',
                isActive
                  ? 'bg-glass-subtle text-fg border border-borderGlassStrong'
                  : 'border border-transparent text-fgMuted hover:text-fg hover:bg-white/[0.04]',
              )}
            >
              {period.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// --- Summary stat (compact metric tile) -----------------------------------

/** Compact metric tile (label · value · note) used in the leaderboard summary row. */
function SummaryStat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <GlassCard
      variant="base"
      padding="md"
      radius="2xl"
      className="flex flex-col gap-1.5"
    >
      <span className="text-label text-fgMuted">{label}</span>
      <div className="text-[clamp(22px,2.4vw,30px)] leading-[1.05] tracking-[-0.02em] font-semibold text-fg tabular-nums">
        {value}
      </div>
      <p className="text-caption text-fgSubtle tabular-nums">{note}</p>
    </GlassCard>
  );
}

// --- Ranking section wrapper ----------------------------------------------

/** Titled card wrapper for a ranking section (title · subtitle · content). */
function RankSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <GlassCard
      variant="base"
      padding="md"
      radius="2xl"
      className="flex flex-col"
    >
      <div className="flex flex-col gap-1 mb-4">
        <span className="text-label text-fg font-medium">{title}</span>
        <span className="text-body-sm text-fgMuted">{subtitle}</span>
      </div>
      {children}
    </GlassCard>
  );
}

/** Empty-state placeholder shown when a ranking section has no rows. */
function EmptyRow({ label }: { label: string }) {
  return (
    <div className="grid place-items-center text-body-sm text-fgMuted py-12">
      {label}
    </div>
  );
}

// --- Creator table (rank · avatar+name · followers · views) ---------------

// Phones (< sm / 640px) show only rank · name · Views so the creator name is
// never truncated by the secondary Followers column; Followers returns at sm+.
// The avatar additionally drops on ultra-narrow phones (≤374px) via `tiny:`.
// Followers uses a `minmax(5rem, auto)` track so every Views value shares one
// right edge — each row is its own grid, so a plain `auto` Followers width (which
// varies per row: "31K" vs "150.1K") would jitter the Views column's right edge
// and misalign the numbers. The 5rem floor fits the "Followers" header label and
// every current follower count (≤150.1K), so they align; the `auto` ceiling lets a
// rare 10M+ full-digit value grow the track instead of overflowing into Views.
const GRID =
  'grid grid-cols-[32px_minmax(0,1fr)_auto] sm:grid-cols-[32px_minmax(0,1fr)_auto_minmax(5rem,auto)] gap-3 items-center';

/** Ranked creator table (rank · avatar+name · views · followers) for the active filter. */
function CreatorTable({ rows }: { rows: LbRow[] }) {
  return (
    <div className="flex flex-col">
      <div
        aria-hidden
        className={`${GRID} px-2 pb-2 text-micro uppercase tracking-[0.04em] text-fgSubtle border-b border-borderGlass`}
      >
        <span>#</span>
        <span>Creator</span>
        <span className="text-right">Views</span>
        <span className="hidden sm:block text-right sm:pl-6">Followers</span>
      </div>
      <ul>
        {rows.map((row, i) => (
          <CreatorRow key={row.key} row={row} rank={i + 1} />
        ))}
      </ul>
    </div>
  );
}

/** One ranked creator row (rank · name · views · followers); links to the creator page when a slug exists. */
function CreatorRow({ row, rank }: { row: LbRow; rank: number }) {
  const isWinner = rank === 1;
  const initial = row.name.trim().charAt(0).toUpperCase() || '?';
  const cells = (
    <>
      <span
        className={clsx(
          'font-mono tabular-nums text-body-sm',
          isWinner ? 'text-brand font-semibold' : 'text-fgSubtle',
        )}
      >
        {String(rank).padStart(2, '0')}
      </span>
      <span className="flex items-center gap-3 min-w-0">
        <span className="size-8 shrink-0 rounded-full bg-customColor1 border border-borderGlass grid tiny:hidden place-items-center overflow-hidden text-caption text-fgMuted">
          <ImageWithFallback
            src={row.avatarUrl}
            alt=""
            className="size-full object-cover"
            fallback={initial}
          />
        </span>
        <span className="truncate text-body text-fg font-medium">
          {row.name}
        </span>
      </span>
      <span className="text-right font-mono tabular-nums text-body text-fg">
        <ShowcaseNumber value={row.totalViews} exact />
      </span>
      <span className="hidden sm:block text-right sm:pl-6 font-mono tabular-nums text-body-sm text-fgMuted">
        <ShowcaseNumber value={row.followers} />
      </span>
    </>
  );
  const rowClass = clsx(
    GRID,
    'px-2 h-14 rounded-lg transition-colors duration-150 ease-out border-b border-borderGlass last:border-b-0',
    isWinner && 'bg-brand/[0.06]',
  );
  return (
    <li>
      {row.slug ? (
        <Link
          href={`/creators/${row.slug}`}
          aria-label={`View ${row.name} profile`}
          className={`${rowClass} hover:bg-white/[0.03] focus-visible:bg-white/[0.05] outline-none`}
        >
          {cells}
        </Link>
      ) : (
        <div className={rowClass}>{cells}</div>
      )}
    </li>
  );
}
