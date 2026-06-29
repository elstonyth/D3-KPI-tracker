-- Dashboard "Total Views" period filter — windowed view totals by POST AGE,
-- broken out PER CREATOR × platform so the whole dashboard (hero, platform
-- breakdown, AND the Top Creators ranking) follows the active period pill.
--
-- Returns one row per (creator × platform × window). The caller
-- (lib/metrics-windowed.getDashboardViewTotalsWindowed) rolls it up two ways —
-- Σ creators → per-platform (hero + breakdown), and per-creator (Top Creators
-- re-rank). Sole source of windowed view totals for the dashboard.
--
-- SEMANTIC: total_views(win) = Σ current_views of posts PUBLISHED within the
-- window, using ROLLING cutoffs (posted_at >= now() - interval 'N') so "last 24
-- hours / last 7 days / …" mean exactly that. A calendar `current_date - 1`
-- would, run after midnight, sweep in ~24–48h of posts under a "last 24 hours"
-- label and overstate the period. Content-recency, NOT a views-gained delta —
-- needs no snapshot baseline, so windows are distinct + nested
-- (1D ⊆ 1W ⊆ … ⊆ Lifetime).
--   current_views = newest post_snapshot per (profile, external_post_id).
--   posted_at = publish time (100% populated). Lifetime (null) = all posts.
--   now() is the transaction start time, so the function stays STABLE.
--
-- Distinct from creator_metrics_windowed's views_gained (migration
-- 20260530000000), the leaderboard's growth metric. rednote (xiaohongshu)
-- excluded before aggregation. p_creator_ids defaults to all (public dashboard);
-- the verify fixture passes it to scope to seeded rows. create-or-replace: the
-- return shape is unchanged from the deployed function, only the cutoffs change.

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
  -- Newest snapshot per distinct post → its current cumulative view count + the
  -- post's publish time (dedup so a post snapshotted across days counts once).
  cur_post as (
    select distinct on (pp.profile_id, pp.external_post_id)
      sp.creator_id, sp.platform, coalesce(pp.views, 0) as cur_views, pp.posted_at
    from public.post_snapshot pp
    join scope_profile sp on sp.id = pp.profile_id
    order by pp.profile_id, pp.external_post_id, pp.captured_date desc
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
