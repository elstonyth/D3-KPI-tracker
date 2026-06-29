# TODO — Access Control & Privilege-Escalation Map (D3 Creator)

> **Generated:** 2026-06-01 · **Scope:** access-control + authorization rules across the three dashboards (public / creator-`/me` / admin), with emphasis on **preventing a user from reaching data or actions above their tier**.
>
> **Companion to `TODO_data-validator.md`** (authored separately, concurrently): that file covers the **input-validation** surface (login, provisioning fields, UUID/format checks, rate-limit helper). This file covers **access control / authorization** and is intentionally non-overlapping — overlaps are cross-referenced, not duplicated.
>
> **Method:** grounded in the live codebase (migrations/RLS, route handlers, server actions, layouts, `proxy.ts`). Load-bearing facts verified against git history + the installed dependency tree. Severity: 🔴 critical · 🟠 high · 🟡 medium · 🟢 low/info.

---

## ✅ Validation status — 2026-06-01 (local Supabase, branch `feat/data-validator-hardening`)

**Implemented + validated locally (NOT yet pushed to remote/prod):**
- **AC-1 / AC-2 — DONE.** Migration `supabase/migrations/20260601000000_lockdown_claim_link_rls.sql`: drops `"user updates own creator_link"`, `"user inserts own claims"`, `"user deletes own claims"`; adds backstop trigger `creator_link_no_self_repoint`.
- **AC-5 — DONE.** Migration `supabase/migrations/20260601000001_clamp_top_content_limit.sql`: re-creates `top_content_windowed` with `p_limit := least(greatest(coalesce(p_limit,20),1),100)`. Verified **byte-identical to the original except the clamp** (no leaderboard regression).

**How validated:**
- `supabase db reset` → all 12 migrations apply cleanly (idempotent: `drop … if exists` + `create or replace`).
- DB policy inventory confirms the 3 user-write policies are gone; SELECT + `admin manages claims` + the trigger remain.
- **Authoritative RLS integration test** `supabase/tests/access-control-rls.mjs` — **15/15 PASS** against the live local stack, exercising the real attack path (creator JWT → PostgREST direct, the path the Next app/proxy can't mediate): AC-1 update no-op + value unchanged, AC-2 insert denied (RLS error), AC-2b delete no-op + victim claim intact, own-row reads still work, cross-user reads scoped out, service-role provisioning still works, AC-5 clamp (10M→100, −5→1, 5→5, bad window raises).
- Existing unit suite: **50/50 PASS** (9 suites; no regression).

**Deferred (correctly — see EXP-1):** the `raw` revoke is NOT low-risk; the public pages read `raw` via the anon client, so it needs a column-extraction refactor first. Track separately.

**Not run:** Playwright e2e — not installed, and the fix is DB-layer (the exploit is a direct API call, not a browser flow), so the supabase-js integration test above is the authoritative coverage. Browser routing is enforced by `proxy.ts`, which this change does not touch.

**Next step to ship:** review the two migrations → `supabase db push` to remote after the branch merges.

---

## Context

### Stack & enforcement points
- **Next.js 16** (`next@16.2.6`) App Router. **`apps/frontend/src/proxy.ts` is the active edge middleware** — Next 16 renamed the `middleware.ts` convention to `proxy.ts` (commit `9d71417a`). It refreshes the Supabase session cookie, redirects anon off `/admin`+`/me`, and confines admins to `/admin`. *(Anyone expecting a `middleware.ts` file: there isn't one and shouldn't be — that's the deprecated name.)*
- **Layouts** re-run `getAuthContext()` as a second gate (`(admin)` → `requireAdmin`; `(creator)` → session required).
- **Server actions** each re-check `requireAdmin()` (independently POST-invokable, so this is mandatory).
- **Route handlers** self-authenticate (`getUser` + ownership, or `Bearer CRON_SECRET`).
- **Supabase RLS** is the only control on **direct PostgREST/RPC** calls (proxy + layouts do not see them). Two clients: anon/publishable (RLS-enforced) and service-role (`getSupabaseAdmin`, **bypasses RLS** — trusted server only).

### Tier ↔ codebase map (request labels differ from the code)
| Request label | Codebase tier | Routes | Auth role | "Own data only"? |
|---|---|---|---|---|
| **public** (anyone) | public | `(public)`: `/`, `/dashboard`, `/leaderboard`, `/creators/[id]`, `/creators/[id]/[platform]` | none | — |
| **user** (own data only) | **creator** | `(creator)`: `/me`, `/me/leaderboard`, `/me/account` | `creator` | yes (UI-scoped only) |
| **creator** (elevated) | **admin** | `(admin)`: `/admin`, `/admin/profiles` | `admin` | no (sees all) |

Binding: `user_role(user_id, role)` + `creator_link(user_id, creator_id)`. Public signup is killed; provisioning is admin-only (`/api/profiles*` → `410`).

### Trust model — read first (it reframes "own data only")
- **All five core tables (`client`, `creator`, `profile`, `profile_snapshot`, `post_snapshot`) are world-readable** — RLS is `for select to anon, authenticated using (true)` (D3 is a public showcase). So **"user sees own data only" is a UI/UX convenience, NOT a confidentiality boundary** — any visitor can read any creator's metrics. This doc therefore protects **write/action integrity** and **scrape cost**, plus the one genuine read leak (`EXP-1`).
- Sensitive tables **are** correctly scoped (own-row + `is_admin()`): `user_role`, `creator_link`, `admin_email`, `profile_claim`.

---

## Access-control matrix

| Action / Resource | public | creator (`/me`) | admin | Enforced by |
|---|---|---|---|---|
| View public showcase | ✅ | ✅ | ✅ | RLS `using(true)` |
| View `/me` (own scoped stats) | ⛔→login | ✅ own | ⛔→/admin | `proxy.ts` + `(creator)` layout + session scoping |
| View `/admin` | ⛔ | ⛔→/me | ✅ | `proxy.ts` + `(admin)` layout `requireAdmin` |
| Trigger scrape (**paid**) | ⛔401 | ✅ **own profile only** | ✅ any | `/api/scrape` getUser + ownership |
| Provision / approve-reject claim / delete profile | ⛔ | ⛔ | ✅ | server actions `requireAdmin` (each) |
| Self-service add/claim/discover | ⛔410 | ⛔410 | (admin UI) | route `410` |
| **Direct PostgREST table writes** | ⛔ no policy | ⚠️ **own `creator_link`/`profile_claim` rows** | ✅ `admin manages *` | **RLS only** |
| Cron/backfill (paid/destructive) | ⛔ | ⛔ | ⛔ | `CRON_SECRET` (constant-time) |

**The ⚠️ cell is the core gap:** Phase-3 closed self-service at the **API** layer (`410`) but the **RLS** layer still lets authenticated users write their own `creator_link`/`profile_claim` rows — and those policies pin only `user_id`, leaving `creator_id` / `claim_kind` / `profile_id` attacker-controlled. See `AC-1`/`AC-2`.

---

## Already correct — keep, don't regress
✅ `/api/scrape` ownership (anon→401, non-owner→403) · ✅ cron/admin routes `Bearer CRON_SECRET` via `timingSafeEqual`, fail-closed if unset · ✅ admin server actions each re-check `requireAdmin()` · ✅ `/api/proxy-image` SSRF host-allowlist + https-only + `image/*` + 8s timeout · ✅ `validateProfileUrl` allowlist · ✅ `?window=` / `[platform]` allowlisted · ✅ `safeRedirect` open-redirect guard · ✅ `/me` derives scope from **session**, never request params · ✅ supabase-js parameterized (no SQLi) · ✅ React escaping (no XSS) · ✅ full CSP + HSTS in `next.config.js`.

---

## Privilege-escalation findings (the core ask)

Both AC-1 and AC-2 are exploitable **without the UI** — a creator hits PostgREST directly (browser supabase-js or `curl`) with their own access token + the public anon key. RLS is the only gate, and these policies pin only `user_id`:

- [ ] **AC-1 🟠 `creator_link` self-update → paid-scrape abuse on another creator's profiles.**
  - **Where:** migration `20260528000000_auth_user_role_and_creator_link.sql`, policy `"user updates own creator_link"` — `with check ((select auth.uid()) = user_id)` pins only `user_id`; `creator_id` is freely settable.
  - **Vector:** `PATCH /rest/v1/creator_link?user_id=eq.<self>` body `{"creator_id":"<victim_creator_id>"}`. Then `POST /api/scrape/<victimProfileId>` passes its ownership check (`ownCreatorId === profile.creator_id`, both now = victim's) → triggers **billed** TikHub/BrightData scrapes on the victim (Facebook ≈ 20× cost). Secondarily, a claim-less attacker's `/me` + `/me/account` fall back to `creator_id` and render the victim's data.
  - **Fix:** Phase-3 made the creator row agency-managed/read-only → **drop the user UPDATE policy** (`FIX-RLS-1`); admin + service-role retain writes.

- [ ] **AC-2 🟠 `profile_claim` self-insert bypasses the Phase-3 lockdown (the `410` is cosmetic at the DB).**
  - **Where:** migration `20260529000001_profile_claim.sql`, policies `"user inserts own claims"` / `"user deletes own claims"` — `with check ((select auth.uid()) = user_id)` pins only `user_id`; `claim_kind` + `profile_id` are free.
  - **Vector:** `POST /rest/v1/profile_claim` `{user_id:<self>, profile_id:<any unowned profile>, claim_kind:"owner", claimed_via:"manual"}`. The `profile_claim_one_owner` partial index only blocks a *second* owner, so any **unowned** profile is claimable — re-enabling the self-service the API `410`s.
  - **Fix:** **drop the user INSERT/DELETE policies** (`FIX-RLS-1`); claims are now admin/service-role-provisioned. Keep `"user reads own claims"` + `"admin manages claims"`.

- [ ] **AC-3 🟠 No rate limit on `POST /api/scrape/[profileId]` → authenticated financial DoS.** A creator (or a compromised creator account) can loop scrape-triggers on their own profile; each is a billed upstream call. **Fix:** per-(user,profile) limiter + short-circuit when `last_scraped_at` is recent (`FIX-SCRAPE-RL`). *(Overlap: `TODO_data-validator.md` is adding a `rate-limit.ts` helper / scrape throttle — reuse it; this is the access-control rationale for it.)*

- [ ] **AC-5 🟡 `top_content_windowed.p_limit` is uncapped → query-amplification DoS.** RPC is anon-callable via PostgREST; `p_limit` flows straight to `LIMIT`. **Fix:** clamp inside the function (`FIX-RLS-2`).

- [ ] **AC-6 🟢 `getAuthContext` fails *open* to `role='creator'` on a role-lookup error** (`lib/auth.ts`: `(roleRes.data?.role) ?? 'creator'` doesn't distinguish error from missing). Never escalates to admin (safe direction), but masks a hard failure — `proxy.ts` fails *closed* on the same error, so behavior is inconsistent. **Fix:** `if (roleRes.error) return null;`.

## Data-exposure findings

- [ ] **EXP-1 🟡 `raw jsonb` is anon-readable via direct PostgREST.** RLS `using(true)` is row-level → exposes every column incl. `raw` (full scraper payload: emails, phone, follower lists, internal IDs). `GET /rest/v1/post_snapshot?select=raw` with the public anon key returns it.
  - **⚠️ Correction (verified 2026-06-01):** the simple `revoke select (raw) from anon` is **NOT low-risk** — the public pages **do** read `raw` via the anon client: `queries.ts:490` (`profile_snapshot.raw`), `:599` + `:792` (`post_snapshot.raw`). `/creators/[id]` extracts avatar/name/bio and builds post permalinks from it. A bare revoke breaks those pages.
  - **Correct fix (larger, deferred):** add dedicated columns (`avatar_url`, `display_name`, `bio` on `profile_snapshot`; permalink/`code` on `post_snapshot`) populated at scrape time, refactor `queries.ts` to read those instead of `raw`, **then** move `raw` to an admin-only side table (or revoke). Track as its own task — **not** bundled with the RLS lockdown.
- [ ] **EXP-2 🟢 Verify the `snapshot-archive` Storage bucket is PRIVATE** (the archive cron writes raw snapshot JSONL there). Only `post-media` was confirmed `public=true` (thumbnails, fine).
- [ ] **ACR-DECISION-1 🟡 Confirm the fully-public model is intended.** All analytics is anon-readable; the schema can't express per-creator privacy today (no visibility flag; RPCs accept arbitrary `p_creator_ids` from anon). Blocks a privacy-expecting white-label client.

## Availability bug (creator dashboard)

- [ ] **ME-3 🟡 `/me/leaderboard/page.tsx` null-deref:** reads `auth.creatorLink.creator_id` without `?.`; `creatorLink` can be `null` → `TypeError` → 500 for a creator with no link row (other `/me` pages use `?.`). **Fix:** `auth.creatorLink?.creator_id ?? null` (`FIX-ME-NULL`).

---

## Per-dashboard required rules

### A. Public dashboard — read-only, public data, no privileged column, no amplification
- [ ] **ACR-PUB-1** Reads use `getSupabaseRead()` (anon) only — never cookie/service-role. *(holds)*
- [ ] **ACR-PUB-2** `[platform]` allowlisted; `[id]` → `getCreatorByHandle` → `notFound()`; `?window=` allowlisted. *(holds)*
- [ ] **ACR-PUB-3** Apply `AC-5` (limit clamp) + `EXP-1` (no `raw`) so anon can neither amplify nor read `raw`.

### B. Creator `/me` — authenticated; own scoped slice; exactly one privileged action (scrape own); no ownership mutation; read-only account
- [ ] **ACR-ME-1** `(creator)` layout requires session; pages redirect `admin`→`/admin`; scope derives from session only. *(holds)*
- [ ] **ACR-ME-2 🔴** Close the direct-PostgREST write paths (`AC-1`, `AC-2`) via `FIX-RLS-1`; add regression tests `T-1`/`T-2`.
- [ ] **ACR-ME-3 🟠** Rate-limit the one creator action (`AC-3` / `FIX-SCRAPE-RL`); keep the 401/403 ownership gate.
- [ ] **ACR-ME-4 🟡** Fix `ME-3` null-deref; keep `/me/account` read-only (no writable field without a `requireCreator`-and-owns action).

### C. Admin dashboard — role-gated at layout AND re-checked per action; service-role writes only after the gate; no internal leakage
- [ ] **ACR-ADM-1** `(admin)` layout `requireAdmin`; every action re-checks `requireAdmin()`. *(holds — invariant for any NEW action)*
- [ ] **ACR-ADM-2** Provisioning input validation is owned by `TODO_data-validator.md` (`account-validation.ts`, wired into `createCreator`). ✅ complementary — not re-specified here.
- [ ] **ACR-ADM-3 🟢** UUID-validate ids in `approveClaim`/`rejectClaim`/`deleteProfile` + `/api/scrape` before DB calls (the `lib/ids.ts` `isUuid` helper from the companion file), and don't echo raw `error.message` (leak fix). *(Owned by the companion file; listed for completeness.)*
- [ ] **ACR-ADM-4 🟢** `deleteProfile` is destructive (`ON DELETE CASCADE`) — keep the confirm step + add an audit row (admin_id, profile_id, ts).
- [ ] **ACR-ADM-5** Cron/backfill stay `CRON_SECRET`-gated (operator-only, not session-admin). Do not "upgrade" them to session-admin without re-adding rate limiting.

---

## Proposed code changes

### FIX-RLS-1 🔴 — mirror the Phase-3 lockdown in RLS (new migration)
`supabase/migrations/20260601000000_lockdown_claim_link_rls.sql`
```sql
-- Creators are agency-managed/read-only (Phase 3). The API returns 410 for
-- self-service, but RLS still let authenticated users write their own
-- creator_link/profile_claim rows with only user_id pinned in WITH CHECK
-- (creator_id / claim_kind / profile_id were attacker-controlled).
drop policy if exists "user updates own creator_link" on public.creator_link;  -- AC-1
drop policy if exists "user inserts own claims"       on public.profile_claim;  -- AC-2
drop policy if exists "user deletes own claims"       on public.profile_claim;  -- AC-2
-- Keep "user reads own *" (SELECT) + "admin manages *" (ALL).
-- Service-role bypasses RLS, so admin provisioning is unaffected.
```
Optional DB backstop (defense-in-depth even if a policy regresses) — forbid a non-admin changing the immutable FK:
```sql
create or replace function public.forbid_creator_link_creator_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if (select auth.uid()) is not null and not public.is_admin()
     and new.creator_id is distinct from old.creator_id then
    raise exception 'creator_id is agency-managed';
  end if;
  return new;
end $$;
create trigger creator_link_no_self_repoint
  before update on public.creator_link
  for each row execute function public.forbid_creator_link_creator_change();
```

### FIX-RLS-2 🟡 — clamp `p_limit` (re-create `top_content_windowed`, add one line)
```sql
  if p_window not in ('7d','30d','90d','lifetime') then
    raise exception 'invalid p_window: %', p_window;
  end if;
+ p_limit := least(greatest(coalesce(p_limit, 20), 1), 100);  -- hard cap for direct anon RPC calls
```

### FIX-SCRAPE-RL 🟠 — `app/api/scrape/[profileId]/route.ts` (after the ownership check, before `runScraper`)
```ts
// Cost control: scrapes are billed per call. Short-circuit very recent scrapes
// and rate-limit non-admin self-scrapes. 401/403 ownership already passed above.
if (!isAdmin && profile.last_scraped_at &&
    Date.now() - new Date(profile.last_scraped_at).getTime() < 10 * 60_000) {
  return NextResponse.json(
    { ok: false, status: 'throttled', error: 'Scraped recently — try again later.' },
    { status: 200 },
  );
}
// + per-user limiter keyed `scrape:${user.id}` (reuse the companion rate-limit.ts,
//   which is fail-open), e.g. slidingWindow(5, '1 m'); admins exempt.
```

### FIX-RAW 🟡 — `EXP-1` (fast mitigation; prefer moving `raw` to an admin-only table)
```sql
revoke select (raw) on public.profile_snapshot from anon, authenticated;
revoke select (raw) on public.post_snapshot   from anon, authenticated;
-- Verify PostgREST still expands select=* to the remaining columns for anon
-- (or migrate `raw` into profile_snapshot_raw / post_snapshot_raw with is_admin()-only RLS).
```

### FIX-ME-NULL 🟡 — `app/(creator)/me/leaderboard/page.tsx`
```diff
-    creatorId: auth.creatorLink.creator_id,
+    creatorId: auth.creatorLink?.creator_id ?? null,
```

### FIX-AUTH-FAILCLOSED 🟢 — `lib/auth.ts` (distinguish error from missing)
```ts
const [roleRes, linkRes] = await Promise.all([ /* ... */ ]);
if (roleRes.error) return null; // fail closed → force re-auth, don't assume 'creator'
const role: UserRole = (roleRes.data?.role as UserRole) ?? 'creator';
```

---

## Commands
```bash
# Confirm Next 16 (proxy.ts IS the active middleware — no middleware.ts expected):
node -e "console.log(require('next/package.json').version)"   # expect 16.x

# Apply the RLS lockdown after review (production data):
supabase db diff           # confirm intended diff
supabase db push           # FIX-RLS-1 / FIX-RLS-2

# Live RLS cross-check (authoritative, not file-based) — Supabase MCP get_advisors(security),
# or probe PostgREST with a CREATOR's access token + the public anon key
# (expect DENIED after FIX-RLS-1):
#   PATCH {SUPABASE_URL}/rest/v1/creator_link?user_id=eq.<self> {"creator_id":"<other>"}  -> 401/403 (AC-1)
#   POST  {SUPABASE_URL}/rest/v1/profile_claim {... "owner" ...}                          -> 401/403 (AC-2)
#   POST  /api/scrape/<otherProfileId>                                                    -> 403     (ownership)
#   GET   {SUPABASE_URL}/rest/v1/post_snapshot?select=raw&limit=1                         -> empty/denied after FIX-RAW (EXP-1)
#   curl -I /admin (anon)                                                                 -> 307 /login (proxy.ts)

# Lint + tests (root only, per CLAUDE.md):
pnpm lint
pnpm test
```

---

## Access-control standards checklist
- [ ] Server/DB authorization unbypassable — **direct PostgREST is the bypass until `FIX-RLS-1`**
- [ ] Every RLS `WITH CHECK` pins ALL security-relevant columns, not just `user_id` (`AC-1`/`AC-2`)
- [ ] Paid/abusable endpoints rate-limited (`AC-3`); RPC limits capped (`AC-5`)
- [ ] No privileged column world-readable (`EXP-1`); private buckets confirmed (`EXP-2`)
- [ ] Errors leak no DB internals (cross-ref companion file)
- [ ] Each tier confined: anon→login, creator↛admin, admin↛creator-flow (proxy + layouts + actions)
- [ ] Tests cover cross-tier escalation attempts

## Tests (add)
- [ ] **T-1 🔴** creator JWT `INSERT profile_claim(...'owner'...)` on an unowned profile → **denied** (post `FIX-RLS-1`).
- [ ] **T-2 🔴** creator JWT `PATCH creator_link` changing `creator_id` → **denied**.
- [ ] **T-3 🟠** `POST /api/scrape/<not-owned>` as creator → 403; `<owned>` twice within 10 min → 2nd is `throttled`.
- [ ] **T-4 🟡** `top_content_windowed(p_limit => 1e7)` → returns ≤ 100 rows.
- [ ] **T-5 🟡** anon `select raw from post_snapshot` → denied / column absent (post `FIX-RAW`).
- [ ] **T-6 🟢** anon `GET /admin` → 307 `/login`; creator `GET /admin` → 307 `/me` (proxy.ts).
- [ ] **T-7 🟢** creator with `creator_link.creator_id = null` loads `/me/leaderboard` → 200 empty state, no 500 (post `FIX-ME-NULL`).
