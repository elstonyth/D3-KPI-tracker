# Phase 3 — Creator Lockdown

**Date:** 2026-05-31
**Status:** Approved design. Ready for plan.
**Branch:** `feat/phase3-creator-lockdown` (off `main`; Phases 0/1/2 merged).
**Parent initiative:** [2026-05-30-views-over-engagement-overview.md](2026-05-30-views-over-engagement-overview.md)

## 1. Goal

Complete the write-access shift started in Phase 2. After this phase, creators can **view** their data but **cannot manage accounts** — the agency (admin) owns all provisioning and edits.

1. **`/me` → 3-stat windowed dashboard** — Followers, Views, Engagement, driven by **one shared 7D/30D/90D/Lifetime selector** (Phase 0 windowed metrics). Engagement is private here (removed from public + admin in Phases 1–2).
2. **`/me/account` → read-only** — "Managed by your agency" notice; display name no longer creator-editable.
3. **Delete `/me/profiles`** — creators can no longer add/remove/claim profiles. Redirect stale hits to `/me`.
4. **Lock down creator write APIs** — `/api/profiles`, `/api/profiles/claim`, `/api/profiles/discover` return **410 Gone**.

## 2. Locked decisions (from brainstorm 2026-05-31)

- Window selector: **URL-as-state** (`?window=`), server re-render, pure server `<Link>` tabs (no client data-fetching).
- `/me` body: **3 KPIs + windowed top content only** — drop the per-platform breakdown and the Likes/Posts tiles.
- Write APIs: **disabled now (410)**, not left callable.
- `/me/profiles`: **redirect → `/me`** (consistent with Phase 2's `/signup → /login`), not a 404.

## 3. Scope boundaries

**In scope:** the four items above, plus the orphan/CTA cleanup their changes require.

**Out of scope (do NOT touch):**
- `/me/leaderboard` redesign — **only** fix its `/me/profiles` empty-state CTA; leave the rest as-is.
- `profile_claim` table + rows — untouched (overview data-safety: write endpoints *disabled*, not dropped). Deleting the claim/discover routes entirely is a later cleanup pass.
- Admin surfaces (`/admin`, `/admin/profiles`) — unaffected; admin writes go through service-role server actions, not these APIs.
- The admin account-editor follow-up (`feat/admin-account-editor`) — separate, parked.

**No database migration.** All changes are frontend route/component edits + API-route handler swaps.

## 4. Data layer consumed (already live)

From `apps/frontend/src/lib/metrics-windowed.ts` (Phase 0):
- `getCreatorMetricsWindowed(window, { client, creatorIds })` → `CreatorMetricWindowRow[]`. Scope to the signed-in creator with `creatorIds: [creatorId]`; use the **cookie-aware** route client (`getSupabaseRoute()`), not service-role — the windowed RPCs read public-RLS tables.
  - Fields used: `followers`, `followersDelta`, `viewsGained`, `engagement`, `insufficient`.
- `getTopContentWindowed(window, { client, creatorIds, limit })` → `TopContentRow[]`.
- `MetricWindow = '7d' | '30d' | '90d' | 'lifetime'`.

Reused:
- `apps/frontend/src/lib/format-metric.ts` → `formatWindowedValue(insufficient, value, formatter)`, `BUILDING_HISTORY`.
- `apps/frontend/src/lib/creator-metrics.ts` → **keep** `resolveCreatorProfiles`, `formatCompact`, `formatDelta`, `formatPercent`. **Remove** `getCreatorMetrics` + the `CreatorMetrics` / `TopPost` types (orphaned by this phase — see §5.6).
- `apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx` → `ViewLeaderboard` (windowed top-content grid; optional `title`/`subtitle` added in Phase 2).
- `apps/frontend/src/components/ui/empty-state.tsx` → `EmptyState` (its `action` prop is optional).

## 5. Architecture

### 5.1 Files

```text
apps/frontend/src/
  app/(creator)/
    layout.tsx                       [edit]   remove "Profiles" NavLink
    me/
      page.tsx                       [rewrite] 3-KPI windowed + selector + top content; null guard; new empty state
      window-tabs.tsx                [new]     server component — <Link> tab row for ?window=
      creator-stats.tsx              [rewrite] windowed 3-KPI body (replaces scalar CreatorStats)
      account/
        page.tsx                     [edit]   read-only display name + "Managed by your agency"
        account-form.tsx             [delete]
        actions.ts                   [delete]
      profiles/                      [delete]  page.tsx, add-profile-form.tsx, actions.ts, remove-claim-button.tsx
      leaderboard/page.tsx           [edit]   drop the /me/profiles empty-state action only
  app/api/profiles/
    route.ts                         [edit]   POST → 410 Gone
    claim/route.ts                   [edit]   POST → 410 Gone
    discover/route.ts                [edit]   POST → 410 Gone
  lib/
    creator-metrics.ts               [edit]   remove getCreatorMetrics + CreatorMetrics/TopPost types
    me-window.ts                     [new]    parseWindowParam + WINDOW_LABEL pure helpers
    me-window.test.ts                [new]    unit tests
  proxy.ts                           [edit]   redirect /me/profiles → /me
```

### 5.2 `/me` page (`page.tsx`)

Server Component, `force-dynamic`, `revalidate = 0`. Signature takes `searchParams: Promise<{ window?: string }>`.

1. `getAuthContext()`; redirect anon → `/login`, admin → `/admin` (unchanged).
2. `const creatorId = auth.creatorLink?.creator_id ?? null;` — **null guard:** if `!creatorId`, render the empty state (§5.5) and return. This fixes the current latent `auth.creatorLink.creator_id` access and is the correct UX for an un-provisioned creator.
3. `const window = parseWindowParam(await searchParams);` (default `30d`). `me-window.ts` also exports `WINDOW_LABEL = { '7d': '7D', '30d': '30D', '90d': '90D', lifetime: 'Lifetime' }`, the single source for the tab labels (§5.3) and the top-content subtitle.
4. Cookie-aware client `sb = await getSupabaseRoute()`.
5. Parallel fetch:
   - `const [row] = await getCreatorMetricsWindowed(window, { client: sb, creatorIds: [creatorId] });`
   - `const topContent = await getTopContentWindowed(window, { client: sb, creatorIds: [creatorId], limit: 12 });`
6. If `!row` (creator exists but has no profiles/metrics yet) → empty state (§5.5).
7. Else render: header, `<WindowTabs current={window} />`, `<CreatorStats row={row} />`, and the windowed `<ViewLeaderboard rows={topContent} title="Top content" subtitle={`Top by views · ${WINDOW_LABEL[window]}`} />`.

Header copy: drop the "manage your URLs" link; reword to a passive "Live stats across the accounts your agency manages for you."

### 5.3 Window selector (`window-tabs.tsx`)

Pure server component. Renders four `<Link href={`/me?window=${w}`} scroll={false}>` tabs (`7D / 30D / 90D / Lifetime`). Active tab (`current === w`) gets the brand-tinted style; others neutral — reuse the chip styling from `/admin/profiles` platform chips (`bg-brand/10 text-fg border-brand/20` vs `bg-white/[0.04] text-fgMuted`). No client JS.

### 5.4 `CreatorStats` (`creator-stats.tsx`, rewritten)

Props: `{ row: CreatorMetricWindowRow }`. Renders **3 KPI tiles** (`grid-cols-1 sm:grid-cols-3`):
- **Followers** — `formatCompact(row.followers)` (absolute, window-independent) + a sub-line `deltaCaret + formatDelta(row.followersDelta)` for the window, or `BUILDING_HISTORY` when `row.insufficient` (yellow-mono caret/intensity helpers, copied as in `top30-creators.tsx`).
- **Views** — `formatWindowedValue(row.insufficient, row.viewsGained, formatCompact)`.
- **Engagement** — `formatWindowedValue(row.insufficient, row.engagement, formatPercent)`, hint "likes ÷ views". Private to `/me`.

No Likes/Posts tiles, no per-platform breakdown. The old `Kpi`/`TopPostCard`/`Stat` helpers are removed (top content now comes from `ViewLeaderboard`).

### 5.5 Empty state (no creator / no profiles)

`EmptyState` with **no `action`** (creators can't add profiles). Title "Your accounts are being set up", description "Your agency adds and manages your social accounts. Your stats will appear here once they're connected." Keep the informational platform-icon row (Instagram/TikTok/Facebook/Douyin).

### 5.6 `lib/creator-metrics.ts` orphan removal

`getCreatorMetrics` is consumed only by the old `/me/page.tsx`; `CreatorMetrics` and `TopPost` types only by the old `creator-stats.tsx`. After §5.2/§5.4 replace those, delete `getCreatorMetrics` and the two types. **Keep** `resolveCreatorProfiles` (used by `/me/leaderboard`) and the three formatters (used app-wide). Verify with a grep that no other consumer remains before deleting.

### 5.7 `/me/account` read-only (`account/page.tsx`)

- Replace `<AccountForm defaultDisplayName={displayName} />` with a read-only block: the display name as `text-body text-fg` plus a `text-caption text-fgSubtle` "Managed by your agency — contact them to change it." Keep the section heading.
- Keep the Identity section (email + `SignOutButton`).
- "Tracked profiles" section: keep the count, reword line away from "add from the Profiles tab" → "{n} account(s) managed by your agency."
- **Delete** `account-form.tsx` and `account/actions.ts` (the `updateDisplayName` action + its `ensureCreatorForUser` self-provision path are gone; provisioning is admin-only now). Confirm no other importer.

### 5.8 Delete `/me/profiles` + redirect

- `git rm` the four files under `me/profiles/`.
- `proxy.ts`: after the `/api` bail and the existing `/signup` redirect, add `if (pathname === '/me/profiles') return NextResponse.redirect(new URL('/me', request.url));`. Middleware runs before routing, so this works after the files are gone (and catches `/me/profiles` for authed creators; anon falls through to the existing creator-route → `/login` rule).
- `(creator)/layout.tsx`: remove the `<NavLink href="/me/profiles">Profiles</NavLink>`.

### 5.9 Lock down write APIs (410)

For each of `api/profiles/route.ts`, `api/profiles/claim/route.ts`, `api/profiles/discover/route.ts`: replace the `POST` handler body with a 410 response:
```ts
export async function POST(): Promise<Response> {
  return new Response(
    JSON.stringify({ error: 'Creator profile management has moved to your agency admin.' }),
    { status: 410, headers: { 'content-type': 'application/json' } },
  );
}
```
Remove now-unused imports in those files (the old handlers' deps). These routes have no other methods and no remaining in-app callers (sole caller `add-profile-form.tsx` is deleted), so this is defense-in-depth against direct requests.

### 5.10 `/me/leaderboard` CTA fix

In `leaderboard/page.tsx`, change the `EmptyState` `action={ids.length === 0 ? { href: '/me/profiles', label: 'Add a profile' } : undefined}` to **always `undefined`** (drop the prop), and soften the empty-state copy to not imply self-add. No other change to that page.

## 6. Design language (DESIGN.md)

- Yellow-mono throughout: deltas via caret glyph + intensity (never red/green); `insufficient` → `BUILDING_HISTORY`. Active window tab uses the brand tint (`bg-brand/10`); inactive neutral.
- Surfaces: `glass-elevated`/`glass-subtle`, hairline `border-borderGlass`, radii ≤ `2xl`, `tabular-nums` on all figures.
- Reuse `ViewLeaderboard`, `PlatformPill`, `EmptyState` — no new visual primitives.

## 7. Testing & verification

**Unit (jest, frontend-scoped, relative imports):**
- `me-window.test.ts` — `parseWindowParam`: each valid window passes through; missing → `30d`; junk/unknown → `30d`.

**Type/build gates:**
- `pnpm --filter ./apps/frontend exec tsc --noEmit`
- `pnpm --filter ./apps/frontend exec jest`
- `pnpm --filter ./apps/frontend run build` (source `.env` first).

**Manual (Preview MCP, log in as `creator@d3.test` / `Passw0rd!`):**
- `/me` renders 3 KPIs + window tabs + top content; switching tabs changes `?window=` and the figures; mostly "Building history…" today (~1 snapshot day — expected). No Likes/Posts tiles, no by-platform list.
- `/me/account` shows read-only display name + "Managed by your agency"; no editable form/save.
- `/me/profiles` → 307 `/me`; no "Profiles" tab in the creator nav; no "Add a profile" CTA on `/me` or `/me/leaderboard`.
- `curl -X POST` each of the three APIs → **410**.

## 8. Self-check

- [x] `/me/profiles` deleted; creators can't add accounts → §5.8, §5.9.
- [x] `/me/account` read-only → §5.7.
- [x] `/me` = 3 stats + shared 7D/30D/90D/Lifetime selector → §5.2–5.4.
- [x] Engagement present on `/me` only (already absent from public/admin) → §5.4.

## 9. Risks & mitigations

- **Cookie-aware client + windowed RPC returns nothing** → handled by the `!row`/`!creatorId` empty-state guards; the RPCs read public-RLS tables so an authenticated creator can call them.
- **Removing `getCreatorMetrics`/types** could break an unseen consumer → grep-verify before deletion (§5.6); keep `resolveCreatorProfiles` + formatters.
- **Proxy redirect ordering** → place the `/me/profiles` rule with the `/signup` rule (early, before role logic); double-hop for anon (`/me/profiles → /me → /login`) is acceptable.
- **Orphaned `(auth)/onboarding/`** (noted in Phase 2) remains out of scope; still reachable only by direct URL, harmless.
