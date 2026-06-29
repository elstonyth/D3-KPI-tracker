# Phase 2 Handoff — Admin Top-30 + Creator Provisioning

**Read this first in a fresh chat.** It is self-contained: you do NOT need the prior conversation.

## Where things stand (as of 2026-05-30)

The "Views-over-Engagement + admin-centralized accounts" initiative is being built in 4 phases, foundation-first. Each phase = its own spec → plan → build (subagent-driven, two-stage review) → verify → PR.

| Phase | Scope | Status |
|---|---|---|
| **0** | Windowed-metrics data layer (Postgres RPCs + TS wrapper) | ✅ DONE, merged to `main` (PR #4, squash `070fffd3`) |
| **1** | Public `/dashboard` + `/leaderboard` redesign | ✅ DONE, **open PR #5** on branch `feat/phase1-public-pages` |
| **2** | Admin `/admin` Top-30 + creator provisioning + kill signup | ⬜ **NOT STARTED — this handoff** |
| **3** | Creator lockdown: delete `/me/profiles`, read-only `/me/account`, 3-stat `/me` w/ shared 7D/30D/90D/Lifetime selector | ⬜ not started |

**Before starting Phase 2:** check whether PR #5 is merged (`gh pr view 5 --json state`). If still open, branch Phase 2 off `feat/phase1-public-pages` (it depends on Phase 1's metrics wrapper) OR off `main` after #5 merges. Confirm with the user.

## Locked product decisions (do not re-litigate)

From the approved brainstorm (`docs/superpowers/specs/2026-05-30-views-over-engagement-overview.md`):

- **Views over Engagement**: Views is the headline metric. Engagement is **private-only** (creator `/me`), removed from public + admin.
- **"Views 30D" = views *gained* in the window** (delta), via Phase 0 RPCs. Windows: 7d/30d/90d/lifetime.
- **Admin provisioning**: admin creates the creator **login (email+password)** AND assigns **social URLs**. **Public signup is killed.**
- **Admin Top-30 followers** ranks by **30d follower delta** (growth), not current count.
- **`insufficient` flag → "Building history…"** UI state (no fake deltas on young profiles).
- Backend/scraper/DB-constraint kept intact where things are "removed" — archive, don't delete.

## Phase 0 data layer you will consume (already merged, live)

`apps/frontend/src/lib/metrics-windowed.ts`:
- `getCreatorMetricsWindowed(window, opts?)` → `CreatorMetricWindowRow[]`
  fields: `creatorId, displayName, avatarUrl, primaryPlatform, primaryHandle, followers, followersDelta, viewsGained, engagement, postCount, insufficient`
- `getTopContentWindowed(window, opts?)` → `TopContentRow[]`
  fields: `externalPostId, profileId, creatorId, creatorName, platform, handle, captionExcerpt, thumbnailUrl (already proxied), postedAt, viewsGained, currentViews, likes, comments, shares`
- `opts`: `{ client?, creatorIds?, profileIds?, limit? }`. Inject a service-role client for admin.
- Postgres RPCs: `creator_metrics_windowed`, `top_content_windowed` (migration `supabase/migrations/20260530000000_windowed_metrics_rpcs.sql`, currently v4 in prod — includes `primary_handle`, plpgsql, validates window, bool_or insufficient, views-based engagement).

Reusable Phase 1 pieces:
- `apps/frontend/src/lib/format-metric.ts` → `formatWindowedValue(insufficient, value, formatter)` + `BUILDING_HISTORY`.
- `apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx` → Top-N content thumbnail grid (pattern to reuse for admin content render).
- `apps/frontend/src/lib/profile-name.ts` → `resolveProfileName(display_name, raw, handle)` — USE THIS for any FB profile name (FB stores numeric id as handle + null display_name; readable name is in snapshot `raw.page_name`).
- `apps/frontend/src/components/ui/platform-icons.tsx` → `VISIBLE_PLATFORMS`, `isHiddenDbPlatform()` (Xiaohongshu archived — keep it hidden).

## What Phase 2 must build (from the original task)

### 2a. Admin `/admin` — "Top 30" view
Files: `apps/frontend/src/app/(admin)/admin/page.tsx` (+ maybe a new `top30.tsx`), existing `apps/frontend/src/lib/admin-creators.ts`.
- New section, two columns (desktop `lg:grid-cols-2`, stacked mobile):
  - **Top 30 Creators by Followers 30D** — dense table, rank by `followersDelta` desc (the locked decision). Columns: `# · Creator · Platform · Followers · Δ30D`.
  - **Top 30 Content by Views 30D** — `getTopContentWindowed('30d', { limit: 30 })`, reuse the `view-leaderboard.tsx` grid pattern. Renders actual content items (thumbnail + creator + views).
- Admin uses **service-role** client (`getSupabaseAdmin`), not anon. No engagement (private-only).
- Honor `insufficient` → "Building history…".
- Keep the existing `/admin` stat tiles + "Manage accounts" link.

### 2b. Creator provisioning (admin adds accounts) — the crucial permission shift
- New admin UI (in `/admin/profiles` or a new `/admin/creators/new`): a form to **create a creator**:
  1. Create the auth user with email + password via service-role `auth.admin.createUser`.
  2. Link `user_role` + a `creator` row (see `libraries/database` — `ensureCreatorForUser` exists; check what's reusable).
  3. Assign social URLs → reuse server-side `validateProfileUrl` + `profile` upsert + `profile_claim` (owner kind, admin-initiated). Existing helpers in `@d3/database` (`addProfile`, `findOrCreateProfile`, `addProfileClaim`).
- **Kill public signup**: disable `apps/frontend/src/app/(auth)/signup/` route + remove signup links/CTAs. Login stays.
- This is the write-access shift: after Phase 3, creators can't add accounts at all; Phase 2 builds the admin side that replaces it.

### Phase 2 self-check (from original task)
- Admin can create a creator login + assign URLs.
- Public signup is gone.
- Top-30 shows content items + creator stats, no engagement.

## How to run it (process)

1. **Brainstorm only if anything above is ambiguous** — most is locked; confirm the 2–3 open questions (e.g. where the provisioning form lives; exact auth-user creation flow given current `libraries/database` helpers; whether to keep `/admin/profiles` as-is and add Top-30 to `/admin`, or restructure).
2. **Write the Phase 2 spec** → `docs/superpowers/specs/2026-05-31-phase2-admin-provisioning-design.md` (use brainstorming → writing-plans skills).
3. **Plan** → `docs/superpowers/plans/2026-05-31-phase2-admin-provisioning.md`.
4. **Build** subagent-driven: fresh implementer per task + spec-review then code-quality-review. Models: cheap for mechanical, standard for integration (auth flow = standard+).
5. **Verify**: `pnpm --filter ./apps/frontend exec jest`, `pnpm --filter ./apps/frontend exec tsc --noEmit`, `pnpm --filter ./apps/frontend run build`. (Root `pnpm test` is broken — missing `@nx/jest`; pre-existing, use the frontend-scoped commands.)
6. PR.

## Environment gotchas (save you time)

- **pnpm only.** Run lint/typecheck/jest **frontend-scoped**: `pnpm --filter ./apps/frontend exec <tsc|jest|eslint …>`. Root `pnpm test` fails (`@nx/jest` not installed) — pre-existing, not your bug.
- **Path alias** `@gitroom/frontend/*` works in tsc/build but NOT in jest (ts-jest). In files imported by tests, use **relative** imports (see `metrics-windowed.ts`).
- **Build needs Supabase env**: `set -a && . ./.env && set +a` before `next build`, or it errors on `NEXT_PUBLIC_SUPABASE_URL` (and `/dev/logo-preview` prerender fails — pre-existing, unrelated).
- **Preview server**: `.claude/launch.json` has a `preview` config (autoPort, no `-p`). `.claude/` is gitignored so it stays local. Use the Claude_Preview MCP `preview_start` with name `preview`.
- **DB writes need explicit user OK**: applying migrations / `apply_migration` to prod (project `wmesjldkqvbzrcpitclu`) is gated by the safety classifier — ask the user before mutating prod. Provisioning will need new tables/policies or auth-admin calls; plan the migration, get sign-off, then apply.
- **Auth exists**: route groups `(admin)` / `(creator)` / `(auth)` with role gating via `getAuthContext()` (`auth.role === 'admin'`). `user_role` table exists. Admin actions use `getSupabaseAdmin()` (service-role) in `'use server'` actions — see `apps/frontend/src/app/(admin)/admin/profiles/actions.ts` for the pattern (re-check `requireAdmin`, return `ActionResult`, `revalidatePath`).
- **Test login creds** (dev): admin `admin@d3.test`, creator `creator@d3.test`, password `Passw0rd!`.
- **DB facts**: ~21–22 creators, ~62 profiles, ~968 post snapshots, **0 rednote rows**. Only ~1 snapshot day so windowed deltas are mostly `insufficient` today (correct — shows "Building history…").

## How to actually open the new chat

Start a fresh Claude Code chat in this repo and paste:

> Read `docs/superpowers/specs/PHASE2-HANDOFF.md` and the specs it references, then let's build Phase 2 (admin Top-30 + creator provisioning + kill signup). Confirm the open questions with me before writing the spec.

That's enough — the doc points to everything else.
