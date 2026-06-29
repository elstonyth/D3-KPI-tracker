# Views-over-Engagement + Admin-Centralized Accounts — Decomposition Overview

**Date:** 2026-05-30
**Status:** Approved decomposition. Phase 0 spec written; Phases 1–3 specced after Phase 0 ships.

## Why

Two business shifts:
1. **Views over Engagement** — Views becomes the headline metric across public surfaces; engagement is demoted to a private, creator-only stat.
2. **Centralized account management** — Admins (not creators) add social URLs and provision creator logins. Creators lose all write-access to accounts.

## Locked decisions (from brainstorming)

| Topic | Decision |
|---|---|
| "Views 30D" meaning | **Views gained in window** (delta): `Σ (current_views − views_at(now − window))` per post. Option A. |
| 7D/30D/90D/Lifetime | Lifetime views baseline = 0 (first content → now). Lifetime followers baseline = earliest snapshot. |
| Build strategy | **Foundation-first**, 4 phases; each phase its own spec → plan → ship. |
| Admin provisioning | Admin creates creator **login (email+password)** + assigns **social URLs**. **Public signup killed.** |
| Engagement | **Private `/me` only.** Removed from all public + admin surfaces. Formula `(likes+comments+shares) ÷ views`; posts with no/zero views excluded from the average (no div-by-zero, not counted as 0%). |
| `/me/account` | **Read-only**, "Managed by Admin" notice. Display name no longer creator-editable. |
| `/me` window filter | **One shared** 7D/30D/90D/Lifetime selector driving all 3 stats. |
| Admin Top-30 followers | Rank by **30d follower delta** (growth), not current count. |

## Engagement-formula note

`(L+C+S) ÷ views` is a scraper-era approximation of the best-practice `engagements ÷ reach/impressions` — we have no OAuth/owner analytics, so `views` is our best public reach-proxy (good for video, breaks on no-view image posts → those excluded). Industry guidance: compute identically everywhere. We define it once in the data layer and reuse. Refs: Hootsuite, Brandwatch, Planable engagement-rate guides.

## Architecture impact

Option A makes every headline number a **time-delta** (per post / per profile). The current `lib/queries.ts` sums *current* values from a "recent rows" slice — it cannot express windowed deltas at scale. So the keystone is a new windowed-metrics engine (Postgres RPCs + thin TS wrapper). All UI phases depend on it.

## Phases

```
Phase 0  Data layer    Windowed-metrics RPCs + lib/metrics-windowed.ts + insufficiency guard   ← KEYSTONE
Phase 1  Public        /dashboard + /leaderboard redesign (metric swaps, 2 boards, Top-20 content grid)
Phase 2  Admin         /admin Top-30 (followers-by-delta + content-by-views) + creator provisioning + kill signup
Phase 3  Creator lock  Delete /me/profiles, read-only /me/account, 3-stat /me with shared window selector
```

- **Phase 0** must build + verify before any UI phase.
- **Phases 1–3** are independent of each other once Phase 0 lands (can reorder/parallelize).
- **Self-check ownership:** "creators have no write-access" → Phase 2 (disable endpoints) + Phase 3 (delete route, read-only account). "All 4 time filters present + working" → Phase 3 (and reused by Phase 1/2 public/admin cards).

## Data-safety (per CLAUDE.md deploy rules)

- All schema changes are **additive** (new RPC functions + indexes). No `drop`/`truncate`/column-drop on populated tables.
- RPCs are pure read functions (`security definer` not required — they read public-RLS tables; admin paths call via service-role).
- Deletion of `/me/profiles` is **frontend-only** (route files). The `profile_claim` table and rows are untouched; write *endpoints* are disabled (403/410), not dropped.

## Out of scope / deferred cleanup

- Removing the now-dead claim/discovery API routes + `profile_claim` discovery logic (disabled in Phase 2, deleted in a later cleanup pass).
- Real daily time-series for sparklines (currently demo series; a `*_series` RPC is a future enhancement).
