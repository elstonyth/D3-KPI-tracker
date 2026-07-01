-- Verify creator_daily_kpis: carry-forward (gap day), MAX views (transient dip),
-- multi-profile aggregation, per-day deltas, per-metric baseline flags. Seeds,
-- asserts, rolls back.
begin;

insert into public.creator (id, display_name)
values ('00000000-0000-0000-0000-0000000000c1', 'KPI Test Creator');

insert into public.profile (id, creator_id, platform, profile_url) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'instagram', 'https://instagram.com/kpitest1'),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c1', 'tiktok',    'https://tiktok.com/@kpitest2');

-- Followers. P1 has a GAP on day-1 (carry-forward 110 expected). P2 daily.
insert into public.profile_snapshot (profile_id, captured_date, followers) values
  ('00000000-0000-0000-0000-0000000000a1', current_date - 3, 100),
  ('00000000-0000-0000-0000-0000000000a1', current_date - 2, 110),
  ('00000000-0000-0000-0000-0000000000a1', current_date,     130),
  ('00000000-0000-0000-0000-0000000000a2', current_date - 3, 200),
  ('00000000-0000-0000-0000-0000000000a2', current_date - 2, 205),
  ('00000000-0000-0000-0000-0000000000a2', current_date - 1, 210),
  ('00000000-0000-0000-0000-0000000000a2', current_date,     220);

-- Post views. Post A day-1 dips to 1400 (transient) -> MAX must keep 1500.
-- Post B has a gap on day-1 (carry-forward 700 expected).
insert into public.post_snapshot (profile_id, external_post_id, captured_date, views) values
  ('00000000-0000-0000-0000-0000000000a1', 'A', current_date - 3, 1000),
  ('00000000-0000-0000-0000-0000000000a1', 'A', current_date - 2, 1500),
  ('00000000-0000-0000-0000-0000000000a1', 'A', current_date - 1, 1400),
  ('00000000-0000-0000-0000-0000000000a1', 'A', current_date,     1600),
  ('00000000-0000-0000-0000-0000000000a2', 'B', current_date - 3, 500),
  ('00000000-0000-0000-0000-0000000000a2', 'B', current_date - 2, 700),
  ('00000000-0000-0000-0000-0000000000a2', 'B', current_date,     900);

do $$
declare r record;
begin
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c1', 3) where day = current_date - 2;
  assert r.followers_total  = 315, 'followers_total d-2 expected 315 got '|| coalesce(r.followers_total::text,'null');
  assert r.followers_gained = 15,  'followers_gained d-2 expected 15';
  assert r.views_gained     = 700, 'views_gained d-2 expected 700';
  assert r.followers_insufficient = false, 'd-2 followers should have a baseline';
  assert r.views_insufficient = false,     'd-2 views should have a baseline';

  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c1', 3) where day = current_date - 1;
  assert r.followers_total  = 320, 'followers_total d-1 expected 320 (carry P1=110)';
  assert r.followers_gained = 5,   'followers_gained d-1 expected 5';
  assert r.views_total      = 2200,'views_total d-1 expected 2200 (MAX ignores 1400)';
  assert r.views_gained     = 0,   'views_gained d-1 expected 0';

  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c1', 3) where day = current_date;
  assert r.followers_gained = 30,  'followers_gained d0 expected 30';
  assert r.views_gained     = 300, 'views_gained d0 expected 300';
  raise notice 'creator_daily_kpis verify: ALL PASS';
end $$;

-- Followers-only creator (no posts at all): still returns a full series, views
-- shown as 0 and flagged insufficient (no view baseline ever).
insert into public.creator (id, display_name)
values ('00000000-0000-0000-0000-0000000000c2', 'Followers Only Creator');
insert into public.profile (id, creator_id, platform, profile_url) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c2', 'instagram', 'https://instagram.com/fonly');
insert into public.profile_snapshot (profile_id, captured_date, followers) values
  ('00000000-0000-0000-0000-0000000000b1', current_date - 3, 700),
  ('00000000-0000-0000-0000-0000000000b1', current_date - 2, 720),
  ('00000000-0000-0000-0000-0000000000b1', current_date - 1, 735),
  ('00000000-0000-0000-0000-0000000000b1', current_date,     760);

do $$
declare r record; n int;
begin
  select count(*) into n from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c2', 3);
  assert n = 3, 'followers-only creator should return 3 rows, got '|| n;
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c2', 3) where day = current_date;
  assert r.followers_total  = 760,  'fonly followers_total d0 expected 760';
  assert r.followers_gained = 25,   'fonly followers_gained d0 expected 25';
  assert r.views_total      = 0,    'fonly views_total d0 expected 0 (no posts)';
  assert r.views_gained is null,    'fonly views_gained d0 expected null (no view baseline)';
  assert r.views_insufficient = true, 'fonly views_insufficient d0 expected true';
  raise notice 'creator_daily_kpis followers-only: PASS';
end $$;

-- Views start LATER than followers: follower history exists before the first
-- post snapshot. The first post day must be flagged views_insufficient (its
-- opening cumulative is not a daily gain) WITHOUT flagging followers.
insert into public.creator (id, display_name)
values ('00000000-0000-0000-0000-0000000000c3', 'Views Start Later Creator');
insert into public.profile (id, creator_id, platform, profile_url) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3', 'instagram', 'https://instagram.com/late');
insert into public.profile_snapshot (profile_id, captured_date, followers) values
  ('00000000-0000-0000-0000-0000000000d1', current_date - 3, 1020),
  ('00000000-0000-0000-0000-0000000000d1', current_date - 2, 1030),
  ('00000000-0000-0000-0000-0000000000d1', current_date - 1, 1040),
  ('00000000-0000-0000-0000-0000000000d1', current_date,     1050);
-- First post snapshot only on day-1 and day0.
insert into public.post_snapshot (profile_id, external_post_id, captured_date, views) values
  ('00000000-0000-0000-0000-0000000000d1', 'P', current_date - 1, 8000),
  ('00000000-0000-0000-0000-0000000000d1', 'P', current_date,     9000);

do $$
declare r record;
begin
  -- First post day: followers have a baseline, views do NOT.
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c3', 3) where day = current_date - 1;
  assert r.followers_insufficient = false, 'c3 d-1 followers_insufficient expected false';
  assert r.followers_gained = 10,          'c3 d-1 followers_gained expected 10';
  assert r.views_insufficient = true,      'c3 d-1 views_insufficient expected true (first post day)';
  assert r.views_gained is null,           'c3 d-1 views_gained expected null (opening cumulative, not a gain)';
  assert r.views_total = 8000,             'c3 d-1 views_total expected 8000';

  -- Next day: a real view delta exists.
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c3', 3) where day = current_date;
  assert r.views_insufficient = false, 'c3 d0 views_insufficient expected false';
  assert r.views_gained = 1000,        'c3 d0 views_gained expected 1000';
  raise notice 'creator_daily_kpis views-start-later: PASS';
end $$;

rollback;
