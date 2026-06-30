# Admin per-creator daily KPI view — design

**Date:** 2026-06-30
**Status:** approved-pending-review
**Surface:** `/admin/creators/[id]` (admin-only)

## Goal

Give the admin a per-creator KPI breakdown with **daily granularity** on the
creator page, which today is an editor only (name / URLs / login, no stats).
Show **followers gained per day** and **views per day** (gained + cumulative),
as charts and a table, over a selectable range.

The daily data already exists (`profile_snapshot` = followers/total per day,
`post_snapshot` = per-post views per day, written by the daily cron). This is a
read + UI feature: no new scraping, no schema change beyond one read-only RPC.

## Scope (locked decisions)

- **Views metric:** BOTH — views _gained_ per day (headline bars) + cumulative
  total views (secondary line).
- **Breakdown:** creator-level total only, aggregated across the creator's
  platforms (no per-platform split in v1).
- **Range:** selectable 7 / 30 / 90 days, default 30, via `?days=` URL param.
- **Followers:** gained per day (bars) + current total (card). No cumulative
  line for followers in v1.

Out of scope (v1): per-platform breakdown, engagement-per-day, CSV export,
post-level daily drilldown. Noted as future work.

## Data layer — `creator_daily_kpis(p_creator_id uuid, p_days int)`

New read-only SQL function (mirrors the existing windowed RPCs; all metric math
stays in Postgres). Returns one row per day, newest-or-oldest order decided in
TS:

| column                   | type    | meaning                                                                  |
| ------------------------ | ------- | ------------------------------------------------------------------------ |
| `day`                    | date    | calendar day (UTC)                                                       |
| `followers_total`        | bigint  | Σ followers across the creator's profiles, carried forward to that day   |
| `followers_gained`       | bigint  | `followers_total(day) − followers_total(day-1)`                          |
| `followers_insufficient` | boolean | true when there is no prior-day follower baseline                        |
| `views_total`            | bigint  | Σ cumulative post views as of that day (0 until the first post snapshot) |
| `views_gained`           | bigint  | `views_total(day) − views_total(day-1)`                                  |
| `views_insufficient`     | boolean | true when there is no prior-day view baseline (views can start later)    |

### Semantics

- **Aggregate across the creator's profiles**, excluding `rednote` (matches
  `scope_profile` in every other RPC).
- **Followers carry-forward:** for each profile, the value on day D is the
  followers count from the most recent snapshot with `captured_date <= D`. A
  missed scrape day does not drop the profile to 0 (which would fake a crash +
  rebound in the delta).
- **Views use `MAX`** per (profile, external_post_id) across that post's
  snapshots up to day D — robust to a transient bad re-scrape writing a lower
  value (same reasoning as `dashboard_view_totals_max_views`, migration
  20260605000000). Views are otherwise monotonic, so `views_gained >= 0`.
- **Baseline day:** the series runs from `current_date - p_days` through
  `current_date` (`p_days` + 1 calendar days) so the first displayed day still has
  a prior day to diff against. Days with no prior-day baseline are flagged
  `followers_insufficient` / `views_insufficient` and rendered as `—` (no
  fabricated spike from 0). The two flag **independently** — a creator can have
  follower history before their first post snapshot, so the view delta is
  suppressed on the first observed post day without suppressing the follower delta.
- `p_days` clamped to a sane set server-side: `least(greatest(p_days,1),90)`.

### Implementation sketch (final SQL proven by the verify fixture)

```sql
with bounds as (select least(greatest(coalesce(p_days, 30), 1), 90) as n),
days as (
  select generate_series(current_date - (select n from bounds), current_date, interval '1 day')::date as day
),
prof as (
  select id from public.profile
  where creator_id = p_creator_id and platform <> 'rednote'
),
foll as ( -- carry-forward followers per profile per day
  select d.day, sum((
    select s.followers from public.profile_snapshot s
    where s.profile_id = pr.id and s.captured_date <= d.day
    order by s.captured_date desc limit 1
  ))::bigint as followers_total
  from days d cross join prof pr group by d.day
),
posts as (
  select distinct profile_id, external_post_id from public.post_snapshot
  where profile_id in (select id from prof)
),
vw as ( -- cumulative views (MAX per post); NULL until the first post snapshot
  select d.day, sum((
    select max(ps.views) from public.post_snapshot ps
    where ps.profile_id = p.profile_id and ps.external_post_id = p.external_post_id
      and ps.captured_date <= d.day
  ))::bigint as views_total
  from days d cross join posts p group by d.day
),
merged as ( -- LEFT JOIN so followers-only creators still get a series
  select f.day, f.followers_total, v.views_total
  from foll f left join vw v on v.day = f.day
)
select day,
  followers_total,
  (followers_total - lag(followers_total) over w)::bigint as followers_gained,
  (lag(followers_total) over w) is null as followers_insufficient,
  coalesce(views_total, 0)::bigint as views_total,
  (views_total - lag(views_total) over w)::bigint as views_gained,
  (lag(views_total) over w) is null as views_insufficient
from merged
window w as (order by day)
order by day
offset 1; -- drop the baseline day, keep the p_days window
```

Performance: bounded to one creator (≤5 profiles, ≤90 days, posts in the
hundreds). Correlated subqueries are acceptable at that size; this is an
admin-only, on-demand page. **ponytail: correlated-subquery carry-forward, fine
for one creator/≤90d; switch to window-function fill if a creator's post count
makes it slow.**

### Security

Service-role only. After creating the function:
`revoke execute on function public.creator_daily_kpis(uuid, int) from public, anon, authenticated;`
`grant execute on function public.creator_daily_kpis(uuid, int) to service_role;`
`set search_path = ''` on the function. The admin page calls it through the
service-role client (`getSupabaseAdmin`), so no broader grant is needed — and a
creator must never be able to pull another creator's KPIs by id via PostgREST.

### Migration

New file `supabase/migrations/<timestamp>_creator_daily_kpis_rpc.sql`. Additive
(new function only). Applied to the fresh DB (`icyzebmulhinwnifnmmx`) via the
Supabase MCP, consistent with how the rest of the schema was applied.

## TypeScript layer — `lib/metrics-daily.ts`

```ts
export interface CreatorDailyKpiRow {
  day: string; // ISO date
  followersTotal: number;
  followersGained: number;
  viewsTotal: number;
  viewsGained: number;
  insufficient: boolean;
}
export async function getCreatorDailyKpis(
  creatorId: string,
  days: number,
  opts?: { client?: SupabaseClient },
): Promise<CreatorDailyKpiRow[]>;
```

Thin pass-through over `rpc('creator_daily_kpis', …)`. Returns `[]` on error
(logged), matching `metrics-windowed.ts`, so the page falls back to an empty
state instead of throwing.

## UI

### Page — `app/(admin)/admin/creators/[id]/page.tsx`

- Accept `searchParams` and parse `days` (7 | 30 | 90, default 30) — small local
  helper, clamp unknown values to 30.
- Fetch `getCreatorDailyKpis(getSupabaseAdmin(), id, days)` alongside the
  existing `getAdminCreatorDetail`.
- Render a new `<DailyKpis>` section ABOVE `<CreatorEditor>` (it's now the
  primary value of the page; the editor moves below).

### `daily-kpis.tsx` (section)

- **Range tabs** (`days-tabs.tsx`, client): links to `?days=7|30|90`, active state
  styled like the existing nav.
- **Summary cards** (reuse the `Kpi` card pattern from `creator-stats.tsx`):
  - _Followers_ — current `followersTotal` + Δ = Σ `followersGained` over window,
    with ▲/▼ caret and `insufficient` → "Building history…".
  - _Views_ — Σ `viewsGained` over window + current `viewsTotal`.
- **Followers gained/day** — `<DailyBars>` (bars, supports negative values).
- **Views** — `<DailyBars>` of `viewsGained` + a `<Sparkline>` of `viewsTotal`
  (cumulative line). Two stacked mini-charts, not a dual-axis overlay (clearer,
  reuses the existing `Sparkline` as-is).
- **Daily table** — columns `Date · Followers · Followers Δ · Views · Views Δ`,
  newest first, `max-h` + scroll, `tabular-nums`, ▲/▼ on deltas, `—` when
  `insufficient`.
- **Empty state** — when the RPC returns `[]` or all-insufficient: `EmptyState`
  "Daily KPIs appear after the first scrape."

### `daily-bars.tsx` (new chart primitive)

Small SVG bar chart in the brand language (`#F2E600`), `'use client'`, animated
like `Sparkline`. Props: `values: number[]`, `labels?: string[]`, `ariaLabel`.
Zero baseline; negative values draw below the baseline in a muted tone. Reduced-
motion respected (mirror Sparkline's `prefers-reduced-motion` block).

## Error handling

- RPC error → `[]` (logged) → empty state. No throw.
- First in-range day with no baseline → `insufficient` → `—` in table, omitted
  from the gained bars (or shown as 0), never a fake spike.
- A creator with zero posts → `views_total`/`views_gained` are 0 (coalesced),
  followers still render.

## Testing

- **`supabase/tests/creator_daily_kpis_verify.sql`** (mirrors
  `windowed_metrics_verify.sql`): `begin;` seed one creator + 2 profiles +
  snapshots across 3–4 days (incl. a deliberate gap to prove carry-forward) +
  posts with a known view progression (incl. a transient lower re-scrape to
  prove `MAX`); assert exact `followers_gained` / `views_gained` per day;
  `rollback;`.
- No dedicated TS test for the thin lib wrapper (matches `metrics-windowed.ts`,
  which has none — the logic under test lives in SQL).
- Manual: seed a little data, load `/admin/creators/[id]?days=30`, confirm the
  cards, both charts, and the table render and reconcile.

## Future work (not v1)

Per-platform breakdown (tabs), engagement-per-day, post-level drilldown, CSV
export, surfacing the same section read-only on the creator's own `/me` page.
