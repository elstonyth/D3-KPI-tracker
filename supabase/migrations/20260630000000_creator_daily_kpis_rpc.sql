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
    -- LEFT JOIN so a creator with followers but no posts still returns the daily
    -- series (views default to 0) rather than an empty result.
    select f.day, f.followers_total, coalesce(v.views_total, 0) as views_total
    from foll f
    left join vw v on v.day = f.day
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
