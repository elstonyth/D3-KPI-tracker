# /me Per-Platform Cards + Drill-Down — Design

**Status:** Draft for review
**Date:** 2026-06-24
**Replaces:** the earlier inline-`InsightsPanel` draft (`2026-06-23-hybrid-creator-dashboard-design.md`) — that approach embedded full owned cards on `/me`; this one uses compact cards that drill into the existing per-platform page.
**Scope:** The logged-in creator's `/me` dashboard only. Public dashboard and admin public-display control are out of scope.

## 1. Goal

On `/me`, below the existing combined KPIs + top content, add a **per-platform section**: one **compact card** per platform the creator has (Instagram, Facebook, TikTok, Douyin). IG/FB surface **owned (OAuth)** followers when connected; TikTok/Douyin (and unconnected IG/FB) show **scraped**. Each card links to the existing **`/creators/{handle}/{platform}`** page, which already renders that platform's videos/reels with views.

This is an enrichment of `/me`, not a rebuild — the drill-down target already exists.

## 2. What already exists (do not rebuild)

- **`/me`** (`apps/frontend/src/app/(creator)/me/page.tsx`): auth → `creatorId` (`auth.creatorLink.creator_id`) + `metricWindow`; loads `getCreatorMetricsWindowed` + `getTopContentWindowed` with a cookie client scoped by `creatorIds: [creatorId]`; renders `WindowTabs` + `CreatorStats` (combined KPIs) + `ViewLeaderboard` (top content).
- **Per-platform drill-down**: `/creators/[id]/[platform]` (`(public)/creators/[id]/[platform]/page.tsx`) — `getCreatorPlatformDetail(id, platform)` resolves a creator by handle, shows Followers / Total Views / Total Likes + a `ContentGrid` of recent posts (views, hover-preview, click-to-open). `[id]` is any of the creator's handles; `/creators/[id]` lists platforms and links each to `/creators/{id}/{platform}`.
- **Owned insights**: `profile_claim` (`claim_kind='owner'`) + `getMyOwnedInsights(client, profileId, days)` → daily `ProfileDay[]` incl. `follower_total` (owner-guarded RPC).
- **Scraped per-(creator×platform×window) views**: `getDashboardViewTotalsWindowed` → `byCreator[creatorId][platform][window]`.
- **Scraped per-platform followers + handle**: a `creatorId`-scoped read of `profile` (`id`, `platform`, `handle`, `.neq('platform','rednote')`) plus the latest `profile_snapshot.followers` per profile — no full-table scan.
- **Platform icons/labels**: `PLATFORM_ICONS` / `PLATFORM_LABELS` / `PlatformKey`. RedNote (`xiaohongshu`) is archived and excluded everywhere.

## 3. Confirmed decisions

| Decision           | Choice                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| Platforms shown    | Instagram, Facebook, TikTok, Douyin (RedNote excluded)                                                   |
| IG/FB data         | Owned (OAuth) when connected, scraped fallback                                                           |
| TikTok/Douyin data | Scraped (TikTok owned deferred)                                                                          |
| Card content       | Compact: glyph · `@handle` · Followers · Views (window) · source badge · →                               |
| Followers source   | Owned `follower_total` for connected IG/FB; scraped otherwise                                            |
| Views source       | **Scraped for all** — per-platform; they total the creator's scraped views and match the drill-down page |
| Click target       | `/creators/{handle}/{platform}` (existing page)                                                          |
| Surface            | `/me` only                                                                                               |

**Why scraped views (not owned) on the card:** the `/me` header already shows combined views (scraped, this window); scraped per-platform views **decompose that total** (`getDashboardViewTotalsWindowed` returns both the per-platform figures and their per-creator `all` rollup) and match the scraped "Total Views" on the drill-down page. They are consistent with the headline combined KPI, though not guaranteed identical to the digit — that KPI is a separate RPC (`getCreatorMetricsWindowed`) that may apply cross-platform dedup. Owned Graph views would be a third, unrelated number. Owned value still shows via exact **followers**, the **"first-party" badge**, and the full owned depth on the Connections page.

## 4. Architecture

### 4.1 Resolver (new) — `apps/frontend/src/lib/creator-platform-breakdown.ts`

```ts
getCreatorPlatformBreakdown(
  window: MetricWindow,
  opts: { client: SupabaseClient; creatorId: string },
): Promise<PlatformCard[]>

interface PlatformCard {
  platform: PlatformKey;        // 'instagram' | 'facebook' | 'tiktok' | 'douyin'
  handle: string;               // builds the /creators/{handle}/{platform} link
  source: 'owned' | 'scraped';  // drives the badge
  followers: number | null;
  views: number | null;         // scraped window views
  syncing?: boolean;            // owner-claimed but owned rows not ingested yet
}
```

Resolution:

1. Load the creator's profile slots with a `creatorId`-scoped read: `profile` (`id`, `platform`, `handle`, `.neq('platform','rednote')`) + the latest `profile_snapshot.followers` per profile. Each slot = `{ profileId, platform, handle, followers }`. A slot with no `handle` is skipped (can't build the link).
2. Load owner claims `profile_claim.select('profile_id').eq('claim_kind','owner')` (RLS-scoped to this user) and **restrict to this creator's slot `profileId`s** — so a claim on another creator's profile can't attach here.
3. Scraped window views from `getDashboardViewTotalsWindowed({ client, creatorIds: [creatorId] })` → `byCreator[creatorId][platform][window]`.
4. Per platform card:
   - `views` = scraped window views (all platforms).
   - **IG/FB whose `slot.profileId` is owner-claimed** → `getMyOwnedInsights(client, slot.profileId, 1)`, wrapped in `.catch` so a transient RPC failure degrades to the scraped/syncing card (never rejecting the page's `Promise.all`):
     - ≥1 owned day → `source: 'owned'`, `followers` = latest `follower_total`.
     - zero owned days (or the RPC failed) → `source: 'scraped'`, scraped followers, `syncing: true`.
   - **otherwise** (unconnected IG/FB, TikTok, Douyin) → `source: 'scraped'`, scraped followers.
5. Order Instagram, Facebook, TikTok, Douyin (owned-capable first); omit platforms the creator does not have.

### 4.2 Component (new) — `apps/frontend/src/components/insights/platform-cards.tsx`

`PlatformCards({ cards }: { cards: PlatformCard[] })` — server component (no client state needed):

- Wrapped in a section ("Your platforms") matching the page's `glass`/hairline language.
- Each card is a `<Link href={`/creators/${encodeURIComponent(card.handle)}/${card.platform}`}>`:
  - Left: platform glyph in a circular `glass-base` container + `@{handle}` + `PLATFORM_LABELS[platform]`.
  - Right: Followers (compact) + Views (compact, window) + a badge — `✓ first-party` (`bg-brand/10 text-fg border-brand/20`) for `owned`, `Tracked` (neutral) for `scraped` — + a `→` chevron. `syncing` adds a subtle "Syncing…" caption.
  - Hover: `hover:border-borderGlassStrong hover:bg-white/[0.04]`, 150ms.
- 1-col on mobile, 2-col `≥sm`.
- Empty `cards` → renders nothing (the page's existing `NoAccountsState` covers no-data).

### 4.3 Wiring (modify) — `apps/frontend/src/app/(creator)/me/page.tsx`

In the `creatorId` branch, add to the `Promise.all`:

```ts
getCreatorPlatformBreakdown(metricWindow, { client: sb, creatorId });
```

and render `<PlatformCards cards={cards} />` after `ViewLeaderboard`. Combined KPIs + top content are unchanged.

## 5. Data flow

```text
/me  (server)
 ├─ getCreatorMetricsWindowed(creatorId)                      → combined KPIs   (scraped, unchanged)
 ├─ getTopContentWindowed(creatorId)                          → top content     (scraped, unchanged)
 └─ getCreatorPlatformBreakdown(window, {client, creatorId})  → per-platform cards
       ├─ scoped profile + latest snapshot (profileId, platform, handle, followers)
       ├─ profile_claim(owner) + getMyOwnedInsights → owned followers (IG/FB)
       └─ getDashboardViewTotalsWindowed            → scraped window views
 → each card links to /creators/{handle}/{platform}  (existing videos/reels page)
```

## 6. Edge cases

| Case                                              | Behaviour                                                                                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IG/FB connected, no owned rows yet                | `source: 'scraped'` + scraped followers + `syncing` caption                                                                                                                               |
| IG/FB token expired / failed                      | falls back to scraped (no owned days returned)                                                                                                                                            |
| Σ per-platform card views ≠ headline combined KPI | possible — cards use `getDashboardViewTotalsWindowed`; the headline uses `getCreatorMetricsWindowed` (separate RPC, possible cross-platform dedup). Consistent, not guaranteed identical. |
| Platform not tracked                              | omitted from the cards                                                                                                                                                                    |
| Profile slot has no handle                        | card skipped (cannot build the link)                                                                                                                                                      |
| Creator has only RedNote                          | no cards; existing `NoAccountsState`                                                                                                                                                      |
| Card views ≠ owned account views on Connections   | expected — cards use scraped (sum to the combined KPI); Connections shows owned. One-line note under the section.                                                                         |

## 7. Security / RLS

- Owned followers via `getMyOwnedInsights` — owner-guarded RPC called with the **cookie-scoped** route client, so the creator only ever reads their own owned data. No service-role on this path.
- Scraped reads use the existing public-RLS windowed reads, scoped by `creatorId`.
- No new tables, no new RLS policies, no migration.

## 8. Testing

- **Unit** (`creator-platform-breakdown.test.ts`, mock the reads):
  - owned IG claim + ≥1 owned day → `source: 'owned'`, owned followers, scraped views
  - owner claim, zero owned days → `source: 'scraped'`, `syncing: true`
  - unconnected IG/FB → `source: 'scraped'`
  - TikTok / Douyin → `source: 'scraped'`
  - RedNote excluded; slot with no handle skipped
- **Component** (`platform-cards.test.tsx`): owned card renders "first-party" + links to `/creators/{handle}/{platform}`; scraped card renders "Tracked"; `syncing` shows the caption.

## 9. Files

- **New:** `lib/creator-platform-breakdown.ts`, `components/insights/platform-cards.tsx`, the two test files above.
- **Modify:** `(creator)/me/page.tsx` (load + render the section).
- **No** schema / migration / RLS changes.

## 10. Out of scope

- **TikTok owned insights** — auth applied later; stays scraped for now.
- **Owned data on the public dashboard** — exposes owner-private insights; separate spec.
- **Admin public-display control** (`is_public` toggle) — parked, unrelated.
