-- Verify creator_daily_kpis: carry-forward (gap day), MAX views (transient dip),
-- multi-profile aggregation, per-day deltas. Seeds, asserts, rolls back.
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
  -- day-2: followers 110+205=315 (delta +15 from 300); views 1500+700=2200 (delta +700 from 1500)
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c1', 3) where day = current_date - 2;
  assert r.followers_total  = 315, 'followers_total d-2 expected 315 got '|| coalesce(r.followers_total::text,'null');
  assert r.followers_gained = 15,  'followers_gained d-2 expected 15 got '|| coalesce(r.followers_gained::text,'null');
  assert r.views_gained     = 700, 'views_gained d-2 expected 700 got '|| coalesce(r.views_gained::text,'null');
  assert r.insufficient = false,   'd-2 should have a baseline';

  -- day-1: P1 followers carried 110 -> 110+210=320 (delta +5); views MAX(A)=1500 + carry(B)=700 = 2200 (delta 0)
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c1', 3) where day = current_date - 1;
  assert r.followers_total  = 320, 'followers_total d-1 expected 320 (carry P1=110) got '|| coalesce(r.followers_total::text,'null');
  assert r.followers_gained = 5,   'followers_gained d-1 expected 5';
  assert r.views_total      = 2200,'views_total d-1 expected 2200 (MAX ignores 1400, carry B=700)';
  assert r.views_gained     = 0,   'views_gained d-1 expected 0';

  -- day0: followers 130+220=350 (delta +30); views 1600+900=2500 (delta +300)
  select * into r from public.creator_daily_kpis('00000000-0000-0000-0000-0000000000c1', 3) where day = current_date;
  assert r.followers_gained = 30,  'followers_gained d0 expected 30';
  assert r.views_gained     = 300, 'views_gained d0 expected 300';

  raise notice 'creator_daily_kpis verify: ALL PASS';
end $$;

rollback;
