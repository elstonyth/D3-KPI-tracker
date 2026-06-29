# Phase 1 — Public Pages Redesign (Views-over-Engagement)

**Date:** 2026-05-30
**Status:** Approved design (from the brainstorm overview), ready for implementation plan.
**Parent:** `2026-05-30-views-over-engagement-overview.md`
**Depends on:** Phase 0 (merged — `creator_metrics_windowed`, `top_content_windowed`, `lib/metrics-windowed.ts`). **Blocks:** nothing (Phases 2/3 independent).

## Goal

Make the public surfaces lead with **Views** instead of Engagement, fed by the Phase 0 windowed-metrics RPCs. Two routes change: `/dashboard` and `/leaderboard`. The home page (`/`) "Top Creators" bento re-sorts by views. Engagement disappears from every public surface.

Success criteria (verifiable):
- `/dashboard` hero shows **Total Views · 30D** (views gained), the second metric tile shows **Lifetime Total Views**, and "Top Creators" is ranked by 30D views.
- `/leaderboard` shows **two** boards: a Follower Leaderboard (table) and a View Leaderboard (Top-20 content thumbnail grid). No "Eng. Rate" / "Engagement" column or tile anywhere public.
- Every windowed number reads the `insufficient` flag and renders **"Building history…"** instead of a value when true.
- Demo-data fallback still works when the DB is empty (pre-launch safety).
- `pnpm --filter ./apps/frontend exec jest`, `pnpm typecheck`, `pnpm lint` all clean.

## Data — already built (Phase 0), consumed here

- `getCreatorMetricsWindowed(window, opts?)` → `CreatorMetricWindowRow[]` (followers, followersDelta, viewsGained, engagement, postCount, insufficient, primaryPlatform, displayName, creatorId, avatarUrl).
- `getTopContentWindowed(window, opts?)` → `TopContentRow[]` (externalPostId, creatorId, creatorName, platform, handle, captionExcerpt, thumbnailUrl [already proxied], viewsGained, currentViews, likes/comments/shares, postedAt).
- No new SQL. No new query files. Phase 1 is wiring + presentation only.

A small permalink helper is needed (post URL from platform + id + handle): the logic already exists as `buildPostUrl` inside `queries.ts` but is not exported. Export it (additive, non-breaking) and reuse — do NOT duplicate.

## Route 1 — `/dashboard`

Files: `apps/frontend/src/app/(public)/dashboard/page.tsx`, `apps/frontend/src/components/dashboard-showcase/dashboard-showcase.tsx`, `apps/frontend/src/components/dashboard-showcase/showcase-data.ts`.

**Server page:** fetch `getCreatorMetricsWindowed('30d')` + `getCreatorMetricsWindowed('lifetime')` in parallel (alongside the existing platform breakdown). Pass to the showcase. Keep the demo fallback: when the live arrays are empty, render the existing synthetic `METRICS`/`TOP_CREATORS`.

**Showcase changes (`dashboard-showcase.tsx`):**
- **Hero card** "Net Follower Growth · 30d" → **"Total Views · 30D"**. Value = Σ `viewsGained` over the filtered creators (30D). Subtitle "views gained · last 30 days". Sparkline stays demo (labeled "Preview") — no time-series RPC yet.
- **Metric tile** "Avg Engagement Rate" → **"Lifetime Total Views"**. Value = Σ `viewsGained` from the `'lifetime'` fetch. Note line = creator count.
- **Top Creators bento:** rank by `viewsGained` (30D) desc, not followers. Header caption → "Ranked by 30D views · {platform}". Each row's right-hand number = `viewsGained` (compact), not followers.
- **Building-history:** if every in-scope creator is `insufficient`, the hero + lifetime tile render **"Building history…"** with a sub-note "needs up to 30 days of snapshots". Per-row: if a creator is `insufficient`, its views cell shows "—" with a tooltip.
- **Engagement removal:** delete the engagement tile, the `engagementRate` references in `computeLiveMetrics`, and the per-platform "Eng" line in `PlatformBreakdownCard` (replace with 30D views per platform, or drop the line — plan decides the cleaner of the two).

**`showcase-data.ts`:** the demo types (`MetricView`, `CreatorRow`) keep their fields for the fallback, but the dashboard no longer reads `engagementRate`. Add demo `viewsGained30d` / `viewsLifetime` numbers so the synthetic fallback shows sensible Views numbers instead of engagement. Do not delete `engagementRate` from the type yet (leaderboard demo + creator `/me` may still reference it; remove in a later cleanup once all readers are gone — surgical).

**Wireframe:** unchanged `BentoGrid` 12-col layout. Hero `colSpan=8 rowSpan=2`, two metric tiles `colSpan=4`, Top Creators `colSpan=7 rowSpan=2`, platform breakdown `colSpan=5 rowSpan=2`. Only labels/values/sort change — not the grid.

## Route 2 — `/leaderboard`

Files: `apps/frontend/src/app/(public)/leaderboard/page.tsx`, `apps/frontend/src/components/leaderboard-showcase/leaderboard-showcase.tsx`, new `apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx`.

**Server page:** fetch `getCreatorMetricsWindowed('30d')` + `getTopContentWindowed('30d', 20)` in parallel. Pass both to the showcase.

**Strip engagement:** remove `engagementRate` + `totalEngagement` from the `SORTS` array, the `SummaryStat` tiles ("Avg Engagement Rate" → "Total Views 30D"), and the `Eng. Rate` + `Engagement` table columns. Sort enum becomes `followers | views`.

**Board 1 — Follower Leaderboard** (existing table, trimmed):
- Columns: `# · Creator · Platform · Followers · Views 30D`.
- Sort toggle: **Followers** / **Views 30D** (client-side, same `applySort` pattern).
- `insufficient` creators show "—" in the Views 30D cell.

**Board 2 — View Leaderboard — Top 20 content** (NEW `view-leaderboard.tsx`):
- Heading "Top content by views · last 30 days".
- **Wireframe: responsive CSS Grid of thumbnail cards.** `grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4`. Each card:
  - `aspect-[9/16]` thumbnail via `row.thumbnailUrl` (already proxied; null → neutral placeholder block with platform glyph).
  - Rank badge top-left (`01`–`20`, winner tinted brand).
  - `PlatformPill` (icon only) top-right.
  - Footer overlay: `viewsGained` (compact) + creator displayName/handle.
  - Whole card is a link to the post permalink (`buildPostUrl(platform, {}, externalPostId, handle)`), `target="_blank" rel="noopener noreferrer"`.
- Thumbnail, NOT live embed — 20 iframes would tank performance and fight the design system. Click-out to the real post instead.
- Empty: if `getTopContentWindowed` returns [], render `EmptyState size="sm"` "No content ranked yet · Building history…".

**Layout:** the two boards stack vertically, each in a `GlassCard`. Follower board first, View board below. Existing platform tab bar stays above both and filters both (client state lifted to the showcase root).

## Build-history contract (shared, both routes)

A tiny presentational helper decides per value: `insufficient ? "Building history…" : formatted`. Put it where both showcases can import it (e.g. extend `showcase-data.ts` or a small `lib/format.ts`). Plan picks the location; do not inline the string in five places.

## What this phase does NOT do

- No admin, no `/me`, no auth/provisioning (Phases 2/3).
- No new SQL/RPC. No time-series sparkline RPC (hero sparkline stays demo + "Preview").
- No deletion of `engagementRate` from shared types (later cleanup once Phase 3 stops reading it).

## Risks

- **Demo/live divergence:** the synthetic fallback must show Views, not engagement, or pre-launch the page looks self-contradictory. Plan adds demo Views numbers.
- **`insufficient` everywhere early:** with ~1 snapshot day in prod today, every windowed value is currently `insufficient=true` → the whole dashboard reads "Building history…". That's correct behavior, but verify the page still looks intentional (not broken) in that state. Screenshot check in the plan.
- **`viaProxy` duplication** (already flagged, separate task) — Phase 1 adds another consumer (the view grid) but should import the shared helper once that task lands; until then, reuse `metrics-windowed`'s already-proxied `thumbnailUrl` so no new copy is introduced here.
