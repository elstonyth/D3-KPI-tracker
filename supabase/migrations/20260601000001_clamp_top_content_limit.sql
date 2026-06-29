-- AC-5 — clamp top_content_windowed.p_limit.
-- See TODO_access-control.md (2026-06-01).
--
-- top_content_windowed is exposed to anon via PostgREST RPC; p_limit flowed
-- straight into LIMIT, so a direct call with p_limit => 10000000 forced an
-- unbounded sort/scan (query-amplification DoS). Clamp it inside the function
-- (the DB layer is authoritative — it cannot be bypassed by a direct RPC call).
--
-- This re-creates the function VERBATIM from
-- 20260530000000_windowed_metrics_rpcs.sql, adding ONLY the clamp line right
-- after the p_window guard. No other behavior changes.

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

  -- AC-5: hard upper bound so a direct anon RPC call can't request an unbounded
  -- LIMIT. Also floors at 1 and defaults a NULL to 20 (the column default).
  p_limit := least(greatest(coalesce(p_limit, 20), 1), 100);

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
