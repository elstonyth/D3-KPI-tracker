-- Per-creator daily KPI series for the admin creator page.
-- One row per day for the last p_days (clamped 1..90): followers + views totals,
-- per-day deltas, and PER-METRIC baseline flags. Followers and views can start
-- on different days (a creator may have follower history before their first post
-- snapshot), so each metric carries its own *_insufficient flag — true on a day
-- with no prior-day baseline for THAT metric, where the "gain" would otherwise
-- be the opening cumulative rather than a real daily delta.
--
-- Followers carry forward across missed scrape days; views use MAX per post
-- (robust to a transient low re-scrape, like dashboard_view_totals_max_views).
-- Aggregated across the creator's profiles (rednote excluded).
--
-- Service-role only: a creator must never pull another creator's KPIs by id via
-- PostgREST. The admin page calls this through the service-role client.
drop function if exists public.creator_daily_kpis(uuid, int);

create function public.creator_daily_kpis(
  p_creator_id uuid,
  p_days int default 30
)
returns table (
  day date,
  followers_total bigint,
  followers_gained bigint,
  followers_insufficient boolean,
  views_total bigint,
  views_gained bigint,
  views_insufficient boolean
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
    -- views_total stays NULL on days with no post snapshot on-or-before them, so
    -- a metric that starts later is flagged insufficient instead of counting its
    -- opening cumulative as a daily gain. (Coalesce happens at output, for
    -- display only.)
    select d.day,
      sum((
        select max(ps.views) from public.post_snapshot ps
        where ps.profile_id = p.profile_id
          and ps.external_post_id = p.external_post_id
          and ps.captured_date <= d.day
      ))::bigint as views_total
    from days d cross join posts p
    group by d.day
  ),
  merged as (
    -- LEFT JOIN so a creator with followers but no posts still returns the daily
    -- series (views_total NULL -> shown as 0, flagged insufficient).
    select f.day, f.followers_total, v.views_total
    from foll f
    left join vw v on v.day = f.day
  )
  select
    day,
    followers_total,
    (followers_total - lag(followers_total) over w)::bigint as followers_gained,
    (lag(followers_total) over w) is null as followers_insufficient,
    coalesce(views_total, 0)::bigint as views_total,
    (views_total - lag(views_total) over w)::bigint as views_gained,
    (lag(views_total) over w) is null as views_insufficient
  from merged
  window w as (order by day)
  order by day
  offset 1;
$$;

revoke execute on function public.creator_daily_kpis(uuid, int) from public, anon, authenticated;
grant  execute on function public.creator_daily_kpis(uuid, int) to service_role;
