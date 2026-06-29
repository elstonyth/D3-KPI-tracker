-- Standalone verification for the Phase 0 windowed-metrics RPCs.
--
-- Runs entirely inside a transaction that is ROLLED BACK at the end, so it
-- touches no real data. Safe to run against any environment that already has
-- the RPCs applied (the migration 20260530000000_windowed_metrics_rpcs.sql).
--
-- Usage (pick one):
--   supabase db execute --file supabase/tests/windowed_metrics_verify.sql
--   psql "$DATABASE_URL" -f supabase/tests/windowed_metrics_verify.sql
--
-- It RAISES EXCEPTION on the first failed assertion (non-zero exit), prints
-- "ALL WINDOWED-METRICS ASSERTIONS PASSED" on success, then rolls back.

begin;

-- ---- Seed fixture (fixed UUIDs) ------------------------------------------
insert into public.creator (id, display_name)
values ('00000000-0000-0000-0000-0000000c0001','TEST Creator');

insert into public.profile (id, creator_id, platform, profile_url, handle)
values ('00000000-0000-0000-0000-0000000d0001',
        '00000000-0000-0000-0000-0000000c0001',
        'tiktok','https://tiktok.com/@test','test');

insert into public.profile_snapshot (profile_id, captured_date, followers) values
  ('00000000-0000-0000-0000-0000000d0001', current_date-40, 1000),
  ('00000000-0000-0000-0000-0000000d0001', current_date-7,  1100),
  ('00000000-0000-0000-0000-0000000d0001', current_date-0,  1200);

insert into public.post_snapshot
  (profile_id, external_post_id, captured_date, views, likes, comments, shares) values
  ('00000000-0000-0000-0000-0000000d0001','A', current_date-40, 1000,0,0,0),
  ('00000000-0000-0000-0000-0000000d0001','A', current_date-7,  4500,0,0,0),
  ('00000000-0000-0000-0000-0000000d0001','A', current_date-0,  5000,200,50,50),
  ('00000000-0000-0000-0000-0000000d0001','B', current_date-20, 500,0,0,0),
  ('00000000-0000-0000-0000-0000000d0001','B', current_date-0,  2000,100,20,30),
  ('00000000-0000-0000-0000-0000000d0001','C', current_date-0,  0,80,10,0);

-- ---- Assert creator_metrics_windowed across all 4 windows ----------------
do $$
declare
  r record;
  expected jsonb := jsonb_build_object(
    -- window -> [views_gained, followers_delta, post_count, insufficient(0/1)]
    '7d',       jsonb_build_array(2000, 100, 2, 0),
    '30d',      jsonb_build_array(6000, 200, 2, 0),
    '90d',      jsonb_build_array(7000, 0,   2, 1),
    'lifetime', jsonb_build_array(7000, 200, 2, 0)
  );
  w text;
  exp jsonb;
  cid uuid := '00000000-0000-0000-0000-0000000c0001';
begin
  foreach w in array array['7d','30d','90d','lifetime'] loop
    -- Scope via the creator_ids PARAM, not an outer WHERE: top_content applies
    -- its LIMIT inside the function, so an outer filter would drop our fixture
    -- rows behind the real creators. Same param style used consistently here.
    select * into r from public.creator_metrics_windowed(w, array[cid])
      where creator_id = cid;
    if not found then
      raise exception 'FAIL %: creator_metrics_windowed returned no row', w;
    end if;
    exp := expected -> w;

    -- IS DISTINCT FROM (not <>) so a NULL on either side counts as a mismatch
    -- and trips the assertion, instead of <> silently yielding NULL -> false-pass.
    if r.views_gained is distinct from (exp->>0)::bigint then
      raise exception 'FAIL %: views_gained = % (expected %)', w, r.views_gained, exp->>0;
    end if;
    if r.followers_delta is distinct from (exp->>1)::bigint then
      raise exception 'FAIL %: followers_delta = % (expected %)', w, r.followers_delta, exp->>1;
    end if;
    if r.post_count is distinct from (exp->>2)::int then
      raise exception 'FAIL %: post_count = % (expected %)', w, r.post_count, exp->>2;
    end if;
    if (r.insufficient)::int is distinct from (exp->>3)::int then
      raise exception 'FAIL %: insufficient = % (expected %)', w, r.insufficient, exp->>3;
    end if;
    -- primary_handle = the single profile's handle ('test'); it is the slug for
    -- /creators/<handle> links, so a regression here re-breaks creator links.
    if r.primary_handle is distinct from 'test' then
      raise exception 'FAIL %: primary_handle = % (expected test)', w, r.primary_handle;
    end if;
    -- engagement = (200+50+50 + 100+20+30) / (5000+2000) = 450/7000 = 0.0643.
    -- The 0-view post C contributes engagement 90 but is excluded entirely, so
    -- the numerator is exactly 450 (not 540). round() catches a leak; the
    -- numerator check below makes the guard self-documenting.
    if round(r.engagement, 4) is distinct from 0.0643 then
      raise exception 'FAIL %: engagement = % (expected 0.0643)', w, r.engagement;
    end if;
    if round(r.engagement * 7000) is distinct from 450 then
      raise exception 'FAIL %: engagement numerator = % (expected 450; 0-view post C must be excluded)', w, round(r.engagement * 7000);
    end if;
  end loop;

  -- ---- Assert top_content_windowed ranking + no-view exclusion -----------
  -- Top by 30d views_gained must be A(4000), then B(2000), then C(0). Scope via
  -- the creator_ids PARAM so the in-function LIMIT applies within our fixture
  -- (an outer WHERE would filter AFTER the limit had already kept real creators).
  if (select array_agg(external_post_id order by views_gained desc)
        from public.top_content_windowed('30d', 10, array[cid]))
     is distinct from array['A','B','C'] then
    raise exception 'FAIL top_content_windowed: ranking mismatch';
  end if;

  -- ---- Assert engagement = 0.0000 (NOT NULL) when views exist but zero
  -- interactions. Seed a second creator with a single viewed-but-silent post.
  insert into public.creator (id, display_name)
  values ('00000000-0000-0000-0000-0000000c0002','ZERO-ENG Creator');
  insert into public.profile (id, creator_id, platform, profile_url, handle)
  values ('00000000-0000-0000-0000-0000000d0002',
          '00000000-0000-0000-0000-0000000c0002',
          'tiktok','https://tiktok.com/@zero','zero');
  insert into public.post_snapshot
    (profile_id, external_post_id, captured_date, views, likes, comments, shares)
  values ('00000000-0000-0000-0000-0000000d0002','Z', current_date-0, 1000, 0, 0, 0);

  select * into r from public.creator_metrics_windowed('lifetime', array['00000000-0000-0000-0000-0000000c0002'::uuid])
    where creator_id = '00000000-0000-0000-0000-0000000c0002';
  if r.engagement is distinct from 0.0000 then
    raise exception 'FAIL zero-interaction: engagement = % (expected 0.0000, not NULL)', r.engagement;
  end if;

  -- ---- Assert bool_or insufficient: a creator with one mature profile AND one
  -- brand-new profile (no in-window baseline) must be insufficient = true, so
  -- the understated aggregate delta shows "Building history…" not a mature number.
  insert into public.creator (id, display_name)
  values ('00000000-0000-0000-0000-0000000c0003','MIXED Creator');
  insert into public.profile (id, creator_id, platform, profile_url, handle) values
    ('00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000c0003','tiktok','https://tiktok.com/@mix1','mix1'),
    ('00000000-0000-0000-0000-0000000d0004','00000000-0000-0000-0000-0000000c0003','instagram','https://instagram.com/mix2','mix2');
  insert into public.profile_snapshot (profile_id, captured_date, followers) values
    ('00000000-0000-0000-0000-0000000d0003', current_date-40, 500),   -- mature
    ('00000000-0000-0000-0000-0000000d0003', current_date-0,  600),
    ('00000000-0000-0000-0000-0000000d0004', current_date-0,  300);   -- new: no 30d baseline
  select * into r from public.creator_metrics_windowed('30d', array['00000000-0000-0000-0000-0000000c0003'::uuid])
    where creator_id = '00000000-0000-0000-0000-0000000c0003';
  if r.insufficient is distinct from true then
    raise exception 'FAIL bool_or: mixed-maturity creator 30d insufficient = % (expected true)', r.insufficient;
  end if;

  -- ---- Assert an unsupported window RAISES (fail-fast, not silent lifetime).
  begin
    perform * from public.creator_metrics_windowed('99d');
    raise exception 'FAIL: creator_metrics_windowed(''99d'') should have raised, but did not';
  exception
    when others then
      if sqlerrm not like 'invalid p_window%' then raise; end if;
  end;

  raise notice 'ALL WINDOWED-METRICS ASSERTIONS PASSED';
end $$;

rollback;
