-- Owned-accounts OAuth — token store + status RPCs (2026-06-18).
-- Ciphertext stored as base64 TEXT (AES-256-GCM done app-side) to avoid
-- bytea/PostgREST encoding friction. Table is service-role only: no anon/
-- authenticated policies, so token columns never reach a browser. Status is
-- exposed via SECURITY DEFINER RPCs that return NO token columns.

-- 1. Allow 'oauth' provenance on profile_claim (owner claims created at connect).
alter table public.profile_claim drop constraint profile_claim_claimed_via_check;
alter table public.profile_claim add constraint profile_claim_claimed_via_check
  check (claimed_via in ('manual','auto_discovery','admin_assigned','oauth'));

-- 2. Token store.
create table public.oauth_connection (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id)     on delete cascade,
  profile_id          uuid not null references public.profile(id) on delete cascade,
  platform            text not null check (platform in ('instagram','facebook','tiktok')),
  external_account_id text not null,
  account_name        text,
  scopes              text,
  access_ct           text not null,
  access_iv           text not null,
  access_tag          text not null,
  refresh_ct          text,
  refresh_iv          text,
  refresh_tag         text,
  access_expires_at   timestamptz,
  refresh_expires_at  timestamptz,
  status              text not null default 'active' check (status in ('active','revoked','expired')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  last_refreshed_at   timestamptz,
  unique (user_id, platform, external_account_id)
);

create index oauth_connection_user_idx    on public.oauth_connection (user_id);
create index oauth_connection_profile_idx on public.oauth_connection (profile_id);

create trigger oauth_connection_updated_at before update on public.oauth_connection
  for each row execute function public.set_updated_at();

alter table public.oauth_connection enable row level security;
-- No policies for anon/authenticated => service_role only.

-- 3. Caller's own connection status (safe columns only).
create or replace function public.get_my_oauth_connections()
returns table (
  id uuid, platform text, account_name text, status text,
  access_expires_at timestamptz, refresh_expires_at timestamptz, created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.platform, c.account_name, c.status,
         c.access_expires_at, c.refresh_expires_at, c.created_at
  from public.oauth_connection c
  where c.user_id = (select auth.uid())
  order by c.created_at desc
$$;

-- 4. Admin view of all connection status (gated by is_admin()).
create or replace function public.get_admin_oauth_connections(p_creator_id uuid default null)
returns table (
  creator_id uuid, display_name text, platform text, account_name text,
  status text, access_expires_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select cr.id, cr.display_name, c.platform, c.account_name, c.status, c.access_expires_at
  from public.oauth_connection c
  join public.profile p on p.id = c.profile_id
  join public.creator cr on cr.id = p.creator_id
  where public.is_admin()
    and (p_creator_id is null or cr.id = p_creator_id)
  order by cr.display_name, c.platform
$$;

-- 5. Grants: mirror the windowed-RPC hardening. Both are SECURITY DEFINER with
--    pinned search_path; revoke the default PUBLIC execute, grant authenticated.
revoke execute on function public.get_my_oauth_connections()       from public, anon;
revoke execute on function public.get_admin_oauth_connections(uuid) from public, anon;
grant  execute on function public.get_my_oauth_connections()       to authenticated;
grant  execute on function public.get_admin_oauth_connections(uuid) to authenticated;
