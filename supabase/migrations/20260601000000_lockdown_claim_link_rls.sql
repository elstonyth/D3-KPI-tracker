-- Access-control lockdown — close the AC-1 / AC-2 privilege-escalation holes.
-- See TODO_access-control.md (2026-06-01).
--
-- Background: Phase 3 made creators agency-managed and disabled self-service at
-- the API layer (/api/profiles* return 410). But the RLS layer still granted
-- authenticated users WRITE access to their own creator_link / profile_claim
-- rows, and those policies' WITH CHECK pinned only user_id — leaving
-- creator_id / claim_kind / profile_id attacker-controlled. Because PostgREST
-- is reachable directly with any creator's JWT + the public anon key (bypassing
-- the Next app + proxy.ts entirely), RLS is the ONLY control on that path.
--
-- AC-1: a creator could PATCH creator_link SET creator_id = <victim> and then
--       trigger PAID scrapes on the victim's profiles via /api/scrape (whose
--       ownership check is creator_link.creator_id == profile.creator_id).
-- AC-2: a creator could INSERT a profile_claim('owner') on any unowned profile,
--       re-enabling the self-service claim the API hard-disabled.
--
-- Fix: drop the three user-write policies. After this, only service_role
-- (admin provisioning / server actions, which bypass RLS) can write these
-- tables. The SELECT policies ("user reads own …") and the admin ALL policy on
-- profile_claim are intentionally kept, so /me still reads and admins still
-- manage.
--
-- Idempotent: drop ... if exists + create or replace.

-- AC-1 — creator_link is agency-managed; no authenticated write path remains.
drop policy if exists "user updates own creator_link" on public.creator_link;

-- AC-2 — claims are admin/service-role-provisioned only now.
drop policy if exists "user inserts own claims" on public.profile_claim;
drop policy if exists "user deletes own claims" on public.profile_claim;

-- Defense-in-depth backstop: even if a future migration re-adds an UPDATE
-- policy, forbid a non-admin authenticated session from repointing the
-- immutable creator_id FK. service_role calls (auth.uid() IS NULL) and admins
-- (is_admin()) pass through, so provisioning/reassignment still works.
create or replace function public.forbid_creator_link_creator_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     and not public.is_admin()
     and new.creator_id is distinct from old.creator_id then
    raise exception 'creator_id is agency-managed and cannot be changed by this user';
  end if;
  return new;
end;
$$;

drop trigger if exists creator_link_no_self_repoint on public.creator_link;
create trigger creator_link_no_self_repoint
  before update on public.creator_link
  for each row execute function public.forbid_creator_link_creator_change();
