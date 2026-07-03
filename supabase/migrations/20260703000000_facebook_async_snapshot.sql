-- Facebook async trigger-then-collect state.
--
-- Bright Data's FB posts collector can take minutes (sometimes stalls past the
-- 240s in-adapter budget), which blocked one cron function per FB profile and
-- falsely stamped it 'failed' on timeout. The cron now TRIGGERS the snapshot on
-- one tick and COLLECTS it on a later tick, so no single invocation waits on the
-- slow job. These two columns hold the in-flight job between ticks:
--   fb_snapshot_id           — the Bright Data snapshot_id to poll/collect; NULL
--                              when no FB job is pending for this profile.
--   fb_snapshot_triggered_at — when it was triggered; used to expire a stalled
--                              job (still 'building' after hours) so it can be
--                              re-triggered instead of blocking the slot forever.
-- Only Facebook profiles ever set these; NULL for every other platform.

alter table public.profile
  add column if not exists fb_snapshot_id text,
  add column if not exists fb_snapshot_triggered_at timestamptz;

comment on column public.profile.fb_snapshot_id is
  'Bright Data snapshot_id for an in-flight async Facebook scrape (trigger-then-collect). NULL when no job is pending.';
comment on column public.profile.fb_snapshot_triggered_at is
  'When the in-flight Facebook snapshot was triggered; used to expire stalled jobs.';

-- The collect pass reads only the (few) rows with a pending job. A partial index
-- keeps that lookup cheap and stays tiny (one entry per in-flight FB scrape).
create index if not exists profile_fb_snapshot_pending_idx
  on public.profile (fb_snapshot_triggered_at)
  where fb_snapshot_id is not null;
