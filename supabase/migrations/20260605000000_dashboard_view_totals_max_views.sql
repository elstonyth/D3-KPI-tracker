-- Make the dashboard's windowed view totals robust to a transient bad re-scrape,
-- mirroring the JS rollup fix in lib/queries.ts (getLiveCreatorRows /
-- loadContentRows).
--
-- dashboard_view_totals_windowed (migration 20260604000000) deduped each post to
-- its NEWEST snapshot (`distinct on (...) order by captured_date desc`,
-- coalesce(pp.views,0)). Views are monotonic, but a transient bad re-scrape can
-- land a LOWER value as the newest snapshot — e.g. Douyin's feed reports
-- play_count=0 and real views come from a separate stats endpoint; when that
-- endpoint 402'd during a TikHub-credit outage, posts were overwritten with 0
-- and the dashboard undercounted. Take MAX(views) across a post's snapshots
-- instead; posted_at is constant per post so it's unaffected.
--
-- create-or-replace: identical signature + return shape as 20260604000000, only
-- the cur_post CTE changes (newest-snapshot -> max-views-per-post).

create or replace function public.dashboard_view_totals_windowed(
  p_creator_ids uuid[] default null
)
returns table (creator_id uuid, platform text, win text, total_views bigint)
language sql stable as $$
  with
  scope_profile as (
    select pr.id, pr.creator_id, pr.platform
    from public.profile pr
    where pr.platform <> 'rednote'  -- xiaohongshu archived: excluded before aggregation
      and (p_creator_ids is null or pr.creator_id = any(p_creator_ids))
  ),
  -- One row per distinct post: MAX cumulative views across its snapshots (views
  -- are monotonic, so a transient lower re-scrape must not win) + the post's
  -- publish time (constant per post).
  cur_post as (
    select sp.creator_id, sp.platform,
      coalesce(max(pp.views), 0) as cur_views,
      max(pp.posted_at) as posted_at
    from public.post_snapshot pp
    join scope_profile sp on sp.id = pp.profile_id
    group by pp.profile_id, pp.external_post_id, sp.creator_id, sp.platform
  ),
  -- 'win' not 'window' (reserved word). Rolling timestamp cutoffs; null `since`
  -- => lifetime (all posts).
  windows(win, since) as (
    values
      ('1d',       now() - interval '1 day'),
      ('1w',       now() - interval '7 days'),
      ('1m',       now() - interval '30 days'),
      ('3m',       now() - interval '90 days'),
      ('6m',       now() - interval '180 days'),
      ('12m',      now() - interval '365 days'),
      ('lifetime', null::timestamptz)
  )
  -- Conditional SUM over the full posts × windows cross join (NOT a WHERE
  -- filter) so every (creator × platform × window) yields a row — 0 when no post
  -- qualifies — rather than an absent cell that the UI would misread.
  select cp.creator_id, cp.platform, w.win,
    coalesce(
      sum(cp.cur_views) filter (where w.since is null or cp.posted_at >= w.since),
      0
    )::bigint as total_views
  from cur_post cp
  cross join windows w
  group by cp.creator_id, cp.platform, w.win;
$$;
