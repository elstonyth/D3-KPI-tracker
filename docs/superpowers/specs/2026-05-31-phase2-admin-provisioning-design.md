# Phase 2 — Admin Top-30 + Creator Provisioning + Kill Signup

**Date:** 2026-05-31
**Status:** Approved design. Ready for plan.
**Branch:** `feat/phase2-admin-provisioning` (off `main`; PR #5 merged as `34ad857e`).
**Parent initiative:** [2026-05-30-views-over-engagement-overview.md](2026-05-30-views-over-engagement-overview.md) · **Handoff:** [PHASE2-HANDOFF.md](PHASE2-HANDOFF.md)

## 1. Goal

Shift account management from creators to admins, and surface the agency's headline rankings:

1. **Admin Top-30** — rebuilt `/admin` dashboard showing top 30 creators by 30-day follower growth and top 30 content items by 30-day views. No engagement (private-only per locked decision).
2. **Creator provisioning** — admin creates a creator's login (email + password) and assigns social URLs in one form.
3. **Kill public signup** — remove the `/signup` route, form, and CTAs; redirect `/signup → /login`. Login stays.

This is the write-access shift: creators stop self-serving accounts. Phase 3 finishes the lockdown (delete `/me/profiles`, read-only `/me/account`).

## 2. Scope boundaries

**In scope:** rebuilt `/admin` page, a provisioning form + server action, removal of signup surfaces, two small pure helpers + their unit tests, generalizing `ViewLeaderboard` with optional title props.

**Out of scope (do NOT touch):**
- `/admin/profiles` review page and its actions (`approveClaim`/`rejectClaim`/`deleteProfile`) — left as-is.
- `(auth)/onboarding/` — becomes unreachable once signup dies, but its deletion belongs to **Phase 3** creator-lockdown cleanup. Flag it, don't delete it.
- `/me` creator surfaces — Phase 3.
- The `profile_claim` discovery/claim API routes — disabled-by-removal of signup is enough; their deletion is a later cleanup pass (per overview §"Out of scope").

**No database migration.** Provisioning uses existing service-role helpers writing to existing tables, plus the existing `handle_new_auth_user()` trigger. This intentionally avoids the prod-write safety gate (CLAUDE.md).

## 3. Data layer consumed (already live, no changes)

From `apps/frontend/src/lib/metrics-windowed.ts` (Phase 0, migration `20260530000000_windowed_metrics_rpcs.sql`):

- `getCreatorMetricsWindowed(window, opts?)` → `CreatorMetricWindowRow[]`
  - Fields used: `creatorId, displayName, avatarUrl, primaryPlatform, primaryHandle, followers, followersDelta, insufficient`.
- `getTopContentWindowed(window, opts?)` → `TopContentRow[]`
  - Fields used by `ViewLeaderboard`: `externalPostId, creatorName, platform, handle, thumbnailUrl, viewsGained`.
- `opts.client` injects the client — admin passes `getSupabaseAdmin()` (service-role). `opts.limit` caps `getTopContentWindowed`.
- Both RPCs already exclude archived platforms (rednote) before aggregation.

From `@d3/database` (`libraries/database`):

- `getSupabaseAdmin()` — service-role client.
- `ensureCreatorForUser({ user_id, display_name? })` → `Result<{ creator_id, created }>`. Creates the `creator` row + binds `creator_link.creator_id` (idempotent; sets `onboarding_completed: true`).
- `findOrCreateProfile({ platform, profile_url, fallback_creator_id })` → `Result<{ profile, created }>`. Canonical lookup-or-insert via `validateProfileUrl`; returns the existing row if the URL is already tracked (no duplicate scrape job).
- `addProfileClaim({ user_id, profile_id, claim_kind, claimed_via })` → `Result<ProfileClaimRow>`. Idempotent.
- `validateProfileUrl(platform, url)` and `detectPlatform(url)` from `profile-url.ts`. `detectPlatform` returns the `Platform` or `null` from the URL host.
- Types: `Platform = 'instagram' | 'tiktok' | 'facebook' | 'rednote' | 'douyin'`; `ClaimKind = 'owner' | 'tracker' | 'pending'`; `ClaimedVia = 'manual' | 'auto_discovery' | 'admin_assigned'`.

The signup trigger `handle_new_auth_user()` fires on every `auth.users` insert (including service-role `auth.admin.createUser`): it inserts `user_role` (role = `'admin'` if email matches the `app.admin_emails` DB setting, else `'creator'`) and an empty `creator_link`. So provisioning a normal creator email yields `role='creator'` automatically.

Reused Phase 1 pieces:
- `apps/frontend/src/lib/format-metric.ts` → `formatWindowedValue(insufficient, value, formatter)`, `BUILDING_HISTORY`.
- `apps/frontend/src/lib/creator-metrics.ts` → `formatCompact`, `formatDelta`.
- `apps/frontend/src/lib/profile-name.ts` → `resolveProfileName(display_name, raw, handle)`.
- `apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx` → `ViewLeaderboard` (content grid).
- `apps/frontend/src/components/ui/platform-icons.tsx`, `components/ui/platform-pill.tsx`.

## 4. Architecture

### 4.1 Files

```text
apps/frontend/src/
  app/(admin)/admin/
    page.tsx                 [rewrite]  Top-30 dashboard + provisioning panel
    actions.ts               [new]      'use server' — createCreator action
    provision-form.tsx       [new]      'use client' — multi-URL form (useActionState)
    top30-creators.tsx       [new]      server-rendered dense leaderboard table
  lib/
    admin-top30.ts           [new]      rankCreatorsByFollowerDelta (pure) + types
    provision-plan.ts         [new]      parseProvisionUrls (pure) — detect+validate planner
    admin-top30.test.ts      [new]      unit tests (jest, relative imports)
    provision-plan.test.ts   [new]      unit tests
  components/leaderboard-showcase/
    view-leaderboard.tsx     [edit]     add optional title/subtitle props (defaults unchanged)
  app/(auth)/signup/page.tsx [delete]
  components/auth/sign-up-form.tsx [delete]
  app/(public)/layout.tsx    [edit]     remove Sign up CTAs (desktop + mobile)
  app/(auth)/login/page.tsx  [edit]     remove "Sign up as a creator" link
  proxy.ts                   [edit]     redirect /signup → /login; drop /signup from AUTH_PAGES
```

### 4.2 `/admin` dashboard (`page.tsx`)

Server Component, `force-dynamic`, `revalidate = 0`. Defense-in-depth role recheck (already present): `getAuthContext()`, redirect non-admins. Uses `getSupabaseAdmin()`.

Data fetch (parallel):
- existing counts: `creator`, `profile`, `user_role` (3 stat tiles, kept).
- `getCreatorMetricsWindowed('30d', { client: admin })`.
- `getTopContentWindowed('30d', { client: admin, limit: 30 })`.

Layout, top to bottom:
1. **Header** — kept (eyebrow chip, `text-display-2` headline, lede).
2. **Stat tiles** — `grid-cols-1 sm:grid-cols-3`. Each tile gains a bordered footer strip (`border-t border-borderGlass`) with a right-aligned "View accounts →" link to `/admin/profiles` (drill-in pattern from inspiration). Tiles stay `Link`s.
3. **Add creator panel** — `<ProvisionForm />` in a `glass-elevated` card section with a section heading "Provision a creator".
4. **Top-30 split** — `grid grid-cols-1 lg:grid-cols-2 gap-6`:
   - **Left:** `<Top30Creators rows={ranked} />` — `rankCreatorsByFollowerDelta(metrics).slice(0, 30)`.
   - **Right:** `<ViewLeaderboard rows={topContent} title="Top Content" subtitle="Top 30 by views · last 30 days" />`.

### 4.3 `Top30Creators` table (`top30-creators.tsx`)

Server component (pure render). Dense table inside a `glass-base`/`glass-subtle` card. Header row uppercase `text-micro` tracking (DESIGN.md §4 Tables — the only caps allowed). Columns:

| # | Creator | Platform | Followers | Δ30D |
|---|---------|----------|-----------|------|

- **#** — rank `01`…`30`, `font-mono tabular-nums`. Rank 1 gets a brand-tinted badge (matches `ViewLeaderboard` winner treatment).
- **Creator** — avatar (initial fallback) + `displayName`. Links to `/creators/<primaryHandle>` when `primaryHandle` is set.
- **Platform** — `PlatformPill` for `primaryPlatform` (map `rednote → xiaohongshu`).
- **Followers** — `formatCompact(followers)`, `tabular-nums`.
- **Δ30D** — `insufficient` → `BUILDING_HISTORY` ("Building history…") in `text-fgSubtle`; else `deltaCaret + formatDelta(followersDelta)` with `deltaClass` intensity (yellow-mono ▲/▼, never red/green — copy the helpers from `admin/profiles/page.tsx`).

No engagement column anywhere. Empty state: "No creators ranked yet — building history…".

### 4.4 Ranking helper (`admin-top30.ts`)

```ts
export function rankCreatorsByFollowerDelta(
  rows: CreatorMetricWindowRow[],
): CreatorMetricWindowRow[]
```

- Partition into **sufficient** (`!insufficient`) and **insufficient**.
- Sort sufficient by `followersDelta` desc (tie-break by `followers` desc, then `displayName` asc for stable order).
- Append insufficient (unsorted by delta — no baseline; stable by `followers` desc) **after** the ranked block.
- Rationale: a delta with no baseline is meaningless, so those creators can't be ranked by growth; they sit at the bottom showing "Building history…". Given the current DB has ~1 snapshot day, most rows will be insufficient today — correct per the locked decision (no fake deltas).

Pure function → unit-tested.

### 4.5 Provisioning (`actions.ts` + `provision-form.tsx` + `provision-plan.ts`)

**`parseProvisionUrls(rawUrls: string[])`** (pure, in `provision-plan.ts`) →
```ts
type UrlPlanItem =
  | { ok: true; platform: Platform; url: string }
  | { ok: false; url: string; error: string };
export function parseProvisionUrls(rawUrls: string[]): UrlPlanItem[]
```
For each non-empty trimmed URL: `detectPlatform(url)`; if null → error "Unrecognized platform"; else `validateProfileUrl(platform, url)` and surface its error or the normalized result. Dedupes by normalized URL. Unit-tested (valid IG/TikTok/FB, bad host, post-URL rejection, dupes).

**`createCreator(prev, formData)`** (`'use server'`, mirrors `profiles/actions.ts` conventions: `requireAdmin()`, return a result object, `getErrorMessage`, `revalidatePath`):

Returns:
```ts
interface ProvisionResult {
  ok: boolean;
  message: string;
  credentials?: { email: string; password: string };  // echoed once on success
  urlResults?: { url: string; platform?: string; status: 'created' | 'linked' | 'failed'; detail?: string }[];
}
```

Flow:
1. `requireAdmin()`.
2. Read `email`, `password`, `display_name`, and all `url` entries from `formData`. Validate: email present, password length ≥ 8, display name present. URL list may be empty (a creator can be provisioned with no profiles yet).
3. `getSupabaseAdmin().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name } })`.
   - On error (e.g. email already registered) → return `{ ok: false, message }`. **No partial state created** (this is the first write).
4. `ensureCreatorForUser({ user_id: newUser.id, display_name })` → `creator_id`. On error → return `{ ok: false, message }` (auth user exists but unlinked; re-running the same email will fail at step 3, so report clearly: "Login created but linking failed — contact support / retry profile add via /admin/profiles").
5. `parseProvisionUrls(urls)`. For each `ok` item:
   - `findOrCreateProfile({ platform, profile_url: url, fallback_creator_id: creator_id })`.
   - `addProfileClaim({ user_id, profile_id, claim_kind: 'owner', claimed_via: 'admin_assigned' })`.
   - Record per-URL `status`: `created` (new profile), `linked` (existing canonical profile), or `failed` (+ detail).
   - A single URL failure does **not** abort the others or the creator — collected into `urlResults`.
6. `revalidatePath('/admin')`.
7. Return `{ ok: true, message, credentials: { email, password }, urlResults }`.

**Idempotency / retry:** steps 4–5 are idempotent. If some URLs fail validation, the admin fixes them and re-adds via `/admin/profiles` (or the operation is safely repeatable). The auth user is never rolled back on a downstream URL failure — the login is the valuable artifact and email-in-use on a re-attempt is reported, not silently swallowed.

**`ProvisionForm`** (`'use client'`, `useActionState(createCreator, null)`):
- **Credentials group:** `Input`s for display name, email, password (`minLength={8}`), separated by a hairline `border-t` from the URL list.
- **URL list:** dynamic rows in local state. Each row = leading platform-icon slot (live `detectPlatform` preview, generic icon when unknown), URL `Input`, trailing remove (X/Trash) icon-button. "+ Add URL" ghost button appends a row. Rows render as hidden `name="url"` inputs on submit. Empty list allowed.
- **Submit:** primary yellow CTA right-aligned in a footer row (`flex justify-end`), disabled while `pending` ("Creating…").
- **Result rendering** (from action state):
  - Per-URL list with `StatusGlyphIcon` (check = created/linked, x = failed) + url + detail — yellow-mono, copying the `StatusPill` language from `admin/profiles/page.tsx`.
  - **Credentials echo panel** — `glass-elevated` card, email + password in `font-mono`, a "Copy" button (copies `email\npassword`), and a `text-caption text-fgSubtle` "Shown once — copy and share securely now." Disappears on the next submit.
  - Errors surfaced in `role="alert"` using the `danger` token (`brand-900`) + X glyph + label (no red).

### 4.6 `ViewLeaderboard` generalization

Add optional props, defaults preserve current Phase 1 output exactly:
```ts
export interface ViewLeaderboardProps {
  rows: TopContentRow[];
  title?: string;     // default 'Top Content'
  subtitle?: string;  // default 'Top 20 posts by views · last 30 days'
}
```
Admin passes `title="Top Content"`, `subtitle="Top 30 by views · last 30 days"`. No other change; the grid/card rendering is untouched.

### 4.7 Kill signup

- **`proxy.ts`:** at the top of the path logic (after the `/api` bail, before the auth-page/role branches), add: `if (pathname === '/signup') return NextResponse.redirect(new URL('/login', request.url));`. Remove `'/signup'` from `AUTH_PAGES`. The redirect runs for everyone (anon + authed) and works even after the route file is deleted (middleware precedes routing).
- **Delete** `app/(auth)/signup/page.tsx` and `components/auth/sign-up-form.tsx`. Git history is the archive (the overview's "archive don't delete" mandate covers backend/scraper/DB, not frontend route files).
- **`app/(public)/layout.tsx`:** remove the desktop "Sign up" CTA (the `<Link href="/signup">` in the `!auth` branch of the desktop nav) and the mobile "Sign up" CTA, leaving the "Sign in" link for anonymous users.
- **`app/(auth)/login/page.tsx`:** remove the trailing "Don't have an account? Sign up as a creator" paragraph.
- Verify no other live references to `/signup` remain (grep) besides the proxy redirect.

## 5. Design language (per DESIGN.md + inspiration)

- Surfaces: `glass-base`/`glass-subtle`/`glass-elevated` tokens; hairline `border-borderGlass`; radii ≤ `2xl`. No glow, no colored shadows except the input focus ring.
- **Yellow-mono everywhere:** deltas via caret glyph + `deltaClass` intensity (never red/green); status via `StatusGlyphIcon` (check/clock/x) + label; errors via `danger` (brand-900) + X glyph + label.
- Tables: uppercase `text-micro` header row (only allowed caps), `tabular-nums` numerics, hover `bg-white/[0.02]`.
- One primary yellow CTA per surface (the provision Submit).
- Responsive: tiles `grid-cols-1 sm:grid-cols-3`; Top-30 split `grid-cols-1 lg:grid-cols-2`; content grid inherits `ViewLeaderboard`'s `grid-cols-2 sm:3 lg:4 xl:5`.
- Reuse `PlatformPill`/`platform-icons`; map `rednote → xiaohongshu`; archived rednote stays hidden (RPCs already exclude it).

## 6. Testing & verification

**Unit (jest, frontend-scoped, relative imports only — path alias breaks ts-jest):**
- `admin-top30.test.ts` — `rankCreatorsByFollowerDelta`: sufficient sorted desc, ties broken deterministically, insufficient appended last, empty input.
- `provision-plan.test.ts` — `parseProvisionUrls`: valid IG/TikTok/FB detection+normalization, unknown host → error, post-URL rejection, duplicate collapse, empty/whitespace entries skipped.

**Type/build gates:**
- `pnpm --filter ./apps/frontend exec tsc --noEmit`
- `pnpm --filter ./apps/frontend exec jest`
- `pnpm --filter ./apps/frontend run build` (source `.env` first: `set -a && . ./.env && set +a`).

**Manual (Preview MCP, `preview` launch config):**
- Log in as `admin@d3.test` / `Passw0rd!`. Confirm `/admin` shows tiles + provision panel + both Top-30 columns; mostly "Building history…" today (expected — ~1 snapshot day).
- Provision a test creator (unique email, ≥1 valid URL). Confirm: success message, credentials panel, per-URL statuses; the creator appears under `/admin/profiles`; logging out and into the new creator's email+password works immediately (no confirmation email).
- Hit `/signup` → 307 to `/login`. Confirm no "Sign up" CTAs in the public header (desktop + mobile) or on `/login`.

## 7. Self-check (from original task)

- [x] Admin can create a creator login + assign URLs → §4.5.
- [x] Public signup is gone → §4.7.
- [x] Top-30 shows content items + creator stats, no engagement → §4.2–4.4.

## 8. Risks & mitigations

- **`auth.admin.createUser` succeeds but `ensureCreatorForUser` fails** → orphan auth user (login exists, no creator). Mitigation: clear error message; admin can finish the link by adding a profile through `/admin/profiles` (which calls `ensureCreatorForUser` via the existing add flow) or the action is re-runnable once the transient cause clears. Not auto-rolled-back by design.
- **Generalizing `ViewLeaderboard`** could regress Phase 1 public pages. Mitigation: new props are optional with defaults equal to the current hardcoded strings; verify the public `/dashboard`/`/leaderboard` still render the original copy.
- **Orphaned `(auth)/onboarding/`** after signup death. Mitigation: out of scope; flagged for Phase 3. It remains reachable only by direct URL and harms nothing.
