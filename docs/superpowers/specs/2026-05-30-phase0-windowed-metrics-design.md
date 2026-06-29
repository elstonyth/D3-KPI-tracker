# Phase 0 — Windowed-Metrics Data Layer (Keystone)

**Date:** 2026-05-30
**Status:** Approved design, ready for implementation plan.
**Parent:** `2026-05-30-views-over-engagement-overview.md`
**Depends on:** nothing. **Blocks:** Phases 1, 2, 3.

## Goal

A reusable engine that returns **windowed** creator metrics and top content, where the headline numbers are **deltas over a time window** (views gained, followers gained) plus a views-based engagement rate. One definition, consumed by public, admin, and creator surfaces.

Success criteria (verifiable):
- Given seeded snapshots spanning >90 days, the RPCs return correct `views_gained`, `followers_delta`, and `engagement` for each of `7d / 30d / 90d / lifetime`.
- A profile with <window days of history reports `insufficient = true` and null/0 deltas (not garbage).
- No-view posts are excluded from the engagement denominator (never div-by-zero, never counted as 0%).
- TS wrapper returns typed objects; existing `lib/queries.ts` callers keep working unchanged until their phase migrates them.

## Window model

```
type MetricWindow = '7d' | '30d' | '90d' | 'lifetime';
```

Per window, baseline date:
- `7d`  → `current_date - 7`
- `30d` → `current_date - 30`
- `90d` → `current_date - 90`
- `lifetime` → followers: earliest snapshot of the profile; views: baseline 0.

"Current" value = latest snapshot at/under today. "Baseline" value = the snapshot on-or-before the baseline date (most recent such row). Delta = current − baseline. Lifetime views delta = current total (baseline 0) = first-content-to-now.

## Definitions (single source of truth)

- **views_gained(window)** = `Σ_posts ( current_views(post) − baseline_views(post, window) )`, floored at 0 per post (a post can't lose views; guards against re-scrape noise / deletions). Lifetime = `Σ current_views`.
- **followers_delta(window)** = `current_followers − baseline_followers`, per profile, summed across a creator's profiles. Lifetime = `current − earliest`.
- **followers (current)** = `Σ latest followers across the creator's profiles`.
- **engagement(window)** = `Σ_qualifying_posts (likes+comments+shares) ÷ Σ_qualifying_posts views`, where a *qualifying* post has `views > 0` and a snapshot in the window. (Ratio of sums, not avg of ratios — stable, weights by reach.) Posts with `views = 0/null` excluded entirely.
- **post scope for a window** = posts whose latest snapshot falls in the window (for views_gained we still need the per-post baseline within the window). Lifetime = all posts ever snapshotted.
- **insufficient(window)** = profile's earliest snapshot is newer than the baseline date (we can't compute a true delta yet). Mirrors current 14-day guard, generalized per window.

## Components

### 1. Migration — `supabase/migrations/<ts>_windowed_metrics_rpcs.sql`

Additive only. Two `language sql stable` functions + supporting indexes.

**`creator_metrics_windowed(p_window text, p_creator_ids uuid[] default null, p_profile_ids uuid[] default null)`**
Returns one row per creator (or filtered subset):
```
creator_id uuid, display_name text, avatar_url text,
primary_platform text,            -- platform of the creator's largest-follower profile
followers bigint,                 -- current
followers_delta bigint,           -- windowed
views_gained bigint,              -- windowed (Option A)
engagement numeric,               -- windowed, views-based, guarded
post_count int,                   -- qualifying posts in window
insufficient boolean
```
- `p_profile_ids` filter → powers `/me` (narrow to a user's claimed profiles).
- `p_creator_ids` filter → optional targeted fetch.
- null both → all creators (public dashboard/leaderboard, admin).

Implementation sketch (per profile, via CTEs):
- `latest_profile_snap`: `DISTINCT ON (profile_id)` ordered `captured_date DESC` → current followers.
- `baseline_profile_snap`: `DISTINCT ON (profile_id)` where `captured_date <= baseline` ordered `captured_date DESC` → baseline followers (lifetime: earliest, ordered ASC).
- `latest_post` / `baseline_post`: same `DISTINCT ON (profile_id, external_post_id)` pattern on `post_snapshot`.
- Aggregate to creator via `profile.creator_id`.

**`top_content_windowed(p_window text, p_limit int default 20, p_creator_ids uuid[] default null, p_profile_ids uuid[] default null)`**
Returns top posts by `views_gained` desc:
```
external_post_id text, profile_id uuid, creator_id uuid,
creator_name text, platform text, handle text,
caption_excerpt text, media_url text, posted_at timestamptz,
views_gained bigint, current_views bigint,
likes bigint, comments bigint, shares bigint
```
- Powers public View-Leaderboard (limit 20), admin Top-30 content (limit 30), `/me` leaderboard (profile-filtered).
- Permalink built client/TS-side via existing `buildPostUrl` (kept in `queries.ts`; export if needed).

**Indexes** (additive, perf for the DISTINCT ON scans):
- `create index if not exists idx_post_snapshot_profile_post_date on post_snapshot (profile_id, external_post_id, captured_date desc);`
- `create index if not exists idx_profile_snapshot_profile_date on profile_snapshot (profile_id, captured_date desc);`
(If equivalents already exist from the unique constraints, skip — verify with `\d` first.)

### 2. TS wrapper — `apps/frontend/src/lib/metrics-windowed.ts`

- `getCreatorMetricsWindowed(window, opts?)` → `CreatorMetricWindowRow[]` via `getSupabaseRead().rpc('creator_metrics_windowed', …)` for public, or accept an injected client so admin/`/me` can pass service-role / cookie-aware clients.
- `getTopContentWindowed(window, opts?)` → `TopContentRow[]`.
- Exported TS types matching the RPC columns. `viaProxy(media_url)` applied here (reuse helper) so consumers get proxy URLs.
- Pure pass-through + light mapping (snake → camel, proxy wrap). No business logic — it lives in SQL.

### 3. Insufficiency guard

Carried in the RPC (`insufficient` column). TS surfaces it; each UI phase decides rendering (blank cell / "fills in after N days" note), reusing the existing copy pattern.

## What this phase does NOT touch

- No UI changes. No edits to `dashboard-showcase`, `leaderboard-showcase`, `creator-stats`, admin pages.
- `lib/queries.ts` left intact (old functions still feed current pages until their phase migrates them). New code lives in the new file.

## Verification (MATH PROVEN read-only; prod apply still pending)

> **Status 2026-05-30:** the delta/engagement/insufficiency math is **proven** —
> the CTE logic was inlined as a read-only SELECT and run against the live
> d3-creator DB over both a VALUES fixture and the real tables. **Nothing was
> created in prod** (every CREATE FUNCTION attempt was correctly denied; only
> SELECTs ran; `pg_proc`/`pg_indexes` confirm 0 new objects, data intact).
> What remains: applying the functions to prod (needs write-approval) + the TS
> wrapper + lint — these are step 1 of the implementation plan.

**Proven results (fixture, identical to targets below) — all 4 windows PASS:**

| window | views_gained | engagement | post_count | followers_delta | insufficient |
|---|---|---|---|---|---|
| 7d | 2000 | 0.0643 | 2 | 100 | false |
| 30d | 6000 | 0.0643 | 2 | 200 | false |
| 90d | 7000 | 0.0643 | 2 | 0 | true |
| lifetime | 7000 | 0.0643 | 2 | 200 | false |

**Real-data invariant check (22 creators, every window):** `views_gained >= 0`,
zero negatives, engagement ∈ [0.0059, 0.0368] (in range), `insufficient` correct,
base-0 reconciles. Both risks (NULL baseline, current_date folding) confirmed handled.

> **⚠ DATA-MATURITY FINDING (product-relevant):** the DB currently holds only
> **one snapshot day** (2026-05-30) — 62 profiles × 1 day, 968 posts × 1 day.
> With no historical baseline, **all four windows return identical numbers right
> now** and windowed deltas read as "current totals". Option A only becomes
> meaningful once the daily cron accrues ≥2 days; expect ~7 days before 7D is
> truthful and ~90 before 90D is. **UI implication:** Phase 1/3 should show an
> interim "building history…" state (reuse the `insufficient` flag) rather than
> implying the deltas are real on day one.

**Fixture to seed** (one profile): post A `1000→4500→5000` views (snapshots at
−40/−7/0d); post B posted in-window `500→2000` (−20/0d); post C `0` views (today);
followers `1000→1100→1200` (−40/−7/0d).

**Expected results to assert (all four windows):**

| window | views_gained | engagement | post_count | followers_delta | insufficient |
|---|---|---|---|---|---|
| 7d | 2000 | 0.0643 | 2 | 100 | false |
| 30d | 6000 | 0.0643 | 2 | 200 | false |
| 90d | 7000 | 0.0643 | 2 | 0 | true |
| lifetime | 7000 | 0.0643 | 2 | 200 | false |

Plus: `top_content_windowed('30d')` ranks A(4000) → B(2000) → C(0); engagement
denominator excludes no-view post C (450/7000 = 0.0643).

**Steps:**
1. Seed the fixture into the **correct** project (`wmesjldkqvbzrcpitclu` =
   d3-creator) with fixed test UUIDs.
2. `apply_migration` the RPCs; call both for all 4 windows; assert the table above.
3. Tear down the fixture; confirm row counts return to baseline.
4. `pnpm` typecheck + lint from root for the TS wrapper.
5. Confirm/drop redundant indexes via `\d` (v1 unique constraints may already cover them).

**Two risks handled pre-emptively at the reasoning level (confirm during the run):**
1. **NULL follower baseline**: when a window has no snapshot on-or-before its start
   (90d on a 40-day-old profile), `current − NULL = NULL` → null delta. Handled by
   `followers_delta = 0` + `insufficient = (base_followers IS NULL)`. *Must confirm.*
2. **IMMUTABLE + current_date**: a baseline helper marked IMMUTABLE while reading
   `current_date` (STABLE) could be mis-folded by the planner. Handled by inlining
   the baseline CASE; functions are STABLE. *Must confirm.*

**Semantic note (by design):** engagement uses each post's *current* (L+C+S) and
*current* views; the window only gates which posts are *included*. So engagement is
roughly window-insensitive when the same posts are active across windows —
intentional; the headline windowed metric is views_gained.

## Risks

- **Re-scrape noise**: a post's view count could dip between scrapes (platform corrections). Per-post `GREATEST(delta, 0)` floor handles it.
- **Large scans**: indexes above keep DISTINCT ON ranged. v1 scale (<100 profiles) is comfortable; revisit if profile count explodes.
- **Lifetime cost**: lifetime scans all snapshots for a profile — bounded by the 6-month purge cron, so worst case ~180 rows/profile.
