-- Function privilege & search_path hardening (DB review 2026-06-06).
--
-- Clears two Supabase linter classes, both on functions. No data change.
-- Idempotent: REVOKE and ALTER ... SET are no-ops if re-run.
--
-- 1. anon/authenticated_security_definer_function_executable
--    Three SECURITY DEFINER functions carried the default PUBLIC execute grant,
--    so they were callable directly via PostgREST (/rest/v1/rpc/<fn>):
--      - handle_new_auth_user()            — auth.users trigger fn, never a public RPC
--      - forbid_creator_link_creator_change() — creator_link trigger fn, ditto
--      - is_admin()                        — RLS helper
--    Triggers still fire after REVOKE (trigger execution is NOT gated by the
--    EXECUTE privilege), so this only removes the direct-call attack surface.
--    is_admin() keeps EXECUTE for `authenticated` because RLS policies and the
--    scrape/backfill routes (cookie-aware, authenticated client) call it; the
--    logged-out path returns 401 before reaching it, so anon never needs it.
--
-- 2. function_search_path_mutable
--    The three windowed read RPCs had a role-mutable search_path. Their bodies
--    are already fully public.-qualified (everything else is pg_catalog), so
--    pinning search_path = '' is behaviour-preserving and matches what the
--    SECURITY DEFINER functions already do.

-- 1. Remove direct-RPC execute surface on SECURITY DEFINER functions.
revoke execute on function public.handle_new_auth_user()               from public, anon, authenticated;
revoke execute on function public.forbid_creator_link_creator_change() from public, anon, authenticated;
revoke execute on function public.is_admin()                           from public, anon;

-- 2. Pin search_path on the windowed read RPCs.
alter function public.top_content_windowed(text, integer, uuid[], uuid[]) set search_path = '';
alter function public.creator_metrics_windowed(text, uuid[], uuid[])      set search_path = '';
alter function public.dashboard_view_totals_windowed(uuid[])             set search_path = '';
