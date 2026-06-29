# D3-Creator — Architecture & Code-Quality Review

**Date:** 2026-05-29 · **Method:** graphify knowledge graph (9,730 nodes / 10,891 edges) as source of truth, 4 parallel subagents (frontend / backend / cross-cutting / code-quality), findings verified against source. **Read-only** — no code was changed.

Every finding carries the graph's own confidence tag: **EXTRACTED** (explicit in source), **INFERRED** (model-reasoned), **AMBIGUOUS** (uncertain). Severity: 🔴 critical / 🟡 worth fixing / 🟢 minor.

---

## Top 5 things to fix before production

| # | Issue | Where | Sev |
|---|-------|-------|-----|
| 1 | **Sentry ships secrets & PII to a third party.** `includeLocalVariables: true` + `sendDefaultPii: true` attach in-scope locals (service-role client, `CRON_SECRET`, cookies) and request headers to every server error event. One 500 in a cron/scrape route can leak `SUPABASE_SERVICE_ROLE_KEY` or a live session cookie. | `apps/frontend/sentry.server.config.ts:14-18` | 🔴 |
| 2 | **Anyone can forge ownership of any creator's profile (pre-takeover).** First authenticated user to add an untracked URL is auto-granted `owner` with no handle verification, and the `profile_claim` RLS INSERT policy doesn't restrict `claim_kind`, so a user can self-insert `owner` directly with the public key. The one-owner unique index then locks out the real creator. | `libraries/database/src/claim.ts:299`; `apps/frontend/src/app/api/profiles/route.ts:158-169`; `supabase/migrations/20260529000001_profile_claim.sql:53-55` | 🔴 |
| 3 | **SSRF in the image proxy.** Host allowlist is checked only on the initial URL; `fetch` then follows 30x redirects (`redirect:'follow'`) to internal hosts / `169.254.169.254`. Blind SSRF. | `apps/frontend/src/app/api/proxy-image/route.ts:151,169` | 🔴 |
| 4 | **Anonymous public read of raw scraper payloads.** Public RLS SELECT on `profile_snapshot`/`post_snapshot` includes the `raw jsonb` column = full upstream vendor objects (bios, internal IDs, URLs) exposed to `anon`. | `supabase/migrations/20260527135229_init_v1_core_tables.sql` | 🟡→🔴 (data exposure) |
| 5 | **~1.5 MB of dead Postiz weight ships to users.** A 539 KB unreferenced minified bundle (`public/f.js`) + a fully dead 16-locale i18n subsystem (~915 KB, 685 keys × 16, only consumer never imported). Together these are ~8,100 of the graph's 8,798 isolated nodes. | `apps/frontend/public/f.js`; `libraries/react-shared-libraries/src/translation/` | 🔴 |

> Also strongly consider before launch: the daily cron silently scrapes only **5 profiles/run** (finding B-6), breaking the "daily snapshot" contract once you exceed 5 active profiles.

---

## 🔴 Critical

### C1 · Sentry leaks secrets and PII to a third party
- **Where:** `apps/frontend/sentry.server.config.ts:14-18` (server) · `apps/frontend/instrumentation-client.ts:10-22` (client replay). Graph communities *Sentry Instrumentation*, *Global Error (Sentry)*.
- **Confidence:** EXTRACTED.
- **Why:** `includeLocalVariables:true` serializes every stack-frame local on an unhandled error — in these handlers that includes the service-role Supabase client, user emails, `CRON_SECRET` comparisons and request cookies. `sendDefaultPii:true` adds client IP and headers (incl. `Cookie` → session tokens). All sent to Sentry. Highest-value seam leak in the repo. Client-side replay + `sendDefaultPii` additionally records authenticated `/me` and `/admin` sessions.
- **Recommendation:** Set `includeLocalVariables:false` in prod; add a `beforeSend` that strips `Authorization`/`Cookie` headers and secret-named vars; reconsider `sendDefaultPii`; scope replay away from authenticated routes.

### C2 · Forgeable profile ownership → identity pre-takeover
- **Where:** `libraries/database/src/claim.ts:299` (`decideInitialClaimKind` returns `owner` whenever `created`); reached via `apps/frontend/src/app/api/profiles/route.ts:158-169`. Plus RLS gap in `supabase/migrations/20260529000001_profile_claim.sql:53-55` (`with check (auth.uid()=user_id)` — no `claim_kind` restriction).
- **Confidence:** EXTRACTED.
- **Why:** The first signed-up user to add any not-yet-tracked social URL becomes its verified `owner` with zero proof of control. Owned profiles are hidden from others' auto-discovery and the `profile_claim_one_owner` index permanently locks out the legitimate creator. Independently, because the INSERT policy ignores `claim_kind`, a user can skip the server path entirely and insert `claim_kind='owner', confirmed_at=now()` straight from the browser with the publishable key.
- **Recommendation:** Don't grant `owner` on `created` alone — default to `pending`/`unverified` until handle ownership is proven. Restrict the RLS INSERT to non-owner kinds: `with check (auth.uid()=user_id AND claim_kind IN ('tracker','pending'))`; let `owner` be set only by service-role/`is_admin()`.

### C3 · SSRF via redirect-following in the image proxy
- **Where:** `apps/frontend/src/app/api/proxy-image/route.ts` — allowlist at `:151` (`isAllowedHost`, `:78`), fetch at `:169`. Graph community *Image Proxy Route*.
- **Confidence:** EXTRACTED.
- **Why:** Only the user-supplied initial URL is allowlist-checked; the fetch uses Node's default `redirect:'follow'`. An allowlisted CDN (or open redirector on one) returning a 30x to `http://169.254.169.254/...` or an internal host is followed server-side. The `image/*` gate blocks reading the body but the internal request still fires (blind SSRF; DNS-rebinding is a secondary vector since the host is validated once and re-resolved by `fetch`).
- **Recommendation:** Use `redirect:'manual'`, re-validate each `Location` host against `isAllowedHost` before following (with a hop cap), and reject private/link-local/loopback IPs after resolution.

### C4 · ~1.5 MB dead Postiz code shipped to users
- **Where:** `apps/frontend/public/f.js` (539 KB, 82 nodes incl. god-nodes `a()/b()/l()/i()/h()`, community *Minified f.js Bundle*) · `libraries/react-shared-libraries/src/translation/` (16 locales × 685 keys ≈ 915 KB; communities *Translation Keys #1–16*, *i18n Locale Set*, *i18n Translation Service*).
- **Confidence:** EXTRACTED.
- **Why:** `f.js` is unreferenced anywhere in `apps/frontend/src` (only mention is its `.coderabbit.yaml` exclusion) yet sits in `public/` and deploys. The i18n stack's only consumer, `TranslatedLabel`, is **never imported**; the locale keys are pure Postiz vocabulary (`100_no_risk_trial`, `connect_you_bank_account`). The whole `react-shared-libraries` package exists only to host this dead code. Together they are ~8,100 of the graph's 8,798 isolated nodes — i.e. the graph is mostly cruft.
- **Recommendation:** Delete `public/f.js` (+ its CodeRabbit exclusion); delete the `translation/` tree, the duplicate `apps/frontend/src/components/ui/translated-label.tsx`, the orphan `react-shared-libraries` package, and the `@gitroom/react/*` alias. (Branch `chore/scrub-postiz-i18n` already started this — finish it.)

---

## 🟡 Worth fixing

### Backend / data integrity

- **B1 · Public RLS exposes raw vendor payloads** — `supabase/migrations/20260527135229_init_v1_core_tables.sql`. EXTRACTED. Public SELECT grants `anon` the `raw jsonb` column. → Drop `raw` from the public path (column grant or a public view omitting it); keep it service-role only. *(Elevated to Top 5 #4.)*

- **B2 · `findOrCreateProfile` race recovery ignores the handle-unique constraint** — `libraries/database/src/claim.ts:127-145` vs `supabase/migrations/20260529000000_profile_url_uniqueness.sql`. INFERRED. The `23505` catch re-selects **by URL only**; a violation of `profile_platform_handle_unique` (same handle, different URL) then returns the phantom "Race recovery returned no row." `addProfile` (`profile.ts:73`) has the same blind spot. → Branch on constraint name in the handler; give handle collisions a distinct error.

- **B3 · Global per-platform handle uniqueness may be too strict** — `supabase/migrations/20260529000000_profile_url_uniqueness.sql:18`. INFERRED. `profile_platform_handle_unique` is global across all creators, but `addProfile` is built to allow multiple profiles per `(creator, platform)` via nickname. Two creators with handles folding to the same lowercase string hard-fail. → Confirm the product rule; if not intended, drop it and rely on the URL-unique index.

- **B4 · TS handle-folding diverges from the SQL index; the index is unused** — `libraries/database/src/profile-url.ts:173-178` vs `supabase/migrations/20260529000001_profile_claim.sql:42-44`. EXTRACTED. `normalizeHandle` strips suffixes (`official|real|tv|ig|tt`); the SQL fold doesn't — so the "SQL = TS" comment is false. Moot today because `findCandidatesByHandle` scores in JS via `.ilike('%…%')` and never touches the `profile_handle_folded`/GIN indexes (they're dead weight). → Either push scoring into an RPC that uses the indexes (and align the fold), or drop the indexes and fix the comment.

- **B5 · Three overlapping purge mechanisms** — pg_cron `purge-snapshots` (`...010000`) + pg_cron `purge-snapshots-6mo` (`...000003`, later unscheduled) + Vercel route `/api/cron/archive-and-purge`. EXTRACTED. The two pg_cron jobs are de-conflicted, but a Vercel archive-purge (02:30 UTC) and a pg_cron net (03:00 UTC) do overlapping DELETEs; only the Vercel path logs to `archive_run`. → Document the dual-purge contract; ensure the pg_cron net can't delete rows mid-archive.

- **B6 · Daily cron silently caps at 5 profiles/run** — `apps/frontend/src/app/api/cron/daily-snapshot/route.ts:49` (`PROFILES_PER_RUN=5`). EXTRACTED. Sequential ~50 s scrapes under a 300 s budget; profiles beyond 5 defer to the next day, so >5 active profiles breaks the "daily" guarantee. `listScrapeableProfiles` also orders by `created_at` then the route re-sorts by `last_scraped_at` in JS (wasted DB order). → Move `ORDER BY last_scraped_at NULLS FIRST LIMIT n` into the query; raise the cap or shard/queue the cron. *(Production-relevant — see Top 5 note.)*

### Cross-cutting / auth

- **X1 · `admin/cron-health` is gated by `CRON_SECRET`, not admin role** — `apps/frontend/src/app/api/admin/cron-health/route.ts`. EXTRACTED. Not exploitable (high-entropy server-only secret) but conflates the cron trust domain with the admin one. → Put it behind `is_admin()`+cookie, or rename/document it as a cron-secret ops endpoint.

- **X2 · API routes echo raw upstream/Postgres error messages** — e.g. `scrape/[profileId]/route.ts:94`, claim/profiles/cron routes. EXTRACTED. Leaks schema/internal detail to clients (mostly authenticated surfaces). → Return generic client messages; log detail server-side.

> **Verified-secure (leads closed, no action):** open-redirect guard `lib/redirects.ts` is real and correct; the three `assertAuth()` cron checks are byte-identical and timing-safe; `user_role` RLS fails closed (no self-promotion); `is_admin()` reads `auth.uid()` (not spoofable); the substring admin-email escalation was found & fixed by migrations `...000001/000002/120000`; `POST /api/scrape/[profileId]` has no IDOR; service-role client never reaches the client bundle; `proxy.ts` is the correct Next.js 16 middleware rename, not dead code.

### Frontend

- **F1 · `PlatformKey` domain type lives in a UI icon file** — `apps/frontend/src/components/ui/platform-icons.tsx:83` (god node, 25 edges, bridges 7 communities). EXTRACTED. The core platform enum sits in a presentational SVG module that server/query code must import. → Move `PlatformKey` (+ `PLATFORM_LABELS`) to a domain module (`lib/platforms.ts` or `@d3/database`); keep only icons in the component. *(Found independently by A, C, D.)*

- **F2 · Three+ divergent "platform" unions + a 4th inline copy** — `PlatformKey` (UI, uses `xiaohongshu`) vs `Platform` in `libraries/scrapers/src/types.ts` and `libraries/database/src/types.ts` (use `rednote`) vs an inline `type Platform` in `me/profiles/add-profile-form.tsx:20`. EXTRACTED. Hand-maintained, so the type system can't catch drift — which is why the `rednote→xiaohongshu` mapper had to be triplicated. → One canonical DB `Platform`, one `PlatformKey` view-type, one mapping function.

- **F3 · `rednote→xiaohongshu` mapper triplicated** — `lib/queries.ts:31`, `admin/profiles/page.tsx:44`, `me/creator-stats.tsx:24` (3 `toPlatformKey()` nodes). EXTRACTED. One missed site = wrong icon/label for RedNote. → Define once beside `PlatformKey`.

- **F4 · `viaProxy()` (image-proxy URL rewriter) duplicated** — `lib/queries.ts:23` and `me/creator-stats.tsx:27`. EXTRACTED. Security-relevant helper that can drift. → Hoist to `lib/media.ts`.

- **F5 · Client-side mock generator ships in the bundle on a now-live route** — `creators/[id]/[platform]/page.tsx` passes real posts, but `content-grid.tsx:7,28` still imports/calls `getCreatorPosts()` (caption banks, sample MP4s, PRNG) as a `'use client'` fallback. EXTRACTED. The page already renders an empty state, so the mock branch is dead in prod but still bundled. → Make `posts` required / drop the fallback so `content-data.ts` tree-shakes out.

- **F6 · CLAUDE.md rules diverge from reality** — EXTRACTED/INFERRED. (a) "SWR, each useSWR in its own hook" — no real `useSWR` exists; all fetching is server-side via `lib/queries.ts` async Server Components (a fine choice, but the doc is wrong). (b) "Login-free social analytics" — there is full cookie auth, an admin gate, a creator portal, and a `user_role` lookup in middleware; only the public showcase is anonymous. → Update CLAUDE.md to match.

### Code quality

- **Q1 · `assertAuth()` copy-pasted across 3 routes** — `cron/daily-snapshot/route.ts:60`, `cron/archive-and-purge/route.ts`, `admin/cron-health/route.ts`. EXTRACTED. Security-sensitive code with no single source of truth. → Extract `assertCronAuth(request)`.

- **Q2 · Scrape-write pipeline duplicated** — `cron/daily-snapshot/route.ts:126-159` vs `scrape/[profileId]/route.ts:119-158` (`semantically_similar_to` INFERRED 0.85). Same `runScraper → upsertProfileSnapshot → upsertPostSnapshots → setProfileStatus` + identical catch mapping. → Extract `scrapeAndPersist(profile)`.

- **Q3 · Stale "Apify" in user-facing legal pages** — `(public)/privacy/page.tsx:119`, `terms/page.tsx:133` still tell users data is fetched via Apify (removed 2026-05-29; now TikHub/BrightData). EXTRACTED. Factual/legal inaccuracy in shipped pages. → Update to TikHub/BrightData (and sweep code comments).

- **Q4 · Apify-named error classes are dead** — `libraries/scrapers/src/errors.ts:44-68`, re-exported `index.ts:11-13`. EXTRACTED. `ApifyTimeoutError/EmptyResultError/ThrottledError` are never thrown (clients build `ScrapeError` directly); the "retained for stability" comment is moot. → Delete, or rename to `Upstream*Error` and actually throw them.

- **Q5 · Two ESLint configs; root disables dead-code rules; no `lint` script** — root `eslint.config.mjs` vs `apps/frontend/eslint.config.mjs` (`semantically_similar`). EXTRACTED. Root config silences `no-unused-vars`/`no-explicit-any`/`ban-ts-comment` — the very rules that would have surfaced this report's dead code — and there's no root `lint` script despite CLAUDE.md saying "lint runs from root." → Consolidate to one config, re-enable `no-unused-vars`, add a `lint` script.

- **Q6 · Stale `@gitroom/*` path aliases** — `tsconfig.base.json:28-29`, `components.json:14-18`. EXTRACTED. `@gitroom/frontend/*` works (~80 imports) but the name is Postiz residue; `@gitroom/react/*` points only at the dead i18n package. → Drop `@gitroom/react/*`; rename `@gitroom/frontend/*` → `@d3/frontend/*` as a follow-up.

---

## 🟢 Minor

- **Four root layouts duplicate `<html>/<body>`/head wiring** — `(public|creator|admin|auth)/layout.tsx`. Drift risk on head/meta fixes. → Optional shared `RootShell`.
- **Orphan duplicate component** — `apps/frontend/src/components/reactbits/dotted-surface-canvas.tsx` (graph degree 1, no importers; live effect is `dotted-surface.tsx`). → Delete after confirming no dynamic import.
- **Heavy Three.js/shader effects on public pages** — `Dither.tsx`, `dotted-surface.tsx`, `d3-logo-particles.tsx` on `(public)/page.tsx`. Reduced-motion fallback exists. → Confirm `next/dynamic` + in-view gating; ensure the fallback also avoids loading Three.js.
- **Dashboard live mode mixes real totals with seeded sparkline** — `dashboard-showcase.tsx` keeps demo `growthSeries` + hardcoded `engagementRateDelta:0` ("Preview"-labeled). → Track as TODO tied to a time-series query.
- **`looksLikeNotFound`/`looksLikePrivate` duplicated with divergent keywords** — `tikhub-client.ts:76-91` vs `brightdata-client.ts:80-93`. Arguably intentional per-vendor. → Cross-reference comment so they don't silently drift.
- **`jsonError()` repeated across route handlers.** → One shared util.
- **Instagram adapter: unused `POSTS_PER_SCRAPE=30` + mislabeled `sourceId:'tikhub:instagram/v3'`** (posts actually come from V2) — `libraries/scrapers/src/adapters/instagram.ts:42,279`. → Remove constant; fix `sourceId`.
- **`(public)/dev/logo-preview/` dev route ships to prod** (AMBIGUOUS intent). → Confirm/gate.
- **7 tsconfig files / config sprawl** — mostly justified per-package; 2 are the dead `react-shared` package's (removed with it). 
- **No working unit-test runner** — root `jest.config.ts` uses `getJestProjects()` but no project under `apps/` or `libraries/` ships a jest config, so `pnpm test` discovers zero projects (even `libraries/database/src/claim.test.ts` doesn't actually run). Test deps (`jest`/`ts-jest`/`@types/jest`) live only at the repo root, not per-package. EXTRACTED. → Add per-package jest configs + declare test deps where tests live; wire a real `test` script. *(Surfaced while fixing C1, which had to add `apps/frontend/jest.config.ts` to make a unit test runnable.)*
- **Snapshot "one per day" is a UTC-day boundary** (`current_date`/`now()` defaults) — fine given 02:00 UTC cron; note for non-UTC reporting.
- **CSP `img-src` vs proxy `ALLOWED_SUFFIXES` mismatch** (`.scdn.cc`/`picsum.photos` in CSP, not in proxy) — no security impact; reconcile for clarity.

---

## God-node accounting (success criterion 1)

| God node | Edges | Verdict |
|---|---|---|
| `getSupabaseAdmin()` | 32 | Real core abstraction; service-role usage correctly scoped (B). |
| `a()`, `b()`, `l()`, `i()`, `h()` | 23-31 | **Noise** — minified `public/f.js`; delete (C4). |
| `profile table` | 27 | Real schema hub; raw-payload exposure (B1). |
| `compilerOptions` | 26 | Config noise (7 tsconfigs); mostly justified (Q-minor). |
| `PlatformKey` | 25 | Misplaced in UI file + divergent unions (F1/F2). |
| `getSupabaseRoute()` | 25 | Real cookie-aware SSR client; auth verified correct (C). |

## Critical paths traced end-to-end (success criterion 2)
Daily-snapshot cron (CRON_SECRET → list → runScraper → upserts → status) · scrape-by-profileId route (near-duplicate, `is_admin()` auth) · profile add/claim/discovery · auth signup → callback → `/me` · role routing (proxy middleware + layout gates) · `/me` dashboard (`getCreatorMetrics` → `resolveCreatorProfiles`) · image proxy · archive-and-purge retention. All traced via the graph and confirmed in source.

---
*Generated from `graphify-out/graph.json` + `GRAPH_REPORT.md`. No source files were modified.*
