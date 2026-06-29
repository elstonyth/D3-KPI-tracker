-- Owned Meta insights — 3 private tables + 2 status RPCs (2026-06-19).
-- Service-role write; owner/admin read via SECDEF RPCs. NO anon policy.

create table public.owned_profile_insight (
  id bigserial primary key,
  profile_id uuid not null references public.profile(id) on delete cascade,
  captured_date date not null default current_date,
  captured_at timestamptz not null default now(),
  platform text not null check (platform in ('instagram','facebook')),
  reach bigint, views bigint, accounts_engaged bigint, total_interactions bigint,
  page_engagements bigint, follower_delta bigint, follower_total bigint,
  raw jsonb,
  unique (profile_id, captured_date)
);
create table public.owned_audience_demographic (
  id bigserial primary key,
  profile_id uuid not null references public.profile(id) on delete cascade,
  captured_date date not null default current_date,
  dimension text not null check (dimension in ('age','gender','country','city')),
  bucket text not null,
  value bigint not null,
  unique (profile_id, captured_date, dimension, bucket)
);
create table public.owned_post_insight (
  id bigserial primary key,
  profile_id uuid not null references public.profile(id) on delete cascade,
  external_post_id text not null,
  captured_date date not null default current_date,
  captured_at timestamptz not null default now(),
  views bigint, reach bigint, saves bigint, interactions bigint,
  raw jsonb,
  unique (profile_id, external_post_id, captured_date)
);

create index owned_profile_insight_idx on public.owned_profile_insight (profile_id, captured_date desc);
create index owned_audience_demographic_idx on public.owned_audience_demographic (profile_id, captured_date desc);
create index owned_post_insight_idx on public.owned_post_insight (profile_id, captured_date desc);

alter table public.owned_profile_insight enable row level security;
alter table public.owned_audience_demographic enable row level security;
alter table public.owned_post_insight enable row level security;
-- No anon/authenticated policies => service-role only; reads via RPCs below.

-- Owner read: returns null when the caller does not own the profile.
create or replace function public.get_my_owned_insights(p_profile_id uuid, p_days int default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case
    when not exists (
      select 1 from public.profile_claim
      where user_id = (select auth.uid()) and profile_id = p_profile_id
    ) then null::jsonb
    else jsonb_build_object(
      'profile', (select coalesce(jsonb_agg(to_jsonb(t) order by t.captured_date), '[]'::jsonb)
        from (select captured_date, reach, views, accounts_engaged, total_interactions,
                     page_engagements, follower_delta, follower_total
              from public.owned_profile_insight
              where profile_id = p_profile_id and captured_date >= current_date - p_days) t),
      'demographics', (select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb)
        from (select dimension, bucket, value from public.owned_audience_demographic
              where profile_id = p_profile_id
                and captured_date = (select max(captured_date) from public.owned_audience_demographic
                                     where profile_id = p_profile_id)) d),
      'posts', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
        from (select external_post_id, views, reach, saves, interactions
              from public.owned_post_insight
              where profile_id = p_profile_id
                and captured_date = (select max(captured_date) from public.owned_post_insight
                                     where profile_id = p_profile_id)) p)
    )
  end;
$$;

-- Admin read: same shape, gated by is_admin().
create or replace function public.get_admin_owned_insights(p_profile_id uuid, p_days int default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when not public.is_admin() then null::jsonb
    else jsonb_build_object(
      'profile', (select coalesce(jsonb_agg(to_jsonb(t) order by t.captured_date), '[]'::jsonb)
        from (select captured_date, reach, views, accounts_engaged, total_interactions,
                     page_engagements, follower_delta, follower_total
              from public.owned_profile_insight
              where profile_id = p_profile_id and captured_date >= current_date - p_days) t),
      'demographics', (select coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb)
        from (select dimension, bucket, value from public.owned_audience_demographic
              where profile_id = p_profile_id
                and captured_date = (select max(captured_date) from public.owned_audience_demographic
                                     where profile_id = p_profile_id)) d),
      'posts', (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
        from (select external_post_id, views, reach, saves, interactions
              from public.owned_post_insight
              where profile_id = p_profile_id
                and captured_date = (select max(captured_date) from public.owned_post_insight
                                     where profile_id = p_profile_id)) p)
    )
  end;
$$;

revoke execute on function public.get_my_owned_insights(uuid, int)    from public, anon;
revoke execute on function public.get_admin_owned_insights(uuid, int) from public, anon;
grant  execute on function public.get_my_owned_insights(uuid, int)    to authenticated;
grant  execute on function public.get_admin_owned_insights(uuid, int) to authenticated;
