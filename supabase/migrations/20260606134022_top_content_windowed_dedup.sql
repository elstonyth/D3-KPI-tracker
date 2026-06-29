-- Cross-platform content de-duplication inside top_content_windowed.
--
-- This RPC powers /me/leaderboard, the /me dashboard's Top content, and the
-- admin Top-30. It returned one row per (profile, post), so a creator who
-- cross-posts one reel to IG/TikTok/FB/Douyin saw it 2-4 times. This collapses
-- those copies to a single row — the highest-views_gained copy — and returns the
-- other platforms it ran on as `also_on` (for "also on" chips). Mirrors the
-- TypeScript dedup already shipped on the public leaderboard
-- (apps/frontend/src/lib/content-dedup.ts).
--
-- Same-content key = creator_id + whole-second video duration + caption hook
-- (first line, de-hashtagged). Duration alone over-merges — different videos
-- routinely share an exact-second length (verified: one creator had four
-- distinct 136s videos) — so the copy-pasted first caption line disambiguates
-- them. Captionless videos / no-duration images fall back to a per-row key so
-- nothing is wrongly fused. The collapse happens BEFORE the LIMIT, so the list
-- never renders short.
--
-- Return shape gains a 15th column (also_on text[]), so this DROPs + CREATEs
-- (CREATE OR REPLACE cannot change return type). search_path='', the AC-5 limit
-- clamp, the plpgsql/STABLE/use_column body, and the byte-identical signature
-- are preserved; EXECUTE grants are re-applied (a fresh CREATE resets them).

drop function if exists public.top_content_windowed(text, integer, uuid[], uuid[]);

create function public.top_content_windowed(
  p_window text default '30d', p_limit integer default 20,
  p_creator_ids uuid[] default null, p_profile_ids uuid[] default null
)
returns table (
  external_post_id text, profile_id uuid, creator_id uuid, creator_name text,
  platform text, handle text, caption_excerpt text, media_url text,
  posted_at timestamptz, views_gained bigint, current_views bigint,
  likes bigint, comments bigint, shares bigint, also_on text[]
) language plpgsql stable set search_path to '' as $$
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
      coalesce(pp.shares,0) as shares, pp.caption_excerpt, pp.media_url, pp.posted_at,
      pp.duration_seconds,
      -- Caption "hook": first line, cut at the first '#', whitespace-collapsed,
      -- lowered. Mirrors captionKey() in content-dedup.ts exactly.
      lower(btrim(regexp_replace(
        split_part(split_part(coalesce(pp.caption_excerpt,''), E'\n', 1), '#', 1),
        '\s+', ' ', 'g'))) as hook
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
  scored as (
    select cp.external_post_id, cp.profile_id, sp.creator_id, c.display_name as creator_name,
      sp.platform, sp.handle, cp.caption_excerpt, cp.media_url, cp.posted_at,
      greatest(coalesce(cp.cur_views,0) - coalesce(bp.base_views,0), 0)::bigint as views_gained,
      coalesce(cp.cur_views,0)::bigint as current_views,
      cp.likes::bigint as likes, cp.comments::bigint as comments, cp.shares::bigint as shares,
      -- Same-content key. Both signals required: duration alone over-merges,
      -- the hook alone can merge templated intros. Captionless video / no-duration
      -- image / neither -> per-row key (never merge). Mirrors contentKey().
      case
        when cp.duration_seconds is not null and length(cp.hook) > 0
          then 'd:' || sp.creator_id::text || '|' || cp.duration_seconds::text || '|' || cp.hook
        when cp.duration_seconds is not null
          then 'u:' || cp.profile_id::text || '|' || cp.external_post_id
        when length(cp.hook) > 0
          then 'c:' || sp.creator_id::text || '|' || cp.hook
        else 'u:' || cp.profile_id::text || '|' || cp.external_post_id
      end as ckey
    from cur_post cp
    join scope_profile sp on sp.id = cp.profile_id
    join public.creator c on c.id = sp.creator_id
    left join base_post bp on bp.profile_id = cp.profile_id and bp.external_post_id = cp.external_post_id
  ),
  -- Pick the representative (highest views_gained) copy per content group.
  ranked as (
    select s.*,
      row_number() over (
        partition by s.ckey
        order by s.views_gained desc, s.current_views desc, s.external_post_id
      ) as rn
    from scored s
  ),
  -- Platforms per content group (separate CTE: DISTINCT is unsupported in a
  -- window aggregate). Deterministic order makes also_on assertion-stable.
  groups as (
    select ckey, array_agg(distinct platform order by platform) as grp_platforms
    from scored group by ckey
  )
  select r.external_post_id, r.profile_id, r.creator_id, r.creator_name,
    r.platform, r.handle, r.caption_excerpt, r.media_url, r.posted_at,
    r.views_gained, r.current_views, r.likes, r.comments, r.shares,
    array_remove(g.grp_platforms, r.platform) as also_on
  from ranked r
  join groups g on g.ckey = r.ckey
  where r.rn = 1
  order by r.views_gained desc
  limit p_limit;
end;
$$;

grant execute on function public.top_content_windowed(text, integer, uuid[], uuid[])
  to anon, authenticated, service_role;
