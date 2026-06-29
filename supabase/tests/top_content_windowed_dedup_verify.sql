-- Regression guard for cross-platform content de-duplication in the
-- top_content_windowed RPC (migration 20260606134022_top_content_windowed_dedup).
--
-- A creator who cross-posts one reel to several platforms used to get one
-- leaderboard row per platform. The RPC now collapses copies of the same content
-- — keyed on (creator_id, video duration, caption hook) — to the highest-views
-- copy, exposing the other platforms as `also_on`. This asserts that contract,
-- plus the two ways the key must NOT over-merge.
--
-- duration_seconds is a GENERATED column, so the fixtures set it indirectly via
-- raw {"video_duration": 100} (the Instagram extraction path → 100s).
--
-- Runs inside a transaction that is ROLLED BACK — touches no real data. Raises on
-- the first failed assertion; prints success then rolls back.
--
-- Usage:
--   psql "$DATABASE_URL" -f supabase/tests/top_content_windowed_dedup_verify.sql
--   supabase db execute --file supabase/tests/top_content_windowed_dedup_verify.sql

begin;

insert into public.creator (id, display_name)
values ('00000000-0000-0000-0000-0000000fcd01','FC-DEDUP Creator');

insert into public.profile (id, creator_id, platform, profile_url, handle) values
  ('00000000-0000-0000-0000-0000000fcd02','00000000-0000-0000-0000-0000000fcd01','facebook', 'https://facebook.com/fcd','fcd_fb'),
  ('00000000-0000-0000-0000-0000000fcd03','00000000-0000-0000-0000-0000000fcd01','instagram','https://instagram.com/fcd','fcd_ig'),
  ('00000000-0000-0000-0000-0000000fcd04','00000000-0000-0000-0000-0000000fcd01','tiktok',   'https://tiktok.com/@fcd','fcd_tt');

insert into public.post_snapshot
  (profile_id, external_post_id, views, caption_excerpt, raw) values
  -- VideoA: ONE reel cross-posted to FB/IG/TikTok. Same hook ('alpha hook') +
  -- same duration (100s) despite per-platform caption tails. FB has the most views.
  ('00000000-0000-0000-0000-0000000fcd02','A_fb',5000,'alpha hook'||E'\n'||'body text','{"video_duration":100}'),
  ('00000000-0000-0000-0000-0000000fcd03','A_ig',3000,'alpha hook #tag1 #tag2',          '{"video_duration":100}'),
  ('00000000-0000-0000-0000-0000000fcd04','A_tt',1000,'alpha hook #x',                    '{"video_duration":100}'),
  -- VideoB: SAME 100s duration, DIFFERENT hook -> must stay a separate row.
  ('00000000-0000-0000-0000-0000000fcd02','B_fb',4000,'beta hook',                        '{"video_duration":100}'),
  -- Two captionless videos, SAME 100s duration -> must stay separate (no hook to
  -- prove they are the same content).
  ('00000000-0000-0000-0000-0000000fcd03','C_ig', 200,null,                               '{"video_duration":100}'),
  ('00000000-0000-0000-0000-0000000fcd04','C_tt', 100,null,                               '{"video_duration":100}'),
  -- Two NO-duration posts (images: raw carries no duration field) with the SAME
  -- hook -> must stay separate. Hook alone must not merge without a duration
  -- signal (else unrelated posts sharing an intro line over-merge).
  ('00000000-0000-0000-0000-0000000fcd02','D_fb',  50,'gamma hook',    '{}'),
  ('00000000-0000-0000-0000-0000000fcd03','D_ig',  40,'gamma hook #x', '{}');

do $$
declare
  total int;
  r record;
  cid uuid := '00000000-0000-0000-0000-0000000fcd01';
begin
  -- Fixture guard: 8 raw post rows exist (the un-deduped input).
  select count(*) into total
    from public.post_snapshot ps join public.profile p on p.id = ps.profile_id
    where p.creator_id = cid;
  if total is distinct from 8 then
    raise exception 'FAIL fixture: expected 8 raw post rows, got %', total;
  end if;

  -- Collapse: 8 posts -> 6 content groups (VideoA ×3 -> 1; VideoB; two captionless
  -- videos; two no-duration images — the last four never merge).
  select count(*) into total from public.top_content_windowed(
    p_window := 'lifetime', p_limit := 50, p_creator_ids := array[cid]);
  if total is distinct from 6 then
    raise exception 'FAIL collapse: expected 6 deduped rows, got %', total;
  end if;

  -- VideoA collapses to the highest-views copy (FB / 5000), other platforms in also_on.
  select * into r from public.top_content_windowed(
    p_window := 'lifetime', p_limit := 50, p_creator_ids := array[cid])
    where external_post_id = 'A_fb';
  if not found then
    raise exception 'FAIL: VideoA representative A_fb missing (wrong copy kept or row dropped)';
  end if;
  if r.platform is distinct from 'facebook' or r.current_views is distinct from 5000 then
    raise exception 'FAIL: VideoA rep wrong (platform=%, views=%; expected facebook/5000)', r.platform, r.current_views;
  end if;
  if r.also_on is distinct from array['instagram','tiktok'] then
    raise exception 'FAIL: VideoA also_on = % (expected {instagram,tiktok})', r.also_on;
  end if;

  -- The non-representative copies must NOT survive as their own rows.
  perform 1 from public.top_content_windowed(
    p_window := 'lifetime', p_limit := 50, p_creator_ids := array[cid])
    where external_post_id in ('A_ig','A_tt');
  if found then
    raise exception 'FAIL: a non-representative VideoA copy leaked as its own row';
  end if;

  -- Over-merge guard: VideoB (same duration, different hook) stays separate.
  select * into r from public.top_content_windowed(
    p_window := 'lifetime', p_limit := 50, p_creator_ids := array[cid])
    where external_post_id = 'B_fb';
  if not found then
    raise exception 'FAIL over-merge: VideoB (same 100s duration, different hook) wrongly merged into VideoA';
  end if;
  if coalesce(array_length(r.also_on, 1), 0) is distinct from 0 then
    raise exception 'FAIL: VideoB also_on should be empty, got %', r.also_on;
  end if;

  -- Captionless guard: two captionless same-duration videos stay separate.
  select count(*) into total from public.top_content_windowed(
    p_window := 'lifetime', p_limit := 50, p_creator_ids := array[cid])
    where external_post_id in ('C_ig','C_tt');
  if total is distinct from 2 then
    raise exception 'FAIL captionless: expected 2 separate captionless rows, got %', total;
  end if;

  -- No-duration guard: two no-duration posts sharing a hook stay separate (the
  -- hook alone must not merge without a duration signal).
  select count(*) into total from public.top_content_windowed(
    p_window := 'lifetime', p_limit := 50, p_creator_ids := array[cid])
    where external_post_id in ('D_fb','D_ig');
  if total is distinct from 2 then
    raise exception 'FAIL no-duration: expected 2 separate no-duration rows, got %', total;
  end if;

  raise notice 'TOP-CONTENT-WINDOWED DEDUP ASSERTIONS PASSED';
end $$;

rollback;
