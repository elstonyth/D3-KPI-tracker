# Phase 1 — Public Pages Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/dashboard` and `/leaderboard` lead with Views (fed by Phase 0 RPCs), strip engagement from all public surfaces, and add a Top-20 content thumbnail grid — with a shared "Building history…" state on every windowed value.

**Architecture:** Server Components fetch `getCreatorMetricsWindowed` / `getTopContentWindowed` (Phase 0, already merged) and pass typed rows into the existing client showcases. No new SQL, no new query layer. One shared formatting helper decides "Building history…" vs a number. Demo fallback preserved for the pre-launch empty-DB case.

**Tech Stack:** Next.js App Router (Server + Client Components), React 19, Tailwind 3, jest-via-nx. Brand token `brand-500` (#F2E600) for rank/winner accents (DESIGN.md — scarce use). Compact numbers via existing `compactFormatter`.

---

## Pre-flight context (read before starting)

- **Phase 0 is merged.** `apps/frontend/src/lib/metrics-windowed.ts` exports `MetricWindow`, `CreatorMetricWindowRow`, `TopContentRow`, `getCreatorMetricsWindowed(window, opts?)`, `getTopContentWindowed(window, opts?)`. All numbers are deltas; `insufficient: boolean` flags young data; `thumbnailUrl` is already proxied.
- **Spec:** `docs/superpowers/specs/2026-05-30-phase1-public-pages-design.md`.
- **Current data reality:** prod has ~1 snapshot day, so live windowed values are `insufficient=true` right now → expect "Building history…" to dominate. That is correct, not a bug.
- **Demo fallback** lives in `showcase-data.ts` (`METRICS`, `TOP_CREATORS`, `summarize`, etc.) and fires when live arrays are empty. Keep it working.
- **Run from repo root:** `pnpm typecheck`, `pnpm lint`, `pnpm --filter ./apps/frontend exec jest`. Never add `eslint-disable`.
- **Branch:** `feat/phase1-public-pages` (already created off origin/main).

## File Structure

- **Create** `apps/frontend/src/lib/format-metric.ts` — `BUILDING_HISTORY` constant + `formatWindowedValue(insufficient, value, formatter)` helper. One responsibility: the build-history-vs-number decision, so the string lives in one place.
- **Create** `apps/frontend/src/lib/format-metric.test.ts` — jest unit test for the helper.
- **Modify** `apps/frontend/src/lib/queries.ts` — export `buildPostUrl` (currently module-private at ~line 710). Additive, no behavior change.
- **Modify** `apps/frontend/src/app/(public)/dashboard/page.tsx` — fetch 30d + lifetime windowed metrics, pass down.
- **Modify** `apps/frontend/src/components/dashboard-showcase/dashboard-showcase.tsx` — Views hero, Lifetime Views tile, Top-Creators-by-views, remove engagement.
- **Modify** `apps/frontend/src/components/dashboard-showcase/showcase-data.ts` — demo Views numbers; stop reading engagement on the dashboard path.
- **Modify** `apps/frontend/src/app/(public)/leaderboard/page.tsx` — fetch 30d metrics + top-20 content, pass down.
- **Modify** `apps/frontend/src/components/leaderboard-showcase/leaderboard-showcase.tsx` — strip engagement, two-board layout, Follower table with Views 30D column.
- **Create** `apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx` — Top-20 content thumbnail grid.

---

### Task 1: Shared "Building history…" formatter (TDD)

**Files:**
- Create: `apps/frontend/src/lib/format-metric.ts`
- Test: `apps/frontend/src/lib/format-metric.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/lib/format-metric.test.ts`:

```ts
import { BUILDING_HISTORY, formatWindowedValue } from './format-metric';

const fmt = (n: number) => `#${n}`;

describe('formatWindowedValue', () => {
  it('returns the building-history sentinel when insufficient', () => {
    expect(formatWindowedValue(true, 1234, fmt)).toBe(BUILDING_HISTORY);
  });
  it('formats the value when sufficient', () => {
    expect(formatWindowedValue(false, 1234, fmt)).toBe('#1234');
  });
  it('formats 0 (not building-history) when sufficient', () => {
    expect(formatWindowedValue(false, 0, fmt)).toBe('#0');
  });
  it('treats a null value as building-history even if not flagged', () => {
    expect(formatWindowedValue(false, null, fmt)).toBe(BUILDING_HISTORY);
  });
});
```

- [ ] **Step 2: Run it RED**

Run: `pnpm --filter ./apps/frontend exec jest src/lib/format-metric.test.ts`
Expected: FAIL — cannot find module './format-metric'.

- [ ] **Step 3: Implement**

Create `apps/frontend/src/lib/format-metric.ts`:

```ts
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
```

- [ ] **Step 4: Run it GREEN**

Run: `pnpm --filter ./apps/frontend exec jest src/lib/format-metric.test.ts`
Expected: PASS — 4/4.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/format-metric.ts apps/frontend/src/lib/format-metric.test.ts
git commit -m "feat(format): shared Building-history helper for windowed metrics (Phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Export buildPostUrl from queries.ts

**Files:**
- Modify: `apps/frontend/src/lib/queries.ts` (~line 710)

The View Leaderboard needs the post-permalink builder. It already exists but is module-private. Export it — additive, no behavior change.

- [ ] **Step 1: Add the export keyword**

In `apps/frontend/src/lib/queries.ts`, change the declaration:

```ts
function buildPostUrl(
```
to:
```ts
export function buildPostUrl(
```

(Leave the body and all existing call sites unchanged.)

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/lib/queries.ts
git commit -m "refactor(queries): export buildPostUrl for reuse in Phase 1 view grid

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: View Leaderboard component (Top-20 content grid)

**Files:**
- Create: `apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx`

A presentational client component: takes `TopContentRow[]`, renders a responsive thumbnail grid linking out to each post. No data fetching here.

- [ ] **Step 1: Create the component**

Create `apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx`:

```tsx
'use client';

import clsx from 'clsx';
import { GlassCard } from '../ui/glass-card';
import { EmptyState } from '../ui/empty-state';
import { PLATFORM_ICONS, type PlatformKey } from '../ui/platform-icons';
import { compactFormatter } from '../dashboard-showcase/showcase-data';
import { buildPostUrl } from '@gitroom/frontend/lib/queries';
import type { TopContentRow } from '@gitroom/frontend/lib/metrics-windowed';

// DB stores 'rednote'; the icon set keys it as 'xiaohongshu'.
function toPlatformKey(platform: string): PlatformKey {
  return platform === 'rednote' ? 'xiaohongshu' : (platform as PlatformKey);
}

export interface ViewLeaderboardProps {
  rows: TopContentRow[];
}

export function ViewLeaderboard({ rows }: ViewLeaderboardProps) {
  return (
    <GlassCard variant="base" padding="lg" radius="2xl" className="flex flex-col">
      <div className="flex flex-col gap-1 mb-6">
        <span className="text-micro uppercase text-fgSubtle tracking-[0.04em]">
          Top Content
        </span>
        <span className="text-caption text-fgMuted">
          Top 20 posts by views · last 30 days
        </span>
      </div>

      {rows.length === 0 ? (
        <EmptyState size="sm" title="No content ranked yet — building history…" />
      ) : (
        <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {rows.map((row, i) => (
            <ContentCard key={`${row.externalPostId}-${i}`} row={row} rank={i + 1} />
          ))}
        </ul>
      )}
    </GlassCard>
  );
}

function ContentCard({ row, rank }: { row: TopContentRow; rank: number }) {
  const platformKey = toPlatformKey(row.platform);
  const Icon = PLATFORM_ICONS[platformKey];
  const isWinner = rank === 1;
  const href = buildPostUrl(platformKey, {}, row.externalPostId, row.handle);

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
            sizes="(max-width: 640px) 50vw, (max-width: 1280px) 25vw, 20vw"
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

        <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/80 to-transparent">
          <div className="text-fg font-mono tabular-nums text-body-sm">
            {compactFormatter.format(row.viewsGained)} views
          </div>
          <div className="text-caption text-fgMuted truncate">
            {row.creatorName ?? row.handle ?? ''}
          </div>
        </div>
      </a>
    </li>
  );
}
```

NOTE on the thumbnail: the project rule (CLAUDE.md) forbids `eslint-disable-next-line` — do NOT suppress `@next/next/no-img-element`. Use `next/image` with `fill` + `unoptimized` instead. The src is a same-origin proxied path (`/api/proxy-image?...`), so next/image's local loader handles it without `remotePatterns`; `unoptimized` skips a redundant optimize hop since the bytes are already proxied. (Some older repo files still carry the raw-`<img>` + disable pattern; leave those pre-existing ones alone, but new code must use next/image.)

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm typecheck` then `pnpm lint`
Expected: both PASS. If `compactFormatter` import path is wrong, fix to match `showcase-data.ts`'s actual export. If `GlassCard`/`EmptyState`/`PLATFORM_ICONS` props mismatch, align to their real signatures (GlassCard: variant/padding/radius; EmptyState: size/title).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx
git commit -m "feat(leaderboard): Top-20 content thumbnail grid (Phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Rebuild /leaderboard — two boards, no engagement

**Files:**
- Modify: `apps/frontend/src/app/(public)/leaderboard/page.tsx`
- Modify: `apps/frontend/src/components/leaderboard-showcase/leaderboard-showcase.tsx`

- [ ] **Step 1: Update the server page to fetch windowed data**

Replace the body of `apps/frontend/src/app/(public)/leaderboard/page.tsx`'s data section so it fetches the windowed metrics + top content and passes them down. Keep `revalidate = 3600`, metadata, and the header copy (drop the word "engagement" from the description line). Concretely, fetch in parallel:

```ts
import {
  getCreatorMetricsWindowed,
  getTopContentWindowed,
  type CreatorMetricWindowRow,
  type TopContentRow,
} from '@gitroom/frontend/lib/metrics-windowed';

// inside the component:
const [creators, topContent] = await Promise.all([
  getCreatorMetricsWindowed('30d').catch((e) => {
    console.error('[leaderboard] creator metrics', e);
    return [] as CreatorMetricWindowRow[];
  }),
  getTopContentWindowed('30d', 20).catch((e) => {
    console.error('[leaderboard] top content', e);
    return [] as TopContentRow[];
  }),
]);
```

Pass `liveCreators={creators}` and `topContent={topContent}` to `<LeaderboardShowcase />`. Update the header `<p>` that currently says "...followers, engagement, reach, and growth..." to "...followers, views, and growth..." (remove engagement word). Remove the "growth and engagement insights fill in after 14 days" sub-note or reword to "views fill in as snapshots accrue".

- [ ] **Step 2: Rewrite the showcase — strip engagement, add two boards**

In `apps/frontend/src/components/leaderboard-showcase/leaderboard-showcase.tsx`:

1. Change props to accept the new shapes:

```ts
import type { CreatorMetricWindowRow, TopContentRow } from '@gitroom/frontend/lib/metrics-windowed';
import { ViewLeaderboard } from './view-leaderboard';
import { formatWindowedValue } from '@gitroom/frontend/lib/format-metric';

export interface LeaderboardShowcaseProps {
  liveCreators?: CreatorMetricWindowRow[] | null;
  topContent?: TopContentRow[] | null;
}
```

2. Replace the `SORTS` array with only two keys:

```ts
const SORTS: SortDef[] = [
  { value: 'followers', label: 'Followers' },
  { value: 'viewsGained', label: 'Views 30D' },
];
```
and change `LeaderboardSort` usage to `'followers' | 'viewsGained'` locally (do not touch the shared `showcase-data.ts` `LeaderboardSort` type in this task — define a local union here).

3. `applySort` sorts by the chosen numeric field (`followers` or `viewsGained`) desc, re-ranks.

4. Summary tiles: keep "Total Followers" + "Total Views" (sum `viewsGained`), DROP "Total Engagement" and "Avg Engagement Rate". The two remaining tiles can sit in a `grid-cols-2`.

5. Table columns become: `# · Creator · Platform · Followers · Views 30D`. The Views 30D cell uses `formatWindowedValue(row.insufficient, row.viewsGained, compactFormatter.format)`. Remove the `Eng. Rate` and `Engagement` `<th>`/`<td>`.

6. Below the follower table card, render the second board:

```tsx
<ViewLeaderboard rows={topContent ?? []} />
```

7. The platform tab bar stays at the top and filters the follower table (client state). The View Leaderboard shows global top-20 (not platform-filtered) in this phase — note that in a one-line caption; per-platform content filtering is out of scope.

8. Demo fallback: when `liveCreators` is empty, keep showing the synthetic rows but mapped to the new column set (followers + a demo viewsGained). Reuse existing `TOP_CREATORS` (it has `totalViews`); map `viewsGained = totalViews`, `insufficient = false` for demo rows.

- [ ] **Step 3: Typecheck + lint + jest**

Run: `pnpm typecheck`, `pnpm lint`, `pnpm --filter ./apps/frontend exec jest`
Expected: all PASS. No reference to `engagementRate`/`totalEngagement` remains in this file (grep to confirm).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/app/\(public\)/leaderboard/page.tsx apps/frontend/src/components/leaderboard-showcase/leaderboard-showcase.tsx
git commit -m "feat(leaderboard): two boards (followers + Top-20 views), strip engagement (Phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Rebuild /dashboard — Views hero, Lifetime Views, views-ranked Top Creators

**Files:**
- Modify: `apps/frontend/src/app/(public)/dashboard/page.tsx`
- Modify: `apps/frontend/src/components/dashboard-showcase/dashboard-showcase.tsx`
- Modify: `apps/frontend/src/components/dashboard-showcase/showcase-data.ts`

- [ ] **Step 1: Server page fetches 30d + lifetime windowed metrics**

In `apps/frontend/src/app/(public)/dashboard/page.tsx`, fetch in parallel and pass down:

```ts
import {
  getCreatorMetricsWindowed,
  type CreatorMetricWindowRow,
} from '@gitroom/frontend/lib/metrics-windowed';

const [metrics30d, metricsLifetime] = await Promise.all([
  getCreatorMetricsWindowed('30d').catch((e) => { console.error('[dashboard] 30d', e); return [] as CreatorMetricWindowRow[]; }),
  getCreatorMetricsWindowed('lifetime').catch((e) => { console.error('[dashboard] lifetime', e); return [] as CreatorMetricWindowRow[]; }),
]);
```

Keep the existing `getPlatformBreakdown()` fetch. Pass `metrics30d`, `metricsLifetime`, and the existing `livePlatformBreakdown` to `<DashboardShowcase />`. Update the page's intro `<p>` to drop "engagement" (say "followers, views, and growth").

- [ ] **Step 2: Showcase — Views hero + Lifetime Views tile + views ranking**

In `apps/frontend/src/components/dashboard-showcase/dashboard-showcase.tsx`:

1. New props:

```ts
import type { CreatorMetricWindowRow, LivePlatformBreakdown } from ...; // breakdown type stays from queries
import { formatWindowedValue, BUILDING_HISTORY } from '@gitroom/frontend/lib/format-metric';

export interface DashboardShowcaseProps {
  metrics30d?: CreatorMetricWindowRow[] | null;
  metricsLifetime?: CreatorMetricWindowRow[] | null;
  livePlatformBreakdown?: LivePlatformBreakdown[] | null;
}
```

2. Derived totals (filtered by the platform tab):
   - `totalViews30d = Σ viewsGained` over filtered `metrics30d`.
   - `totalViewsLifetime = Σ viewsGained` over filtered `metricsLifetime`.
   - `allInsufficient30d = filtered.length > 0 && filtered.every(r => r.insufficient)`.
   - Top creators = `metrics30d` sorted by `viewsGained` desc.
   - Platform filter on `CreatorMetricWindowRow.primaryPlatform`.

3. **Hero card:** title "Total Views · 30D". Value = `formatWindowedValue(allInsufficient30d, totalViews30d, compactFormatter.format)`. Subtitle "views gained · last 30 days". Keep the sparkline but label it "Preview" (demo series — no time-series RPC yet).

4. **Replace the "Avg Engagement Rate" MetricCard** with "Lifetime Total Views": value = `formatWindowedValue(false, totalViewsLifetime, compactFormatter.format)` (lifetime is rarely insufficient; pass the row-derived flag if you prefer). Note line = `${activeCreators} creators`.

5. **Top Creators card:** rank by `viewsGained`; right-hand number per row = `formatWindowedValue(row.insufficient, row.viewsGained, compactFormatter.format)`; header caption "Ranked by 30D views · {platform}".

6. **PlatformBreakdownCard:** remove the "Eng {pct}" line. Replace with nothing (cleaner) — keep the followers bar + 30d follower delta line that already exists. (Platform-level views aggregation is out of scope; do not fabricate it.)

7. Delete `computeLiveMetrics`' engagement fields and any now-unused imports (`percentFormatter` if no longer used). Remove orphaned engagement code your changes created.

8. Demo fallback: when `metrics30d` is empty, show synthetic Views numbers from `showcase-data.ts` (Task step 3 below), not engagement.

- [ ] **Step 3: showcase-data.ts — demo Views numbers**

In `apps/frontend/src/components/dashboard-showcase/showcase-data.ts`, add synthetic per-filter demo values the dashboard can show when live data is empty:

```ts
// Demo "Views" numbers for the pre-launch fallback (parallel to METRICS).
export const DEMO_VIEWS: Record<PlatformFilter, { views30d: number; viewsLifetime: number }> = {
  all:        { views30d: 4_812_000, viewsLifetime: 58_400_000 },
  instagram:  { views30d: 1_640_000, viewsLifetime: 19_200_000 },
  tiktok:     { views30d: 1_520_000, viewsLifetime: 17_800_000 },
  douyin:     { views30d:   910_000, viewsLifetime: 11_300_000 },
  facebook:   { views30d:   180_000, viewsLifetime:  4_100_000 },
  xiaohongshu:{ views30d:   562_000, viewsLifetime:  6_000_000 },
};
```

Do NOT delete `engagementRate` from `CreatorRow`/`MetricView` here (leaderboard demo + `/me` still reference it; removed in a later cleanup). This task only adds.

- [ ] **Step 4: Typecheck + lint + jest**

Run: `pnpm typecheck`, `pnpm lint`, `pnpm --filter ./apps/frontend exec jest`
Expected: all PASS. Grep this file set to confirm no engagement value is rendered on the dashboard path.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/app/\(public\)/dashboard/page.tsx apps/frontend/src/components/dashboard-showcase/dashboard-showcase.tsx apps/frontend/src/components/dashboard-showcase/showcase-data.ts
git commit -m "feat(dashboard): Total Views 30D hero + Lifetime Views + views-ranked Top Creators (Phase 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Visual verification (empty-data + demo states)

**Files:** none (verification only).

Because prod data is currently all-`insufficient`, the live pages will read "Building history…" heavily. Confirm that looks intentional, and that the demo fallback (empty DB) shows Views numbers.

- [ ] **Step 1: Build the app**

Run: `pnpm --filter ./apps/frontend run build`
Expected: build succeeds, no type errors, no missing-import failures on `/dashboard` or `/leaderboard`.

- [ ] **Step 2: Use the project's run/verify skill to view both pages**

Launch the app (use the `run` skill or `pnpm dev`) and load `/dashboard` and `/leaderboard`. Confirm:
- `/dashboard`: hero = "Total Views · 30D" (value or "Building history…"), second tile = "Lifetime Total Views", Top Creators captioned "Ranked by 30D views", NO engagement tile/word.
- `/leaderboard`: two boards — Follower table (cols: # / Creator / Platform / Followers / Views 30D) and a Top-20 content thumbnail grid. NO "Eng. Rate"/"Engagement" anywhere.
- Grep the rendered routes' source for "engagement" → only allowed in untouched demo type fields, never in public output.

- [ ] **Step 3: Record result**

Note pass/fail per checklist item in the PR description. No commit.

---

## Self-Review

**Spec coverage** (against `2026-05-30-phase1-public-pages-design.md`):
- Dashboard metric swaps (Views 30D hero, Lifetime Views tile) → Task 5. ✓
- Dashboard Top Creators by views → Task 5 step 2.6. ✓
- Leaderboard strip engagement → Task 4 step 2.2/2.4/2.5. ✓
- Leaderboard two boards + Top-20 content grid → Tasks 3 + 4. ✓
- Building-history on every windowed value → Task 1 helper, used in Tasks 4 & 5. ✓
- Demo fallback preserved → Task 4 step 2.8, Task 5 step 3. ✓
- buildPostUrl reuse (no duplication) → Task 2. ✓
- No new SQL → confirmed (only metrics-windowed consumed). ✓

**Placeholder scan:** No TBD/TODO. Every code step shows full code or an exact edit. The "plan decides cleaner option" notes from the spec are resolved to concrete choices here (e.g. platform breakdown: drop the Eng line, keep followers).

**Type consistency:** `CreatorMetricWindowRow` / `TopContentRow` field names (`viewsGained`, `insufficient`, `thumbnailUrl`, `externalPostId`, `creatorName`, `handle`, `primaryPlatform`) match Phase 0's exports exactly. `formatWindowedValue(insufficient, value, formatter)` signature is identical across Tasks 1, 4, 5. `buildPostUrl(platformKey, {}, externalPostId, handle)` matches its real signature in queries.ts.

**Scope:** Two routes + one shared helper + one new component. No admin, no /me, no auth. `engagementRate` deliberately NOT deleted from shared types (later cleanup). Within a single plan.
