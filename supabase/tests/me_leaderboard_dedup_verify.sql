-- Regression guard for the /me leaderboard duplicate-posts bug.
--
-- The creator leaderboard (apps/frontend/src/app/(creator)/me/leaderboard/page.tsx)
-- used to read raw post_snapshot rows with no dedup, so a post tracked over N
-- days appeared N times (once per daily snapshot). It now reads the shared
-- top_content_windowed RPC, which deduplicates to each post's LATEST snapshot.
-- This asserts that contract: one post with two daily snapshots yields exactly
-- ONE leaderboard row, carrying the latest snapshot's numbers (not a stale one).
--
-- Runs inside a transaction that is ROLLED BACK at the end — touches no real
-- data. Raises on the first failed assertion; prints success then rolls back.
--
-- Usage:
--   psql "$DATABASE_URL" -f supabase/tests/me_leaderboard_dedup_verify.sql
--   supabase db execute --file supabase/tests/me_leaderboard_dedup_verify.sql

begin;

insert into public.creator (id, display_name)
values ('00000000-0000-0000-0000-00000000ed01','LB-DEDUP Creator');

insert into public.profile (id, creator_id, platform, profile_url, handle)
values ('00000000-0000-0000-0000-00000000ed02',
        '00000000-0000-0000-0000-00000000ed01',
        'instagram','https://instagram.com/lbdedup','lbdedup');

-- ONE post, TWO daily snapshots. The bug listed both; the fix keeps only the
-- latest (5000 views / 300 likes), not the earlier (1000 / 50).
insert into public.post_snapshot
  (profile_id, external_post_id, captured_date, views, likes, comments, shares) values
  ('00000000-0000-0000-0000-00000000ed02','P', current_date-1, 1000,  50, 10, 5),
  ('00000000-0000-0000-0000-00000000ed02','P', current_date-0, 5000, 300, 150, 50);

do $$
declare
  row_count int;
  r record;
  pid uuid := '00000000-0000-0000-0000-00000000ed02';
begin
  -- Guard that the fixture actually reproduces the bug: the naive query the page
  -- USED to run (raw post_snapshot for the post) returns one row per daily
  -- snapshot — here 2. If this ever drops to 1, the fixture no longer exercises
  -- the dedup path and the assertion below would pass vacuously.
  select count(*) into row_count
    from public.post_snapshot
    where profile_id = pid and external_post_id = 'P';
  if row_count is distinct from 2 then
    raise exception 'FAIL fixture: expected 2 raw snapshots for post P (the bug input), got %', row_count;
  end if;

  -- Exactly the call /me leaderboard makes: lifetime window, scoped by
  -- p_profile_ids (the 4th RPC param — what getTopContentWindowed maps
  -- `profileIds` to), NOT p_creator_ids. Named params so the scoping is
  -- unambiguous and the test can't silently drift onto the wrong parameter.
  -- The LIMIT is applied inside the function, so an outer WHERE could drop the
  -- fixture row — scope via the param instead.
  select count(*) into row_count
    from public.top_content_windowed(
      p_window := 'lifetime', p_limit := 20, p_profile_ids := array[pid]);
  if row_count is distinct from 1 then
    raise exception 'FAIL dedup: top_content_windowed returned % rows for a 2-snapshot single post (expected 1)', row_count;
  end if;

  select * into r
    from public.top_content_windowed(
      p_window := 'lifetime', p_limit := 20, p_profile_ids := array[pid]);
  if r.external_post_id is distinct from 'P' then
    raise exception 'FAIL: unexpected post % (expected P)', r.external_post_id;
  end if;
  -- Latest snapshot wins — never the stale earlier row.
  if r.current_views is distinct from 5000 then
    raise exception 'FAIL: current_views = % (expected 5000, the latest snapshot — not 1000)', r.current_views;
  end if;
  if r.likes is distinct from 300 or r.comments is distinct from 150 or r.shares is distinct from 50 then
    raise exception 'FAIL: latest-snapshot interactions wrong (got likes=%, comments=%, shares=%; expected 300/150/50)', r.likes, r.comments, r.shares;
  end if;

  raise notice 'ME-LEADERBOARD DEDUP ASSERTIONS PASSED';
end $$;

rollback;
