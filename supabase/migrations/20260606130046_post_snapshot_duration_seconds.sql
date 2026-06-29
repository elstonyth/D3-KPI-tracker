-- Cross-platform content de-duplication key: normalized video duration.
--
-- The leaderboard ranks individual post_snapshot rows, but a creator who
-- cross-posts one reel to IG/TikTok/FB/Douyin produces 2-4 rows (each platform
-- assigns its own external_post_id), so the same content takes multiple board
-- slots. The one signal that survives cross-posting is the VIDEO DURATION: it is
-- identical to the millisecond across every platform (captions get re-tailed per
-- platform and posted_at can straddle UTC midnight, so neither is reliable).
--
-- This column extracts that duration from `raw` and normalizes it to whole
-- seconds so readers can group on (creator_id, duration_seconds) cheaply WITHOUT
-- pulling the fat `raw` blob. STORED generated column => auto-backfills the 15k
-- existing rows and auto-populates every future scrape; no adapter code and no
-- manual backfill can drift from `raw`.
--
-- Per-platform source paths/units (verified against live clusters — same reel
-- yields the same whole-second value on every platform):
--   Instagram : raw->>'video_duration'                      seconds (float)
--   Facebook  : raw->'attachments'->0->>'video_length'      milliseconds
--   TikTok    : raw->'video'->>'duration'                   milliseconds
--   Douyin    : raw->'video'->>'duration'                   milliseconds
-- Image/carousel/text posts (no video) -> NULL; readers fall back to the
-- caption's first line, or leave the row un-merged.
--
-- Every branch is regex-guarded BEFORE the numeric cast so a malformed `raw`
-- value yields NULL instead of throwing and aborting the scrape's UPSERT. The
-- expression uses only immutable functions, as STORED generated columns require.
-- Additive + nullable => safe on live data (no existing read is affected).

alter table public.post_snapshot
  add column duration_seconds integer
  generated always as (
    (case
       when raw->>'video_duration' ~ '^[0-9]+(\.[0-9]+)?$'
         then round((raw->>'video_duration')::numeric)
       when raw#>>'{attachments,0,video_length}' ~ '^[0-9]+$'
         then round((raw#>>'{attachments,0,video_length}')::numeric / 1000)
       when raw#>>'{video,duration}' ~ '^[0-9]+$'
         then round((raw#>>'{video,duration}')::numeric / 1000)
       else null
     end)::integer
  ) stored;
