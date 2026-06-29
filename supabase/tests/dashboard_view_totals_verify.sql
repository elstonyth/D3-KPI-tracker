-- Standalone verification for dashboard_view_totals_windowed
-- (migration 20260604000000_dashboard_view_totals_windowed.sql).
--
-- SEMANTIC under test: per (creator × platform × window),
--   total_views(win) = Σ current views of posts PUBLISHED within the window
--   (posted_at >= today - N); lifetime = all posts. Content recency, NOT a
--   views-gained delta — independent of snapshot history depth.
--
-- Runs entirely inside a transaction that is ROLLED BACK at the end, so it
-- touches no real data. Safe against any environment that already has the RPC.
--
-- Usage (pick one):
--   supabase db execute --file supabase/tests/dashboard_view_totals_verify.sql
--   psql "$DATABASE_URL" -f supabase/tests/dashboard_view_totals_verify.sql
--
-- RAISES EXCEPTION on the first failed assertion (non-zero exit); prints
-- "ALL DASHBOARD-VIEW-TOTALS ASSERTIONS PASSED" on success, then rolls back.
-- Scopes the function via p_creator_ids so real rows don't pollute expectations.

begin;

-- ---- Fixture: creator A (full window matrix) -----------------------------
insert into public.creator (id, display_name)
values ('00000000-0000-0000-0000-0000000c0001','TEST Creator DVT A');

insert into public.profile (id, creator_id, platform, profile_url, handle) values
  ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000c0001',
   'tiktok','https://tiktok.com/@dvt-tt','dvt-tt'),
  ('00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000c0001',
   'instagram','https://instagram.com/dvt-ig','dvt-ig');

-- Rolling cutoffs (posted_at >= now() - interval). posted_at set now()-relative
-- with clear margins so the bucket boundaries don't depend on time-of-day.
-- tiktok:    A -2h(5000), B -20d(2000), C -200d(1000)
--            → 1d/1w=5000; 1m/3m/6m=7000; 12m/lifetime=8000
-- instagram: X -3d(800), Y -400d(300)
--            → 1d=0; 1w..12m=800; lifetime=1100
insert into public.post_snapshot
  (profile_id, external_post_id, captured_date, posted_at, views, likes, comments, shares) values
  ('00000000-0000-0000-0000-0000000d0001','A', current_date, now() - interval '2 hours',   5000,0,0,0),
  ('00000000-0000-0000-0000-0000000d0001','B', current_date, now() - interval '20 days',   2000,0,0,0),
  ('00000000-0000-0000-0000-0000000d0001','C', current_date, now() - interval '200 days',  1000,0,0,0),
  ('00000000-0000-0000-0000-0000000d0002','X', current_date, now() - interval '3 days',     800,0,0,0),
  ('00000000-0000-0000-0000-0000000d0002','Y', current_date, now() - interval '400 days',   300,0,0,0);

-- ---- Fixture: creator B (one fresh tiktok post) — proves per-creator split
insert into public.creator (id, display_name)
values ('00000000-0000-0000-0000-0000000c0002','TEST Creator DVT B');
insert into public.profile (id, creator_id, platform, profile_url, handle)
values ('00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000c0002',
        'tiktok','https://tiktok.com/@dvt-tt2','dvt-tt2');
insert into public.post_snapshot
  (profile_id, external_post_id, captured_date, posted_at, views, likes, comments, shares)
values ('00000000-0000-0000-0000-0000000d0003','Z', current_date, now() - interval '2 hours', 999,0,0,0);

do $$
declare
  cidA uuid := '00000000-0000-0000-0000-0000000c0001';
  cidB uuid := '00000000-0000-0000-0000-0000000c0002';
  expected jsonb := jsonb_build_object(
    'tiktok',    jsonb_build_object('1d',5000,'1w',5000,'1m',7000,'3m',7000,'6m',7000,'12m',8000,'lifetime',8000),
    'instagram', jsonb_build_object('1d',0,   '1w',800, '1m',800, '3m',800, '6m',800, '12m',800, 'lifetime',1100)
  );
  plat text;
  w text;
  exp bigint;
  got bigint;
begin
  -- Creator A: full per-(platform, window) matrix, scoped to A only.
  for plat in select jsonb_object_keys(expected) loop
    foreach w in array array['1d','1w','1m','3m','6m','12m','lifetime'] loop
      exp := ((expected -> plat) ->> w)::bigint;
      select total_views into got
        from public.dashboard_view_totals_windowed(array[cidA])
        where creator_id = cidA and platform = plat and win = w;
      -- Missing row (got IS NULL) means the UI would misread the cell — IS
      -- DISTINCT FROM catches both wrong values AND absent rows.
      if got is distinct from exp then
        raise exception 'FAIL A %/%: total_views = % (expected %)',
          plat, w, coalesce(got::text,'<no row>'), exp;
      end if;
    end loop;
  end loop;

  -- instagram/1d MUST be present as an explicit 0 (no IG post within 1 day).
  if (select count(*) from public.dashboard_view_totals_windowed(array[cidA])
        where creator_id = cidA and platform='instagram' and win='1d' and total_views = 0) <> 1 then
    raise exception 'FAIL: instagram/1d must be a single explicit 0 row';
  end if;

  -- Platforms with no seeded posts under creator A yield NO rows.
  if exists (
    select 1 from public.dashboard_view_totals_windowed(array[cidA])
    where creator_id = cidA and platform in ('facebook','douyin')
  ) then
    raise exception 'FAIL: unexpected facebook/douyin row for creator A';
  end if;

  -- Per-creator separation: querying A+B returns BOTH creators as distinct rows,
  -- and creator B's tiktok totals are its own (999 across every window).
  if (select count(distinct creator_id)
        from public.dashboard_view_totals_windowed(array[cidA, cidB])) <> 2 then
    raise exception 'FAIL: expected 2 distinct creators in the result';
  end if;
  select total_views into got
    from public.dashboard_view_totals_windowed(array[cidA, cidB])
    where creator_id = cidB and platform='tiktok' and win='1d';
  if got is distinct from 999 then
    raise exception 'FAIL B tiktok/1d: total_views = % (expected 999)', coalesce(got::text,'<no row>');
  end if;
  select total_views into got
    from public.dashboard_view_totals_windowed(array[cidA, cidB])
    where creator_id = cidB and platform='tiktok' and win='lifetime';
  if got is distinct from 999 then
    raise exception 'FAIL B tiktok/lifetime: total_views = % (expected 999)', coalesce(got::text,'<no row>');
  end if;

  raise notice 'ALL DASHBOARD-VIEW-TOTALS ASSERTIONS PASSED';
end $$;

rollback;
