# Admin Per-Creator Daily KPI View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily KPI section (followers gained/day, views gained/day + cumulative, chart + table, 7/30/90-day range) to the admin creator page `/admin/creators/[id]`.

**Architecture:** One new read-only Postgres RPC `creator_daily_kpis` does the per-day math (carry-forward, deltas) server-side, mirroring the existing windowed RPCs. A thin TS wrapper maps it; a server-rendered section renders summary cards, two SVG charts, and a table. URL `?days=` drives the range.

**Tech Stack:** Next.js App Router (React 19, server components), Supabase Postgres RPC, Tailwind 3, inline SVG (no chart lib).

## Global Constraints

- pnpm only; lint runs from repo root.
- Brand yellow is `#F2E600` (SVG) / `brand` Tailwind token (classes). `--color-custom*` is deprecated — do not use.
- New RPC is **service-role only**: `revoke execute … from public, anon, authenticated`. The admin page calls it via `getSupabaseAdmin()`.
- Match existing patterns: metric math in SQL RPCs; thin TS wrappers return `[]` on error (logged); `force-dynamic` admin pages; `tabular-nums` for numbers; ▲/▼/— delta carets.
- Target DB: fresh Supabase project `icyzebmulhinwnifnmmx` (apply migration via Supabase MCP).
- rednote excluded from aggregation (matches every other RPC).

---

### Task 1: `creator_daily_kpis` RPC + SQL verify fixture

**Files:**

- Create: `supabase/migrations/20260630000000_creator_daily_kpis_rpc.sql`
- Create (test): `supabase/tests/creator_daily_kpis_verify.sql`
- Apply: via Supabase MCP `apply_migration` to project `icyzebmulhinwnifnmmx`

**Interfaces:**

- Produces: SQL function `public.creator_daily_kpis(p_creator_id uuid, p_days int default 30)` returning `(day date, followers_total bigint, followers_gained bigint, views_total bigint, views_gained bigint, insufficient boolean)`, one row per day for the last `p_days` days (p_days clamped 1..90).

- [ ] **Step 1: Write the verify fixture (the failing test)**

Create `supabase/tests/creator_daily_kpis_verify.sql`:

```sql
-- Verify creator_daily_kpis: carry-forward (gap day), MAX views (transient dip),
-- multi-profile aggregation, per-day deltas. Seeds, asserts, rolls back.
begin;

insert into public.creator (id, display_name)
values ('00000000-0000-0000-0000-0000000000c1', 'KPI Test Creator');

insert into public.profile (id, creator_id, platform, profile_url) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'instagram', 'https://instagram.com/kpitest1'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'tiktok',    'https://tiktok.com/@kpitest2');

-- Followers. P1 has a GAP on day-1 (carry-forward 110 expected). P2 daily.
insert into public.profile_snapshot (profile_id, captured_date, followers) values
  ('00000000-0000-0000-0000-0000000000a1', current_date - 3, 100),
  ('00000000-0000-0000-0000-0000000000a1', current_date - 2, 110),
  ('00000000-0000-0000-0000-0000000000a1', current_date,     130),
  ('00000000-0000-0000-0000-0000000000a2', current_date - 3, 200),
  ('00000000-0000-0000-0000-0000000000a2', current_date - 2, 205),
  ('00000000-0000-0000-0000-0000000000a2', current_date - 1, 210),
  ('00000000-0000-0000-0000-0000000000a2', current_date,     220);

-- Post views. Post A day-1 dips to 1400 (transient) -> MAX must keep 1500.
-- Post B has a gap on day-1 (carry-forward 700 expected).
insert into public.post_snapshot (profile_id, external_post_id, captured_date, views) values
  ('00000000-0000-0000-0000-0000000000a1', 'A', current_date - 3, 1000),
  ('00000000-0000-0000-0000-0000000000a1', 'A', current_date - 2, 1500),
  ('00000000-0000-0000-0000-0000000000a1', 'A', current_date - 1, 1400),
  ('00000000-0000-0000-0000-0000000000a1', 'A', current_date,     1600),
  ('00000000-0000-0000-0000-0000000000a2', 'B', current_date - 3, 500),
  ('00000000-0000-0000-0000-0000000000a2', 'B', current_date - 2, 700),
  ('00000000-0000-0000-0000-0000000000a2', 'B', current_date,     900);

do $$
declare r record;
begin
  -- day-2: followers 110+205=315 (Δ +15 from 300); views 1500+700=2200 (Δ +700 from 1500)
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c1', 3) where day = current_date - 2;
  assert r.followers_total  = 315, 'followers_total d-2 expected 315 got '|| coalesce(r.followers_total::text,'null');
  assert r.followers_gained = 15,  'followers_gained d-2 expected 15 got '|| coalesce(r.followers_gained::text,'null');
  assert r.views_gained     = 700, 'views_gained d-2 expected 700 got '|| coalesce(r.views_gained::text,'null');
  assert r.insufficient = false,   'd-2 should have a baseline';

  -- day-1: P1 followers carried 110 -> 110+210=320 (Δ +5); views MAX(A)=1500 + carry(B)=700 = 2200 (Δ 0)
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c1', 3) where day = current_date - 1;
  assert r.followers_total  = 320, 'followers_total d-1 expected 320 (carry P1=110) got '|| coalesce(r.followers_total::text,'null');
  assert r.followers_gained = 5,   'followers_gained d-1 expected 5';
  assert r.views_total      = 2200,'views_total d-1 expected 2200 (MAX ignores 1400, carry B=700)';
  assert r.views_gained     = 0,   'views_gained d-1 expected 0';

  -- day0: followers 130+220=350 (Δ +30); views 1600+900=2500 (Δ +300)
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c1', 3) where day = current_date;
  assert r.followers_gained = 30,  'followers_gained d0 expected 30';
  assert r.views_gained     = 300, 'views_gained d0 expected 300';

  raise notice 'creator_daily_kpis verify: ALL PASS';
end $$;

rollback;
```

- [ ] **Step 2: Run the fixture to confirm it fails (function missing)**

Run via MCP `execute_sql` (project `icyzebmulhinwnifnmmx`) with the file contents.
Expected: ERROR `function public.creator_daily_kpis(...) does not exist`.

- [ ] **Step 3: Write the migration (minimal implementation)**

Create `supabase/migrations/20260630000000_creator_daily_kpis_rpc.sql`:

```sql
-- Per-creator daily KPI series for the admin creator page.
-- One row per day for the last p_days (clamped 1..90): followers total + gained,
-- cumulative views total + gained, and an insufficient flag for the first day
-- with no prior baseline. Aggregated across the creator's profiles (rednote
-- excluded, matching the other RPCs). Followers carry forward across missed
-- scrape days; views use MAX per post (robust to a transient low re-scrape,
-- same reasoning as dashboard_view_totals_max_views).
--
-- Service-role only: a creator must never pull another creator's KPIs by id via
-- PostgREST. The admin page calls this through the service-role client.
create or replace function public.creator_daily_kpis(
  p_creator_id uuid,
  p_days int default 30
)
returns table (
  day date,
  followers_total bigint,
  followers_gained bigint,
  views_total bigint,
  views_gained bigint,
  insufficient boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select least(greatest(coalesce(p_days, 30), 1), 90) as n
  ),
  days as (
    select generate_series(
      current_date - (select n from bounds), current_date, interval '1 day'
    )::date as day
  ),
  prof as (
    select id from public.profile
    where creator_id = p_creator_id and platform <> 'rednote'
  ),
  foll as (
    select d.day,
      sum((
        select s.followers from public.profile_snapshot s
        where s.profile_id = pr.id and s.captured_date <= d.day
        order by s.captured_date desc limit 1
      ))::bigint as followers_total
    from days d cross join prof pr
    group by d.day
  ),
  posts as (
    select distinct profile_id, external_post_id
    from public.post_snapshot
    where profile_id in (select id from prof)
  ),
  vw as (
    select d.day,
      coalesce(sum((
        select max(ps.views) from public.post_snapshot ps
        where ps.profile_id = p.profile_id
          and ps.external_post_id = p.external_post_id
          and ps.captured_date <= d.day
      )), 0)::bigint as views_total
    from days d cross join posts p
    group by d.day
  ),
  merged as (
    select f.day, f.followers_total, v.views_total
    from foll f join vw v on v.day = f.day
  )
  select
    day,
    followers_total,
    (followers_total - lag(followers_total) over (order by day))::bigint as followers_gained,
    views_total,
    (views_total - lag(views_total) over (order by day))::bigint as views_gained,
    (lag(followers_total) over (order by day)) is null as insufficient
  from merged
  order by day
  offset 1;
$$;

revoke execute on function public.creator_daily_kpis(uuid, int) from public, anon, authenticated;
grant  execute on function public.creator_daily_kpis(uuid, int) to service_role;
```

- [ ] **Step 4: Apply the migration**

Apply via MCP `apply_migration` (name `creator_daily_kpis_rpc`, project `icyzebmulhinwnifnmmx`) with the migration body.

- [ ] **Step 5: Run the verify fixture — expect PASS**

Run the fixture body via MCP `execute_sql`. Expected: notice `creator_daily_kpis verify: ALL PASS`, no assertion error. (The `rollback` leaves no test data.)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260630000000_creator_daily_kpis_rpc.sql supabase/tests/creator_daily_kpis_verify.sql
git commit -m "feat(db): creator_daily_kpis RPC for admin daily KPI view"
```

---

### Task 2: TypeScript data layer

**Files:**

- Create: `apps/frontend/src/lib/daily-window.ts`
- Create: `apps/frontend/src/lib/metrics-daily.ts`

**Interfaces:**

- Consumes: SQL `creator_daily_kpis` (Task 1).
- Produces:
  - `parseDaysParam(params: { days?: string }): DaysOption` where `DaysOption = 7 | 30 | 90`; `DAYS_VALUES: readonly DaysOption[]`; `DAYS_LABEL: Record<DaysOption, string>`.
  - `getCreatorDailyKpis(creatorId: string, days: number, opts?: { client?: SupabaseClient }): Promise<CreatorDailyKpiRow[]>` with `CreatorDailyKpiRow = { day: string; followersTotal: number; followersGained: number; viewsTotal: number; viewsGained: number; insufficient: boolean }`.

- [ ] **Step 1: Create `daily-window.ts`**

```ts
/**
 * 7/30/90-day range selector for the admin creator KPI section. `?days=` URL
 * param; unknown/missing → 30. No runtime imports so it stays unit-testable.
 */
export type DaysOption = 7 | 30 | 90;

export const DAYS_VALUES: readonly DaysOption[] = [7, 30, 90];

export const DAYS_LABEL: Record<DaysOption, string> = {
  7: '7D',
  30: '30D',
  90: '90D',
};

/** Read + validate the ?days= query param. Unknown/missing → 30. */
export function parseDaysParam(params: { days?: string }): DaysOption {
  const n = Number(params.days);
  return (DAYS_VALUES as readonly number[]).includes(n)
    ? (n as DaysOption)
    : 30;
}
```

- [ ] **Step 2: Create `metrics-daily.ts`**

```ts
/**
 * Typed access to the creator_daily_kpis RPC. Thin pass-through (mirrors
 * metrics-windowed.ts): call the RPC, map rows, return [] on error (logged).
 *
 * The RPC is service-role only, so the admin caller MUST inject the service-role
 * client (getSupabaseAdmin()). The anon read client would get permission denied
 * and fall back to [].
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseRead } from './supabase-server';

export interface CreatorDailyKpiRow {
  /** ISO date (YYYY-MM-DD). */
  day: string;
  followersTotal: number;
  followersGained: number;
  viewsTotal: number;
  viewsGained: number;
  /** No prior-day baseline yet — render deltas as "—", not a spike. */
  insufficient: boolean;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getCreatorDailyKpis(
  creatorId: string,
  days: number,
  opts: { client?: SupabaseClient } = {},
): Promise<CreatorDailyKpiRow[]> {
  const sb = opts.client ?? getSupabaseRead();
  const { data, error } = await sb.rpc('creator_daily_kpis', {
    p_creator_id: creatorId,
    p_days: days,
  });
  if (error) {
    console.error('[metrics-daily] creator_daily_kpis', error);
    return [];
  }
  return (data ?? []).map(
    (r: Record<string, unknown>): CreatorDailyKpiRow => ({
      day: String(r.day),
      followersTotal: toNum(r.followers_total),
      followersGained: toNum(r.followers_gained),
      viewsTotal: toNum(r.views_total),
      viewsGained: toNum(r.views_gained),
      insufficient: Boolean(r.insufficient),
    }),
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: no new errors from these two files.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/daily-window.ts apps/frontend/src/lib/metrics-daily.ts
git commit -m "feat: typed wrapper + range param for creator daily KPIs"
```

---

### Task 3: `DailyBars` chart primitive

**Files:**

- Create: `apps/frontend/src/components/insights/daily-bars.tsx`

**Interfaces:**

- Produces: `<DailyBars values={number[]} labels?={string[]} ariaLabel={string} width?={number} height?={number} className?={string} />` — SVG bar chart, positive bars in `#F2E600`, negative bars below the zero baseline in a muted tone.

- [ ] **Step 1: Create `daily-bars.tsx`**

```tsx
'use client';

/**
 * Minimal SVG bar chart for daily-gained series. Zero baseline; negative values
 * (e.g. followers lost) draw below it in a muted tone. Brand-yellow positives.
 * Same visual language as Sparkline (fills width via preserveAspectRatio=none).
 */
import { useMemo } from 'react';
import clsx from 'clsx';

interface DailyBarsProps {
  values: number[];
  labels?: string[];
  width?: number;
  height?: number;
  ariaLabel?: string;
  className?: string;
}

export function DailyBars({
  values,
  width = 800,
  height = 200,
  ariaLabel,
  className,
}: DailyBarsProps) {
  const geo = useMemo(() => {
    if (!values.length) return null;
    const max = Math.max(0, ...values);
    const min = Math.min(0, ...values);
    const range = max - min || 1;
    const padX = 8;
    const padTop = 12;
    const padBottom = 12;
    const w = width - padX * 2;
    const h = height - padTop - padBottom;
    const zeroY = padTop + (max / range) * h;
    const slot = w / values.length;
    const barW = Math.max(1, slot * 0.62);
    const bars = values.map((v, i) => {
      const x = padX + i * slot + (slot - barW) / 2;
      const vy = padTop + ((max - v) / range) * h;
      const positive = v >= 0;
      const y = positive ? vy : zeroY;
      const barH = Math.max(1, Math.abs(vy - zeroY));
      return { x, y, barW, barH, positive };
    });
    return { bars, zeroY };
  }, [values, width, height]);

  if (!geo) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={clsx('w-full h-full block', className)}
      role="img"
      aria-label={ariaLabel}
    >
      <line
        x1="8"
        y1={geo.zeroY}
        x2={width - 8}
        y2={geo.zeroY}
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      {geo.bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width={b.barW}
          height={b.barH}
          fill={b.positive ? '#F2E600' : 'rgba(255,255,255,0.28)'}
        />
      ))}
    </svg>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/components/insights/daily-bars.tsx
git commit -m "feat: DailyBars SVG chart primitive"
```

---

### Task 4: KPI section + range tabs, wired into the creator page

**Files:**

- Create: `apps/frontend/src/app/(admin)/admin/creators/[id]/days-tabs.tsx`
- Create: `apps/frontend/src/app/(admin)/admin/creators/[id]/daily-kpis.tsx`
- Modify: `apps/frontend/src/app/(admin)/admin/creators/[id]/page.tsx`

**Interfaces:**

- Consumes: `getCreatorDailyKpis`, `CreatorDailyKpiRow`, `parseDaysParam`, `DAYS_VALUES`, `DAYS_LABEL`, `DaysOption` (Task 2); `DailyBars` (Task 3); existing `Sparkline`, `EmptyState`, `formatCompact`, `formatDelta`.
- Produces: `<DaysTabs creatorId={string} current={DaysOption} />`, `<DailyKpis creatorId={string} days={DaysOption} rows={CreatorDailyKpiRow[]} />`.

- [ ] **Step 1: Create `days-tabs.tsx`** (mirrors `me/window-tabs.tsx`)

```tsx
import Link from 'next/link';
import {
  DAYS_VALUES,
  DAYS_LABEL,
  type DaysOption,
} from '@gitroom/frontend/lib/daily-window';

export function DaysTabs({
  creatorId,
  current,
}: {
  creatorId: string;
  current: DaysOption;
}) {
  return (
    <nav className="flex flex-wrap items-center gap-2" aria-label="KPI range">
      {DAYS_VALUES.map((d) => {
        const active = d === current;
        return (
          <Link
            key={d}
            href={`/admin/creators/${creatorId}?days=${d}`}
            scroll={false}
            aria-current={active ? 'page' : undefined}
            className={`text-caption px-3 py-1.5 rounded-full border transition-colors ${
              active
                ? 'bg-brand/10 text-fg border-brand/20'
                : 'bg-white/[0.04] text-fgMuted border-white/10 hover:text-fg'
            }`}
          >
            {DAYS_LABEL[d]}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 2: Create `daily-kpis.tsx`** (server component)

```tsx
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
  const hasData = rows.some((r) => !r.insufficient);

  const followersNow = rows.length ? rows[rows.length - 1].followersTotal : 0;
  const viewsNow = rows.length ? rows[rows.length - 1].viewsTotal : 0;
  const followersGainedWindow = rows.reduce((a, r) => a + r.followersGained, 0);
  const viewsGainedWindow = rows.reduce((a, r) => a + r.viewsGained, 0);

  // Charts/table read newest-first for the table, but charts want chronological.
  const chrono = rows;
  const newestFirst = [...rows].reverse();

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
                values={chrono.map((r) => r.followersGained)}
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
                  values={chrono.map((r) => r.viewsGained)}
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
                        className={`px-4 py-2.5 text-right ${r.insufficient ? 'text-fgSubtle' : deltaClass(r.followersGained)}`}
                      >
                        {r.insufficient
                          ? '—'
                          : `${caret(r.followersGained)}${formatDelta(r.followersGained)}`}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {formatCompact(r.viewsTotal)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right ${r.insufficient ? 'text-fgSubtle' : deltaClass(r.viewsGained)}`}
                      >
                        {r.insufficient
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
```

- [ ] **Step 3: Wire into `page.tsx`**

Modify `apps/frontend/src/app/(admin)/admin/creators/[id]/page.tsx`:

Add imports near the existing ones:

```tsx
import { getCreatorDailyKpis } from '@gitroom/frontend/lib/metrics-daily';
import { parseDaysParam } from '@gitroom/frontend/lib/daily-window';
import { DailyKpis } from './daily-kpis';
```

Change the component signature to also accept `searchParams` and fetch KPIs. Replace the existing function signature + the `getAdminCreatorDetail` fetch block with:

```tsx
export default async function AdminCreatorEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');
  if (auth.role !== 'admin') redirect('/me');

  const { id } = await params;
  if (!isUuid(id)) notFound();

  const days = parseDaysParam(await searchParams);
  const admin = getSupabaseAdmin();
  const [detail, kpis] = await Promise.all([
    getAdminCreatorDetail(admin, id),
    getCreatorDailyKpis(id, days, { client: admin }),
  ]);
  if (!detail) notFound();
```

Then render the KPI section between the `<header>` and `<CreatorEditor>`:

```tsx
      </header>
      <DailyKpis creatorId={id} days={days} rows={kpis} />
      <CreatorEditor detail={detail} />
```

(Remove the now-duplicated standalone `getAdminCreatorDetail(getSupabaseAdmin(), id)` call — it's folded into the `Promise.all` above.)

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Run: `pnpm lint`
Expected: no new errors/warnings.

- [ ] **Step 5: Commit**

```bash
git add "apps/frontend/src/app/(admin)/admin/creators/[id]/days-tabs.tsx" "apps/frontend/src/app/(admin)/admin/creators/[id]/daily-kpis.tsx" "apps/frontend/src/app/(admin)/admin/creators/[id]/page.tsx"
git commit -m "feat: daily KPI section on admin creator page"
```

---

### Task 5: Verify in the running app

**Files:** none (verification only).

- [ ] **Step 1: Seed a little demo data** for one real creator id via MCP `execute_sql` (NOT rolled back) — a creator with 2 profiles and ~5 days of snapshots + a couple of posts, so the charts/table have something to show. (Use the same shape as the verify fixture but without `begin/rollback`, and a distinct id you can delete after.)

- [ ] **Step 2: Boot** the dev server (`preview_start` `frontend-turbo`, port 4200) and create an admin session, OR temporarily fetch the page server-side. Navigate to `/admin/creators/<seededId>?days=30`.

- [ ] **Step 3: Verify** via `preview_snapshot` / `preview_screenshot`: summary cards show followers + views-gained; both bar charts render; cumulative line renders; table rows reconcile with the seeded numbers; switching `?days=7` changes the range.

- [ ] **Step 4: Check** `preview_console_logs` (level error) and `preview_logs` (error) — no `[metrics-daily]` errors, no React errors.

- [ ] **Step 5: Clean up** the seeded demo rows via `execute_sql` (delete the creator — cascades to profiles/snapshots).

---

## Self-Review

- **Spec coverage:** RPC + semantics (Task 1) ✓; TS wrapper + range param (Task 2) ✓; bars chart (Task 3) ✓; cards + both charts + table + tabs + empty state, wired into page (Task 4) ✓; SQL verify fixture (Task 1 Step 1) ✓; manual app verification (Task 5) ✓. Carry-forward + MAX + rednote-exclude + service-role-only all encoded in Task 1. Followers = gained + total (no cumulative line); views = gained bars + cumulative line — matches locked decisions.
- **Placeholder scan:** none — every step has concrete SQL/TSX/commands.
- **Type consistency:** `CreatorDailyKpiRow` fields (`followersTotal/followersGained/viewsTotal/viewsGained/insufficient/day`) are produced in Task 2 and consumed identically in Task 4. `DaysOption`/`parseDaysParam`/`DAYS_VALUES`/`DAYS_LABEL` consistent across Tasks 2 & 4. `DailyBars` prop shape consistent between Task 3 and Task 4. RPC column names match the TS mapper keys.
- **Assumptions to confirm at execution:** `formatCompact`/`formatDelta` exist in `lib/creator-metrics` (used by `creator-stats.tsx` — confirmed); `EmptyState` accepts `icon/title/description/children` (confirmed from `me/page.tsx` usage); `brand` Tailwind token exists (used by `window-tabs.tsx` — confirmed).
