# D3 Creator — End-to-End Test Report

**Date:** 2026-06-06
**Tester:** Claude (`/e2e-test`, adapted)
**Build:** Next.js 16.2.6 (Turbopack) · React 19 · Supabase Postgres
**Working-tree change under test:** `apps/frontend/src/lib/queries.ts` (H1 fix, **uncommitted**)

---

## 0. Why this run differs from stock `/e2e-test`

The `/e2e-test` skill is hard-gated to **`agent-browser`**, which only runs on Linux/WSL/macOS. This machine is **native Windows** (`uname -s` → `MINGW64_NT`). A WSL relaunch was evaluated but the WSL toolchain turned out to be a mirage — only Linux `node` is real; `npm`/`pnpm`/`agent-browser` were Windows binaries leaking through PATH interop, so a genuine `agent-browser` run would have required a full Linux toolchain build + a fresh Claude Code auth.

Instead, the **equivalent flow was run natively on Windows**:

| Stock skill | This run |
|---|---|
| `agent-browser` CLI | **Playwright MCP** |
| App pointed at whatever `pnpm dev` loads (**= prod `.env`!**) | **Force-local**: dev server bound to `.env.local-ui` → local Supabase |
| DB validation via host `psql` | `docker exec … psql` against the local stack |

### Critical safety note
The repo's `dev` script is `dotenv -e ../../.env -- next dev -p 4200`, and **root `.env` points at the live production Supabase** (`NEXT_PUBLIC_SUPABASE_URL=https://wmesjldkqvbzrcpitclu.supabase.co`). Running the stock skill as-is would have fired **create/update/delete journeys at the production client database.** This run guaranteed force-local and **never connected to production.**

---

## 1. Summary

- **Journeys tested:** 12 (6 public, 2 creator, 4 admin-write)
- **Screenshots captured:** 13 → `e2e-screenshots/`
- **Issues found:** 1 real bug (**fixed & verified live**) + several confirmed observations
- **Production impact:** **none** — all reads/writes hit `127.0.0.1`; verified by absence of the prod project ref and by confirming every write in the local DB.

### Prod-safety evidence
- Dashboard HTML contained seeded names (Jane Doe / Alex Park / Someone Else) and **no** prod ref `wmesjldkqvbzrcpitclu`, and **no** demo-fallback marker → app reads the local DB.
- All four admin writes were independently confirmed in the local Postgres via `docker exec`.

---

## 2. Environment & fixtures

### Local stack
- **API:** `http://127.0.0.1:54321` · **DB:** `postgresql://postgres:postgres@127.0.0.1:54322/postgres` · **Studio:** `:54323`
- Keys matched the pre-existing `.env.local-ui` exactly (`sb_publishable_ACJWlz…` / `sb_secret_N7UND…`).
- `npx supabase db reset` applied **all 16 migrations** including the latest `20260606000000_harden_function_grants_and_search_path` (the from-backup volume had been stale at 15).

### Seed data (`libraries/database/src/seed-ui-check.ts` + SQL top-up)
- **Auth users:** `admin@d3.test` (admin) / `creator@d3.test` (creator) — both password `Passw0rd!`
- **3 creators:** Jane Doe (IG+FB+Douyin, handle `janedoe`), Alex Park (IG `alexpark`), Someone Else (TikTok `someoneelse`)
- **5 profiles**, **5 `profile_snapshot`** rows (followers), **20 `post_snapshot`** rows (4 per profile, `posted_at` at 0.08d / 2d / 10d / 40d so windowed metrics differ), **1 pending `profile_claim`** (FB `janedoe`).

---

## 3. Per-journey results

### Public read journeys (run logged-out / as creator — an **admin** session is bounced off every public route to `/admin`)

#### P1 — Home `/` · `01-home.png`, `01b-home-livepreview.png`
- Top Creators: Jane Doe **15,900,000** / Alex Park **5,300,000** / Someone Else **5,300,000**; Total Views **26,500,000**; Combined followers **830K**; engagement **1,547,100**.
- Math verified against seed: MAX-views dedup → 5.3M/profile; Jane's 3 profiles = 15.9M; 5 profiles total = 26.5M. ✓
- **Scroll-reveal note:** middle sections use `opacity-0 … data-[in-view=true]:opacity-100`; a full-page screenshot freezes them pre-reveal (looks blank). Confirmed working via viewport capture after scroll — **not a bug**.

#### P2 — Dashboard `/dashboard` · `02-dashboard.png`
- **Platform filter** (the past mis-attribution bug): selecting **Instagram** → Total Views **10,600,000**, **Someone Else (TikTok-only) correctly dropped**, Jane shows her **per-platform slot** (5.3M / 250K) not her creator-total (15.9M / 400K). ✓ Fix holds.
- **Period pills:** Instagram + **1W** → **3,800,000** (= 2 IG profiles × [post_1 1.5M + post_2 0.4M within 7d]). `posted_at` windowing exact. ✓
- Sort toggle (Views/Followers) + Platform Breakdown present (FB 5.3M/90K, IG 10.6M/500K, TikTok 5.3M/180K, Douyin 5.3M/60K).

#### P3 — Leaderboard `/leaderboard` · `03-leaderboard.png`
- Summary tiles, Top Creators, **Top Content** (by views) + **Top Engaging Content** (by interactions), **24 external post links**, **pagination "1–12 of 20"**, "Posted in" content time filter.
- **0 broken images** — null thumbnails fall back to the platform icon (graceful).

#### P4 — Creator detail `/creators/[handle]` · *(see §4 H1)*
- `/creators/janedoe` → h1 "Jane Doe", "Total Followers **400K** across 3" (250K IG + 90K FB + 60K Douyin ✓), platform tiles for all 4.

#### P5 — Platform detail `/creators/janedoe/instagram` · `04-creator-platform-detail.png`
- h1 "Jane Doe on Instagram", back-link `/creators/janedoe`, content grid of recent posts. ✓

#### P6 — Mobile nav · `08-mobile-home.png`, `09-mobile-menu-open.png`
- Hamburger toggles `aria-expanded` true/false, label flips Open↔Close, panel shows About/Dashboard/Leaderboard/**My data** (creator-aware). ✓

### Creator portal (signed in as `creator@d3.test`)

#### C1 — `/me`
- h1 "Your creator view.", window tabs 7D/30D/90D/Lifetime, renders Jane Doe's data (15.9M / 400K — the creator owns that creator). Not the empty-state. ✓

#### C2 — `/me/leaderboard` · `07-me-leaderboard.png`
- "The 20 highest-viewed posts across your platforms" — **12 distinct posts**, no duplicates. Notably the **FB posts appeared only after the A9 claim approval** flowed `resolveCreatorProfiles` → nice end-to-end confirmation.

> *Not exercised:* C3 `/me/account` (read-only display name/email/sign-out).

### Admin write journeys (signed in as `admin@d3.test`) — **fully validated UI → local DB**

#### A1 — Provision creator · `05-admin-provision-success.png`
- Created **E2E Test Creator** / `e2e-creator@d3.test` / IG `https://www.instagram.com/e2etestuser`. UI showed "Created …" + one-time credentials panel; stats incremented **Creators 3→4, Profiles 5→6, Users 2→3**.
- **DB confirmed:** `creator` + `user_role=creator` + `creator_link` (linked, onboarding ✓) + `auth.users` (email_confirmed ✓) + `profile` (instagram / e2etestuser / `scrape_status=pending`) + `profile_claim` (owner / admin_assigned / confirmed ✓).

#### A2 — Rename creator
- → "E2E Renamed Creator". **DB confirmed** `creator.display_name` updated.

#### A8 — Delete creator (cascade)
- Inline confirm → delete → redirect `/admin/profiles`.
- **DB confirmed cascade:** `creator`, `profile`, `creator_link`, `user_role`, `auth.users` for that creator/user all **= 0**; overall counts back to baseline **3 / 5 / 2**. No orphans. The deliberate "auth-user-first" ordering works.

#### A9 — Approve pending claim
- Approved the seeded FB `janedoe` pending claim.
- **DB confirmed:** claim promoted to `owner` + `confirmed_at` set; **exactly 1 owner** for the profile (one-owner partial-unique invariant held); pending queue → **0**.

> *Observed but not click-tested:* A3 add-URL, A4 edit-URL, A5 remove-URL, A6 add-login, A7 reset-password, A10 delete-profile, A11 search/platform-filter. These reuse the same `findOrCreateProfile` / cascade-delete / `auth.admin` paths that A1/A8 validated.

### Responsive · `10-mobile-dashboard.png`, `11-tablet-dashboard.png`, `12-desktop-dashboard.png`
| Viewport | Result |
|---|---|
| Mobile 375×812 | Hamburger nav, vertical stack, horizontally-scrollable filter bar; **no document overflow** (scrollWidth 375) |
| Tablet 768×1024 | No overflow (scrollWidth 753) |
| Desktop 1440×900 | 2-column layout (Top Creators + Platform Breakdown), full nav; no overflow (scrollWidth 1425) |

No responsive layout defects found.

---

## 4. Issue fixed during testing

### 🔴 H1 — Unescaped ILIKE wildcard in `getCreatorByHandle` (correctness + mild injection)
**File:** `apps/frontend/src/lib/queries.ts:585` — affects `/creators/[id]` **and** `/creators/[id]/[platform]` (the latter delegates to `getCreatorByHandle`).

**Root cause:** the raw URL slug was passed straight into `.ilike('handle', handle)`. In Postgres LIKE/ILIKE, `_` matches any single char and `%` matches any run, so a slug that should not exist resolves a real creator. The codebase already documents this exact bug class and fixes it elsewhere via `escapeLikePattern` (`libraries/database/src/claim.ts:46`) — `getCreatorByHandle` was the one site that was missed.

**Demonstrated live (before fix):** `GET /creators/jane_oe` → page title **"Jane Doe — D3 Creator"** (should be a 404).

**Fix (uncommitted, on working tree):**
```diff
+/**
+ * Escape Postgres LIKE/ILIKE wildcards so a user-supplied handle is matched
+ * literally. Without this, `_`/`%` in the route param act as wildcards and can
+ * resolve the WRONG creator (mirrors escapeLikePattern in libraries/database).
+ */
+function escapeLikePattern(value: string): string {
+  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
+}
+
 export async function getCreatorByHandle(handle: string): Promise<CreatorDetail | null> {
   ...
-    .ilike('handle', handle)
+    .ilike('handle', escapeLikePattern(handle))
```

**Verified both directions (fresh, uncached paths):**
- `GET /creators/janed_e` → **404** (bug gone — proves new code ran)
- `GET /creators/alexpark` → **renders Alex Park** (proves the fix is not over-broad)

**Status:** ✅ behaviorally verified · ⚠️ **not committed** (left for your CodeRabbit/PR gate) · ⚠️ **not linted/type-checked** — change is a `string→string` escape that Turbopack compiled and served correctly; your PR pipeline will lint it. Only `queries.ts` is modified (`+10/−1`); `e2e-screenshots/` and `.playwright-mcp/` are gitignored.

**Note on the `%` variant:** `GET /creators/%25` returned a 404 rather than matching everything (a bare `%` is normalized/encoded away before the query). The **`_` variant is the confirmed, reliable repro.**

---

## 5. Bug-hunt findings (code analysis — see status per item)

| ID | Sev | Finding | File | Status in this run |
|---|---|---|---|---|
| **H1** | High | Unescaped ILIKE handle → wrong creator / injection | `queries.ts:585` | **Reproduced + FIXED + verified** |
| M1 | Med | Broken-image glyph on `/api/proxy-image` 502 — `<img>` fallback only covers null URL, not failed load | `leaderboard-showcase.tsx`, `dashboard-showcase.tsx`, `(public)/page.tsx`, `creators/[id]/page.tsx`, `me/leaderboard/page.tsx` | ✅ **FIXED & verified** — shared `ImageWithFallback` (onError→fallback); live on client (dashboard) + server (creators/[id]). See §8 |
| M2 | Med | `getCreatorPlatformDetail` dedups to 30 with no `posted_at` tiebreak → wrong 30 after a deep backfill | `queries.ts` | ✅ **FIXED & verified** — `posted_at` tiebreak; probe (newest / lowest-views / last-id) sorted first. See §8 |
| M3 | Med | Creator-detail "Total Views" (last-30 rollup) vs leaderboard/dashboard (all tracked posts) differ | `creators/[id]/page.tsx:64` | **Confirmed expected** — documented metric-scope split; admin "Total views 21.5M" (`profile_snapshot.total_views`) vs public 26.5M (`post_snapshot`) observed live |
| M4 | Med | `findCandidatesByHandle` filters owned profiles *after* a `.limit(200)` pool fetch | `claim.ts:350–387` | Code-confirmed; not reproduced (small DB) |
| L1 | Low | `latestSnapshotsForProfiles` has no paging vs 1000-row PostgREST cap | `queries.ts:497–526` | Code-confirmed; not reproduced |
| L2 | Low | `deleteCreator` loops `deleteUser` with no rollback → mid-loop failure orphans state | `creators/[id]/actions.ts:399–412` | Code-confirmed; cascade itself validated working (A8) |
| L3 | Low | Dashboard trend chip + sparkline are synthetic placeholders shown on Lifetime | `dashboard-showcase.tsx:160`, `showcase-data.ts:298` | **Confirmed live** — "9% / 7.6% / 8.6% · recent" are deterministic fakes |

### Other observations
- **Dev-only console error (not a prod bug):** Vercel Analytics `script.debug.js` blocked by CSP `script-src` — only loads in dev; prod serves the insights script same-origin.
- **Auth gating verified solid:** admin session redirected off every public/`/me` route to `/admin`; creator login routed to `/me`; admin pages re-check role.

---

## 6. Recommendations
1. **Ship H1** through your normal PR/CodeRabbit flow (`git add apps/frontend/src/lib/queries.ts` — the screenshot dirs are gitignored). High value: it's a public-facing wrong-data / mild-injection bug on a read path, with a one-line, pattern-matching fix.
2. ~~**M1** — add an `onError` fallback to the shared `<img>` usages~~ → **DONE** (see §8): shared `ImageWithFallback` component.
3. ~~**M2** — add a `posted_at` tiebreak in `getCreatorPlatformDetail`~~ → **DONE** (see §8).
4. **L3** — gate or label the synthetic dashboard trend chip/sparkline so a live page doesn't imply real growth data.
5. Consider exercising the remaining admin actions (A3–A7, A10, A11) and C3 in a follow-up pass for full coverage — they were observed but not click-tested here.

---

## 7. Artifacts & cleanup
- **Screenshots (13):** `e2e-screenshots/01-home.png … 12-desktop-dashboard.png` (gitignored).
- **Cleanup done:** dev server stopped, local Supabase stopped (data backed up to an inert docker volume), browser closed. **Production untouched throughout.**
- To re-inspect: `npx supabase start` → `pnpm -C apps/frontend exec dotenv -e ../../.env.local-ui -- next dev -p 4200`; sign in `admin@d3.test` / `Passw0rd!`.

---

## 8. Follow-up — M1 & M2 fixes applied (2026-06-06)

Both Medium findings were implemented, verified live, and reviewed after the initial run. Uncommitted on the working tree (alongside H1), for the PR/CodeRabbit gate.

**M2 — `posted_at` tiebreak** (`queries.ts`, `getCreatorPlatformDetail`)
Added `.order('posted_at', { ascending: false, nullsFirst: false })` as a secondary sort. **Verified:** a probe post on Jane's IG with the newest `posted_at` but the **lowest** views (99) and **highest** id (inserted last) now renders **first** on `/creators/janedoe/instagram` — which only happens when the query orders by `posted_at`.

**M1 — `ImageWithFallback`** (new `components/ui/image-with-fallback.tsx`, `'use client'`)
Renders the fallback node on `onError` (not just on a null `src`), wired into all 5 sites. A shared component was required because **3 of the 5 sites are server components**, where an inline `onError` would be a silent no-op. **Verified** by pointing Jane's `avatar_url` at a host that 502s through the proxy:
- Client (dashboard): `<img>` fired `onError` (network `/api/proxy-image…nonexistent… → 400`); avatar showed the "J" initial, no broken-image glyph.
- Server (creators/[id]): SSR rendered the `ImageWithFallback` `<img>` (HTTP 200, no error); client `onError` behaves identically.

**Quality gates:** eslint ✅ · `tsc --noEmit` ✅ · CodeRabbit `review --agent` ✅ **0 findings**. Net `eslint-disable @next/next/no-img-element` reduced 5 → 1.

**Change set:** `queries.ts` (H1 + M2), new `image-with-fallback.tsx`, + 5 wired sites (`leaderboard-showcase`, `dashboard-showcase`, `(public)/page.tsx`, `creators/[id]/page.tsx`, `me/leaderboard/page.tsx`).

**Unrelated issue surfaced during verification (not touched):** `content-thumb.tsx:139` `relativeTime(post.publishedAt)` is not hydration-safe (server "34s" vs client "32s") for seconds-old posts — pre-existing.
