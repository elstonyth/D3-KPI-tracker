-- Allow TikTok rows in owned_profile_insight (Meta spec restricted it to ig/fb).
alter table public.owned_profile_insight drop constraint owned_profile_insight_platform_check;
alter table public.owned_profile_insight add constraint owned_profile_insight_platform_check
  check (platform in ('instagram','facebook','tiktok'));
