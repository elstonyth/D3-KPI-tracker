-- Public Storage bucket for persisted post thumbnails.
--
-- The scraper copies each post's cover image here AT SCRAPE TIME, while its
-- signed social-CDN URL is still valid, and stores the resulting permanent
-- Supabase URL in post_snapshot.media_url. This decouples thumbnail display
-- from the short-lived CDN signatures (TikTok ~24h, Meta ~3 days) that
-- previously caused the leaderboard images to 403 once expired.
--
-- public = true: objects are served from the unauthenticated
-- /storage/v1/object/public/post-media/... endpoint (CSP img-src already
-- allows https://*.supabase.co). Writes are service-role only and bypass RLS,
-- so no additional storage.objects policy is required for the hot path.
--
-- Idempotent: safe to re-run (e.g. CLI db reset).
insert into storage.buckets (id, name, public)
values ('post-media', 'post-media', true)
on conflict (id) do update set public = excluded.public;
