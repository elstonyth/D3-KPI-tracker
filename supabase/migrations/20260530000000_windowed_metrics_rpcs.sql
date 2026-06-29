-- Phase 0 — Windowed-metrics data layer (keystone for Views-over-Engagement).
--
-- Additive only: two read-only functions + (conditional) indexes. No table or
-- column is dropped/altered, so this is safe on live data per CLAUDE.md deploy
-- rules.
--
-- MATH VERIFIED against a seeded worked-example fixture (all 4 windows PASS,
-- rolled back) — see supabase/tests/windowed_metrics_verify.sql. Real-data
-- smoke test on 22 creators: views_gained >= 0 everywhere, engagement in a
-- sane range, insufficient flags correct.
--
-- DATA-MATURITY FINDING: as of 2026-05-30 the DB holds only ONE snapshot day,
-- so every window currently returns identical numbers (no baseline to diff).
-- Windowed deltas only diverge once the daily cron accrues >=2 days of history;
-- Option A ("views gained in window") shows no movement for ~7 days post-launch.
--
-- Two risks confirmed handled:
--   1. NULL follower baseline (window with no on-or-before snapshot): current -
--      NULL = NULL. Handled: delta 0 + insufficient when base_followers IS NULL.
--   2. current_date folding: baseline CASE is inlined (not an IMMUTABLE helper);
--      functions are STABLE.
--
-- plpgsql (not plain sql) so an unsupported p_window FAILS FAST instead of
-- silently falling through to lifetime. `#variable_conflict use_column` makes
-- column names (e.g. ORDER BY views_gained) win over the same-named OUT params.
--
-- Definitions (single source of truth):
--   views_gained(window) = Σ_posts GREATEST(current_views - baseline_views, 0)
--       baseline_views = views at the most-recent post_snapshot on-or-before
--       the window start; 0 if none (lifetime, or post newer than the window).
--   followers_delta(window) = current_followers - baseline_followers, summed
--       across the creator's profiles; 0 when no in-window baseline exists.
--   engagement(window) = Σ(likes+comments+shares) / Σ(views) over QUALIFYING
--       posts only (views > 0 and latest snapshot in-window). Ratio-of-sums,
--       weighted by reach. Posts with 0/NULL views are excluded entirely so
--       there is never a divide-by-zero. A creator WITH views but zero
--       interactions returns 0.0000 (not NULL); NULL means "no qualifying
--       posts at all" (view_sum = 0).
--   insufficient(window) = ANY of the creator's included profiles has no
--       follower baseline on-or-before the window start (bool_or). Even one
--       baseline-less profile understates the summed delta, so the row is
--       flagged so the UI shows "Building history…" instead of a deceptively
--       mature number. For lifetime, a profile's baseline is its earliest
--       snapshot, so lifetime is insufficient only for a profile with zero
--       snapshots.

-- ---------------------------------------------------------------------------
-- creator_metrics_windowed
-- One row per creator (optionally filtered to creators or profiles).
-- p_profile_ids narrows to specific profiles (powers /me); p_creator_ids
-- narrows to specific creators; both null => all creators (public/admin).
-- ---------------------------------------------------------------------------
create or replace function public.creator_metrics_windowed(
  p_window text default '30d',
  p_creator_ids uuid[] default null,
  p_profile_ids uuid[] default null
)
returns table (
  creator_id uuid, display_name text, avatar_url text,
  primary_platform text, primary_handle text,
  followers bigint, followers_delta bigint, views_gained bigint,
  engagement numeric, post_count int, insufficient boolean
) language plpgsql stable as $$
#variable_conflict use_column
begin
  if p_window not in ('7d','30d','90d','lifetime') then
    raise exception 'invalid p_window: % (expected one of 7d, 30d, 90d, lifetime)', p_window;
  end if;

  return query
  with
  params as (
    select case p_window
      when '7d' then current_date - 7
      when '30d' then current_date - 30
      when '90d' then current_date - 90
      else null end as baseline           -- null => lifetime
  ),
  scope_profile as (
    select pr.id, pr.creator_id, pr.platform, pr.handle from public.profile pr
    where pr.platform <> 'rednote'  -- xiaohongshu archived: excluded before aggregation/limit
      and (p_profile_ids is null or pr.id = any(p_profile_ids))
      and (p_creator_ids is null or pr.creator_id = any(p_creator_ids))
  ),
  cur_foll as (
    select distinct on (ps.profile_id) ps.profile_id, ps.followers as cur_f
    from public.profile_snapshot ps join scope_profile sp on sp.id = ps.profile_id
    order by ps.profile_id, ps.captured_date desc
  ),
  early_foll as (
    select distinct on (ps.profile_id) ps.profile_id, ps.followers as early_f
    from public.profile_snapshot ps join scope_profile sp on sp.id = ps.profile_id
    order by ps.profile_id, ps.captured_date asc
  ),
  base_foll as (
    select sp.id as profile_id,
      case when (select baseline from params) is null then ef.early_f
           else (select ps.followers from public.profile_snapshot ps
                 where ps.profile_id = sp.id and ps.captured_date <= (select baseline from params)
                 order by ps.captured_date desc limit 1)
      end as base_f
    from scope_profile sp left join early_foll ef on ef.profile_id = sp.id
  ),
  cur_post as (
    select distinct on (pp.profile_id, pp.external_post_id)
      pp.profile_id, pp.external_post_id, pp.views as cur_views,
      (coalesce(pp.likes,0)+coalesce(pp.comments,0)+coalesce(pp.shares,0)) as eng,
      pp.captured_date as cur_date
    from public.post_snapshot pp join scope_profile sp on sp.id = pp.profile_id
    order by pp.profile_id, pp.external_post_id, pp.captured_date desc
  ),
  base_post as (
    select cp.profile_id, cp.external_post_id,
      (select pp.views from public.post_snapshot pp
       where pp.profile_id = cp.profile_id and pp.external_post_id = cp.external_post_id
         and (select baseline from params) is not null
         and pp.captured_date <= (select baseline from params)
       order by pp.captured_date desc limit 1) as base_views
    from cur_post cp
  ),
  post_calc as (
    select cp.profile_id,
      greatest(coalesce(cp.cur_views,0) - coalesce(bp.base_views,0), 0) as gained,
      cp.cur_views, cp.eng,
      (coalesce(cp.cur_views,0) > 0
        and ((select baseline from params) is null or cp.cur_date >= (select baseline from params))) as qualifies
    from cur_post cp
    left join base_post bp on bp.profile_id = cp.profile_id and bp.external_post_id = cp.external_post_id
  ),
  -- Aggregate post_calc once per profile (instead of four correlated
  -- subqueries) so the CTE is scanned a single time.
  post_calc_agg as (
    select profile_id,
      sum(gained) as views_gained,
      sum(eng) filter (where qualifies) as eng_sum,
      sum(cur_views) filter (where qualifies) as view_sum,
      count(*) filter (where qualifies) as qual_posts
    from post_calc
    group by profile_id
  ),
  per_profile as (
    select sp.id as profile_id, sp.creator_id, sp.platform, sp.handle,
      coalesce(cf.cur_f,0) as cur_f, bf.base_f,
      coalesce(pca.views_gained,0) as views_gained,
      coalesce(pca.eng_sum,0) as eng_sum,
      coalesce(pca.view_sum,0) as view_sum,
      coalesce(pca.qual_posts,0) as qual_posts
    from scope_profile sp
    left join cur_foll cf on cf.profile_id = sp.id
    left join base_foll bf on bf.profile_id = sp.id
    left join post_calc_agg pca on pca.profile_id = sp.id
  ),
  -- Highest-follower profile decides BOTH the primary platform and the primary
  -- handle (the slug for /creators/<handle> links — the route resolves by
  -- profile handle, not display name). Secondary sort key (platform) keeps the
  -- pick deterministic on a follower tie.
  primary_pick as (
    select distinct on (creator_id) creator_id, platform, handle
    from per_profile order by creator_id, cur_f desc, platform
  )
  select c.id, c.display_name, c.avatar_url, pp.platform, pp.handle,
    sum(p.cur_f)::bigint,
    sum(case when p.base_f is null then 0 else p.cur_f - p.base_f end)::bigint,
    sum(p.views_gained)::bigint,
    -- coalesce on the NUMERATOR (not nullif): a creator with views but zero
    -- interactions yields 0.0000; only view_sum = 0 (no qualifying posts) -> NULL.
    round(coalesce(sum(p.eng_sum),0)::numeric / nullif(sum(p.view_sum),0), 4),
    sum(p.qual_posts)::int,
    -- insufficient when ANY included profile lacks an in-window baseline: its
    -- missing delta is silently summed as 0, understating the creator's true
    -- windowed delta, so the UI should show "Building history…" rather than a
    -- deceptively-mature number. (bool_or, not bool_and.)
    bool_or(p.base_f is null)
  from per_profile p
  join public.creator c on c.id = p.creator_id
  left join primary_pick pp on pp.creator_id = p.creator_id
  group by c.id, c.display_name, c.avatar_url, pp.platform, pp.handle;
end;
$$;

-- ---------------------------------------------------------------------------
-- top_content_windowed
-- Top posts by views_gained in the window. Powers public View-Leaderboard
-- (limit 20), admin Top-30 content (limit 30), /me leaderboard (profile-
-- filtered). Permalinks are built in TS via the existing buildPostUrl helper.
-- ---------------------------------------------------------------------------
create or replace function public.top_content_windowed(
  p_window text default '30d', p_limit int default 20,
  p_creator_ids uuid[] default null, p_profile_ids uuid[] default null
)
returns table (
  external_post_id text, profile_id uuid, creator_id uuid, creator_name text,
  platform text, handle text, caption_excerpt text, media_url text,
  posted_at timestamptz, views_gained bigint, current_views bigint,
  likes bigint, comments bigint, shares bigint
) language plpgsql stable as $$
#variable_conflict use_column
begin
  if p_window not in ('7d','30d','90d','lifetime') then
    raise exception 'invalid p_window: % (expected one of 7d, 30d, 90d, lifetime)', p_window;
  end if;

  return query
  with
  params as (
    select case p_window
      when '7d' then current_date - 7
      when '30d' then current_date - 30
      when '90d' then current_date - 90
      else null end as baseline
  ),
  scope_profile as (
    select pr.id, pr.creator_id, pr.platform, pr.handle from public.profile pr
    where pr.platform <> 'rednote'  -- xiaohongshu archived: excluded before aggregation/limit
      and (p_profile_ids is null or pr.id = any(p_profile_ids))
      and (p_creator_ids is null or pr.creator_id = any(p_creator_ids))
  ),
  cur_post as (
    select distinct on (pp.profile_id, pp.external_post_id)
      pp.profile_id, pp.external_post_id, pp.views as cur_views,
      coalesce(pp.likes,0) as likes, coalesce(pp.comments,0) as comments,
      coalesce(pp.shares,0) as shares, pp.caption_excerpt, pp.media_url, pp.posted_at
    from public.post_snapshot pp join scope_profile sp on sp.id = pp.profile_id
    order by pp.profile_id, pp.external_post_id, pp.captured_date desc
  ),
  base_post as (
    select cp.profile_id, cp.external_post_id,
      (select pp.views from public.post_snapshot pp
       where pp.profile_id = cp.profile_id and pp.external_post_id = cp.external_post_id
         and (select baseline from params) is not null
         and pp.captured_date <= (select baseline from params)
       order by pp.captured_date desc limit 1) as base_views
    from cur_post cp
  )
  select cp.external_post_id, cp.profile_id, sp.creator_id, c.display_name,
    sp.platform, sp.handle, cp.caption_excerpt, cp.media_url, cp.posted_at,
    greatest(coalesce(cp.cur_views,0) - coalesce(bp.base_views,0), 0)::bigint as views_gained,
    coalesce(cp.cur_views,0)::bigint, cp.likes::bigint, cp.comments::bigint, cp.shares::bigint
  from cur_post cp
  join scope_profile sp on sp.id = cp.profile_id
  join public.creator c on c.id = sp.creator_id
  left join base_post bp on bp.profile_id = cp.profile_id and bp.external_post_id = cp.external_post_id
  order by views_gained desc limit p_limit;
end;
$$;

-- Supporting indexes for the DISTINCT ON range scans. IF NOT EXISTS guards
-- against the equivalents already created by the v1 unique constraints
-- (profile_snapshot_unique_day / post_snapshot_unique_day). EXPLAIN confirmed
-- the planner uses idx_post_snapshot_profile_post_date for the DISTINCT ON scan.
create index if not exists idx_profile_snapshot_profile_date
  on public.profile_snapshot (profile_id, captured_date desc);
create index if not exists idx_post_snapshot_profile_post_date
  on public.post_snapshot (profile_id, external_post_id, captured_date desc);
