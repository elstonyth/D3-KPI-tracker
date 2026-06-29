'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { GlassCard } from '../ui/glass-card';
import { ImageWithFallback } from '../ui/image-with-fallback';
import {
  PLATFORM_ICONS,
  PLATFORM_LABELS,
  type PlatformKey,
} from '../ui/platform-icons';
import {
  formatShowcase,
  percentFormatter,
  handleToSlug,
  demoCreatorRows,
  placeholderViewsTrend,
  placeholderDeltaPct,
  type PlatformFilter,
} from './showcase-data';
import { VIEW_PERIODS, type ViewPeriod } from '@gitroom/frontend/lib/view-periods';
import { ShowcaseNumber } from './showcase-number';
import type { LiveCreatorRow } from '@gitroom/frontend/lib/queries';

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

/** Sort key for the Top Creators list (re-rank by views or by followers). */
type CreatorSort = 'views' | 'followers';

const BREAKDOWN_PLATFORMS: PlatformKey[] = ['facebook', 'instagram', 'tiktok', 'douyin'];
// Dashboard is a summary — show the top slice; the leaderboard has the full list.
const TOP_CREATORS_LIMIT = 10;

/** Human-readable label for the active platform filter ("All platforms" or the platform name). */
function filterLabel(filter: PlatformFilter): string {
  return filter === 'all' ? 'All platforms' : PLATFORM_LABELS[filter];
}

// Windowed-views cell resolution contract (DashboardViewTotals in
// lib/metrics-windowed.ts): the RPC emits no row for a key/window with no
// posts — with live windowed data a missing CELL means 0. The cumulative
// fallback applies ONLY when no windowed data was loaded at all (demo mode, or
// the RPC errored and returned empty maps). Falling back per-cell would render
// lifetime views under a "last 24 hours" caption. NOTE: the resolution is
// inlined at each use site (`live ? cell ?? 0 : cumulative`) rather than
// extracted into a helper — passing prop-derived values to a function makes
// the React Compiler assume the props graph may be mutated, bailing it out of
// the whole component (react-hooks/preserve-manual-memoization). Covered by
// dashboard-showcase.test.tsx instead.

interface DisplayRow {
  key: string;
  name: string;
  avatarUrl: string | null;
  slug: string | null;
  followers: number;
  totalViews: number;
}

/** Resolve creators for the active filter; per-platform slot when filtered. */
function resolveRows(creators: LiveCreatorRow[], filter: PlatformFilter): DisplayRow[] {
  if (filter === 'all') {
    return creators.map((c) => ({
      key: c.creatorId,
      name: c.displayName,
      avatarUrl: c.avatarUrl,
      slug: c.primaryHandle ? handleToSlug(c.primaryHandle) : null,
      followers: c.followers,
      totalViews: c.totalViews,
    }));
  }
  return creators.flatMap((c) => {
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
      },
    ];
  });
}

export interface DashboardShowcaseProps {
  creators?: LiveCreatorRow[] | null;
  /**
   * Real "Total Views" history (oldest→newest) for the sparkline. OPTIONAL —
   * when omitted, a realistic deterministic placeholder is shown.
   * TODO(backend): pass from the page once snapshot aggregation lands.
   */
  viewsTrend?: number[];
  /**
   * Real period-over-period deltas (fractions, e.g. 0.063 = +6.3%). OPTIONAL —
   * placeholders fill in per-metric when omitted. See showcase-data.ts.
   */
  deltas?: { views?: number; followers?: number; engagement?: number };
  /**
   * Σ total views of posts PUBLISHED in each window, per platform-key →
   * window-key, from getDashboardViewTotalsWindowed. OPTIONAL — when omitted or
   * empty (demo mode / RPC error) the hero falls back to the cumulative
   * lifetime total. When populated, a missing cell means "no posts in that
   * window" and renders as 0 — never the cumulative fallback, which would
   * mislabel lifetime views as a short period.
   */
  viewsByWindow?: Record<string, Record<string, number>>;
  /**
   * Per-creator windowed views: creatorId → platform-key | 'all' → window-key →
   * Σ views of that creator's posts published in the window. Drives the Top
   * Creators ranking per period. OPTIONAL — absent/empty ⇒ ranking falls back
   * to lifetime totals; when populated, a creator/window with no posts ranks
   * with 0, never with its lifetime total.
   */
  creatorViewsByWindow?: Record<string, Record<string, Record<string, number>>>;
}

/**
 * Public dashboard showcase: platform filter, headline totals with a sparkline,
 * top-creators table, and per-platform breakdown. Falls back to synthetic demo
 * rows until live creator data exists.
 */
export function DashboardShowcase({
  creators,
  viewsTrend: propViewsTrend,
  deltas: propDeltas,
  viewsByWindow,
  creatorViewsByWindow,
}: DashboardShowcaseProps = {}) {
  const [filter, setFilter] = useState<PlatformFilter>('all');
  const [activeViewFilter, setActiveViewFilter] = useState<ViewPeriod>('lifetime');
  const [creatorSort, setCreatorSort] = useState<CreatorSort>('views');
  const isLive = !!(creators && creators.length > 0);
  const baseCreators = useMemo(
    () => (isLive ? creators! : demoCreatorRows()),
    [isLive, creators],
  );

  const rows = useMemo(() => resolveRows(baseCreators, filter), [baseCreators, filter]);
  const totalFollowers = useMemo(() => rows.reduce((s, r) => s + r.followers, 0), [rows]);
  const totalViews = useMemo(() => rows.reduce((s, r) => s + r.totalViews, 0), [rows]);
  const totalEngagement = useMemo(
    () =>
      filter === 'all'
        ? baseCreators.reduce((s, c) => s + c.totalEngagement, 0)
        : baseCreators.reduce(
            (s, c) => s + (c.platforms.find((p) => p.platform === filter)?.totalEngagement ?? 0),
            0,
          ),
    [baseCreators, filter],
  );

  // Sparkline series + per-metric deltas. Real values arrive via props; until the
  // backend aggregates snapshot history we fall back to realistic placeholders.
  const viewsTrend = useMemo(
    () =>
      propViewsTrend && propViewsTrend.length > 1
        ? propViewsTrend
        : placeholderViewsTrend(totalViews),
    [propViewsTrend, totalViews],
  );
  const viewsDelta = useMemo(() => {
    if (typeof propDeltas?.views === 'number') return propDeltas.views;
    const first = viewsTrend[0] || 1;
    return (viewsTrend[viewsTrend.length - 1] - first) / first;
  }, [propDeltas, viewsTrend]);
  const followersDelta = propDeltas?.followers ?? placeholderDeltaPct(totalFollowers);
  const engagementDelta = propDeltas?.engagement ?? placeholderDeltaPct(totalEngagement);

  // Windowed view matrices: live (populated) vs absent/empty (demo mode or RPC
  // error). When live, a MISSING cell means "no posts in that window" → 0; the
  // cumulative fallback applies only when the whole matrix is absent. Inlined
  // (not isWindowedLive()) so the React Compiler doesn't have to assume the
  // call mutates the prop, which would bail it out of the whole component.
  const winLive = !!viewsByWindow && Object.keys(viewsByWindow).length > 0;
  const creatorWinLive =
    !!creatorViewsByWindow && Object.keys(creatorViewsByWindow).length > 0;

  // Top creators by views for the active period (dashboard summary — capped).
  // Each row's views are overridden with its windowed value (per creator, for
  // the active platform filter) and re-ranked, so the list tracks the period
  // pill. A creator with no posts in the window ranks with 0 — falling back to
  // lifetime would let them outrank real in-window activity. Followers are
  // left untouched (current count, no period analog).
  const topCreators = useMemo(
    () =>
      rows
        .map((r) => ({
          ...r,
          totalViews: creatorWinLive
            ? creatorViewsByWindow?.[r.key]?.[filter]?.[activeViewFilter] ?? 0
            : r.totalViews,
        }))
        .sort((a, b) =>
          creatorSort === 'followers'
            ? b.followers - a.followers
            : b.totalViews - a.totalViews,
        )
        .slice(0, TOP_CREATORS_LIMIT),
    [rows, creatorWinLive, creatorViewsByWindow, filter, activeViewFilter, creatorSort],
  );
  const hasMore = rows.length > TOP_CREATORS_LIMIT;

  const breakdown = useMemo(() => {
    const map = new Map<PlatformKey, { followers: number; totalViews: number }>();
    for (const c of baseCreators) {
      for (const slot of c.platforms) {
        const b = map.get(slot.platform) ?? { followers: 0, totalViews: 0 };
        b.followers += slot.followers;
        b.totalViews += slot.totalViews;
        map.set(slot.platform, b);
      }
    }
    return BREAKDOWN_PLATFORMS.map((platform) => ({
      platform,
      followers: map.get(platform)?.followers ?? 0,
      totalViews: map.get(platform)?.totalViews ?? 0,
    }));
  }, [baseCreators]);

  const activeViewCaption =
    VIEW_PERIODS.find((p) => p.value === activeViewFilter)?.caption ??
    'all-time, across tracked posts';

  // Real Σ views for the active platform + period. Cumulative fallback ONLY
  // when no windowed data was loaded (demo mode / RPC error); with live data a
  // missing cell is a real 0 ("nothing posted in this window") — the old `??
  // cumulative` here rendered lifetime views under a "last 24 hours" caption.
  // `lifetime` from the matrix equals the cumulative total, so they reconcile.
  const heroViews = winLive
    ? viewsByWindow?.[filter]?.[activeViewFilter] ?? 0
    : totalViews;

  // The ▲% delta chip + sparkline are lifetime-cumulative placeholders, not
  // period-aware — show them only on Lifetime so a windowed headline (e.g. 0 on
  // 1D) isn't paired with a contradictory upward "growth" trend. See Finding F3.
  const showViewsTrend = activeViewFilter === 'lifetime';

  // Per-platform views for the active period (followers stay current — a
  // follower count has no post-publish-date analog). Falls back to lifetime
  // per-platform views only when no windowed data is supplied; a platform with
  // no posts in the window shows 0.
  const breakdownWindowed = useMemo(
    () =>
      breakdown.map((b) => ({
        ...b,
        totalViews: winLive
          ? viewsByWindow?.[b.platform]?.[activeViewFilter] ?? 0
          : b.totalViews,
      })),
    [breakdown, winLive, viewsByWindow, activeViewFilter],
  );

  return (
    <div className="flex flex-col gap-5">
      <PlatformTabBar value={filter} onChange={setFilter} />

      {/* Stats — frameless bento: Total Views hero (left) with a sparkline filling the
          open space; Followers + Engagement stacked right. Each carries a trend chip. */}
      <div className="grid grid-cols-1 gap-8 py-2 sm:grid-cols-12 sm:gap-x-10 sm:gap-y-7">
        <div className="flex flex-col justify-center gap-3 sm:col-span-8 sm:row-span-2">
          <div className="flex items-center gap-3">
            <span className="text-label text-fgMuted">Total Views</span>
            {showViewsTrend && <DeltaChip value={viewsDelta} />}
          </div>

          {/* Time-period filter — UI-only for now (see activeViewFilter TODO). */}
          <div
            role="tablist"
            aria-label="Total Views time period"
            className="flex flex-wrap items-center gap-1"
          >
            {VIEW_PERIODS.map((period) => {
              const isActive = period.value === activeViewFilter;
              return (
                <button
                  key={period.value}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveViewFilter(period.value)}
                  className={clsx(
                    'h-7 px-2.5 rounded-lg text-caption whitespace-nowrap',
                    'transition-colors duration-150 ease-out',
                    isActive
                      ? 'bg-glass-subtle text-fg border border-borderGlassStrong'
                      : 'border border-transparent text-fgMuted hover:text-fg hover:bg-white/[0.04]'
                  )}
                >
                  {period.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-6">
            <div className="text-[clamp(48px,6.5vw,84px)] leading-[0.98] tracking-[-0.035em] font-semibold text-fg tabular-nums">
              {formatShowcase(heroViews)}
            </div>
            {showViewsTrend && (
              <Sparkline
                data={viewsTrend}
                className="hidden h-16 flex-1 self-center text-white/30 sm:block"
              />
            )}
          </div>
          <p className="text-caption text-fgSubtle tabular-nums">
            {`${filterLabel(filter)} · ${activeViewCaption}`}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:col-span-4 sm:items-end sm:text-right">
          <span className="text-label text-fgMuted">Total Followers</span>
          <div className="flex items-baseline gap-2.5">
            <div className="text-[clamp(28px,3vw,38px)] leading-none tracking-[-0.025em] font-semibold text-fg tabular-nums">
              {formatShowcase(totalFollowers)}
            </div>
            <DeltaChip value={followersDelta} />
          </div>
          <p className="text-caption text-fgSubtle tabular-nums">
            {`${filterLabel(filter)} · tracked`}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:col-span-4 sm:items-end sm:text-right">
          <span className="text-label text-fgMuted">Total Engagement</span>
          <div className="flex items-baseline gap-2.5">
            <div className="text-[clamp(28px,3vw,38px)] leading-none tracking-[-0.025em] font-semibold text-fg tabular-nums">
              {formatShowcase(totalEngagement)}
            </div>
            <DeltaChip value={engagementDelta} />
          </div>
          <p className="text-caption text-fgSubtle">{'likes, comments & shares'}</p>
        </div>
      </div>

      {/* Content row — top creators + platform breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-4 items-start">
        <TopCreatorsCard
          rows={topCreators}
          filter={filter}
          hasMore={hasMore}
          sort={creatorSort}
          onSortChange={setCreatorSort}
        />
        <PlatformBreakdownCard activeFilter={filter} onSelect={setFilter} rows={breakdownWindowed} />
      </div>

      {!isLive && (
        <p className="text-caption text-fgSubtle text-center pt-2 tabular-nums">
          Showcase preview · synthetic data. Live numbers replace this the moment the scraper switches on.
        </p>
      )}
    </div>
  );
}

// --- Tab bar --------------------------------------------------------------

/** Platform filter tab bar (All + one tab per platform) for the dashboard showcase. */
function PlatformTabBar({
  value,
  onChange,
}: {
  value: PlatformFilter;
  onChange: (next: PlatformFilter) => void;
}) {
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
                : 'border border-transparent text-fgMuted hover:text-fg hover:bg-white/[0.04]'
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

// --- Sparkline + trend chip -----------------------------------------------

/** Axis-less SVG sparkline; stretches to fill its box. Color via `currentColor`. */
function Sparkline({ data, className }: { data: number[]; className?: string }) {
  if (!data || data.length < 2) return null;
  const w = 120;
  const h = 36;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - 1 - ((v - min) / range) * (h - 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${points.join(' L')}`;
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#sparkFill)" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Period-over-period change. Direction via caret, not color (DESIGN.md: no red/green). */
function DeltaChip({ value, period = 'recent' }: { value: number; period?: string }) {
  const up = value >= 0;
  const pct = percentFormatter.format(Math.abs(value));
  return (
    <span
      className="inline-flex items-center gap-1 text-caption tabular-nums"
      title={`${up ? 'Up' : 'Down'} ${pct} · ${period} trend`}
    >
      <svg
        width="8"
        height="8"
        viewBox="0 0 10 10"
        aria-hidden="true"
        className={clsx('text-fg', !up && 'rotate-180')}
      >
        <path d="M5 1 L9.33 8.5 L0.67 8.5 Z" fill="currentColor" />
      </svg>
      <span className="text-fg">{pct}</span>
      <span className="text-fgSubtle">· {period}</span>
    </span>
  );
}

// --- Top creators ---------------------------------------------------------

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

/** Card listing the top creators by views for the active filter, with a link to the full leaderboard. */
function TopCreatorsCard({
  rows,
  filter,
  hasMore,
  sort,
  onSortChange,
}: {
  rows: DisplayRow[];
  filter: PlatformFilter;
  hasMore: boolean;
  sort: CreatorSort;
  onSortChange: (next: CreatorSort) => void;
}) {
  return (
    <GlassCard variant="base" padding="md" radius="2xl" className="flex flex-col">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-4">
        <div className="flex flex-col gap-1">
          <span className="text-label text-fg font-medium">Top Creators</span>
          <span className="text-body-sm text-fgMuted">
            {filterLabel(filter)} · by {sort === 'followers' ? 'followers' : 'views'}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div role="tablist" aria-label="Sort creators" className="flex items-center gap-1">
            {(['views', 'followers'] as const).map((value) => {
              const isActive = value === sort;
              return (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => onSortChange(value)}
                  className={clsx(
                    'h-7 px-2.5 rounded-lg text-caption whitespace-nowrap',
                    'transition-colors duration-150 ease-out',
                    isActive
                      ? 'bg-glass-subtle text-fg border border-borderGlassStrong'
                      : 'border border-transparent text-fgMuted hover:text-fg hover:bg-white/[0.04]'
                  )}
                >
                  {value === 'followers' ? 'Followers' : 'Views'}
                </button>
              );
            })}
          </div>
          <Link
            href="/leaderboard"
            className="text-caption text-fgMuted hover:text-fg transition-colors whitespace-nowrap"
          >
            See all →
          </Link>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="grid place-items-center text-body-sm text-fgMuted py-12">
          No creators on this platform yet.
        </div>
      ) : (
        <>
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
          {hasMore && (
            <Link
              href="/leaderboard"
              className="mt-3 text-center text-caption text-fgMuted hover:text-fg transition-colors"
            >
              View the full leaderboard →
            </Link>
          )}
        </>
      )}
    </GlassCard>
  );
}

/** One ranked creator row (rank · name · views · followers); links to the creator page when a slug exists. */
function CreatorRow({ row, rank }: { row: DisplayRow; rank: number }) {
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
        <span className="truncate text-body text-fg font-medium">{row.name}</span>
      </span>
      <span className="text-right font-mono tabular-nums text-body text-fg">
        <ShowcaseNumber value={row.totalViews} />
      </span>
      <span className="hidden sm:block text-right sm:pl-6 font-mono tabular-nums text-body-sm text-fgMuted">
        <ShowcaseNumber value={row.followers} />
      </span>
    </>
  );
  const rowClass = clsx(
    GRID,
    'px-2 min-h-[52px] rounded-lg transition-colors duration-150 ease-out border-b border-borderGlass last:border-b-0',
    isWinner && 'bg-brand/[0.06]',
  );
  return (
    <li>
      {row.slug ? (
        <Link
          href={`/creators/${row.slug}`}
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

// --- Platform breakdown ---------------------------------------------------

interface BreakdownRow {
  platform: PlatformKey;
  followers: number;
  totalViews: number;
}

/** Per-platform views/followers breakdown with a proportional bar; selecting a platform sets the active filter. */
function PlatformBreakdownCard({
  activeFilter,
  onSelect,
  rows,
}: {
  activeFilter: PlatformFilter;
  onSelect: (filter: PlatformFilter) => void;
  rows: BreakdownRow[];
}) {
  const max = Math.max(1, ...rows.map((p) => p.totalViews));
  return (
    <GlassCard variant="base" padding="md" radius="2xl" className="flex flex-col">
      <div className="flex flex-col gap-1 mb-4">
        <span className="text-label text-fg font-medium">Platform Breakdown</span>
        <span className="text-body-sm text-fgMuted">Views + followers by platform</span>
      </div>

      <ul className="flex flex-col gap-2.5">
        {rows.map((row) => {
          const Icon = PLATFORM_ICONS[row.platform];
          const widthPct = (row.totalViews / max) * 100;
          const isFocused = activeFilter === row.platform;
          const isEmpty = row.followers === 0 && row.totalViews === 0;
          return (
            <li key={row.platform}>
              <button
                type="button"
                onClick={() => onSelect(row.platform)}
                className={clsx(
                  'w-full text-left rounded-xl border px-3 py-2.5 transition-colors duration-150 ease-out',
                  isFocused
                    ? 'bg-customColor16 border-borderGlassStrong'
                    : 'bg-transparent border-borderGlass hover:border-borderGlassStrong hover:bg-white/[0.025]',
                  isEmpty && 'opacity-50'
                )}
                aria-pressed={isFocused}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="inline-flex items-center justify-center size-7 rounded-md bg-customColor16 border border-borderGlass text-fg shrink-0">
                      <Icon size={14} />
                    </span>
                    <span className="text-body-sm text-fg truncate">
                      {PLATFORM_LABELS[row.platform]}
                    </span>
                  </div>
                  <span className="text-body-sm font-mono tabular-nums text-fg">
                    {isEmpty ? '—' : `${formatShowcase(row.totalViews)} views`}
                  </span>
                </div>

                <div className="h-[3px] bg-white/[0.04] rounded-full overflow-hidden">
                  <div
                    className={clsx(
                      'h-full transition-[width] duration-200 ease-out',
                      isFocused ? 'bg-brand' : 'bg-white/30'
                    )}
                    style={{ width: `${widthPct.toFixed(2)}%` }}
                  />
                </div>

                <div className="flex items-center justify-end mt-1.5 text-caption text-fgMuted font-mono tabular-nums">
                  <span className="text-fgMuted">
                    {isEmpty ? 'Not yet tracked' : `${formatShowcase(row.followers)} followers`}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </GlassCard>
  );
}
