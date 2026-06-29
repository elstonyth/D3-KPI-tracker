# /me Per-Platform Cards + Drill-Down — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-platform section to the creator's `/me` dashboard — one compact card per platform (IG/FB owned, TikTok/Douyin scraped) that links to the existing `/creators/{handle}/{platform}` videos page.

**Architecture:** A pure-ish server resolver composes existing reads (`getLiveCreatorRows` for per-platform handle+followers, `getDashboardViewTotalsWindowed` for scraped window views, `profile_claim` + `getMyOwnedInsights` for owned IG/FB followers) into a `PlatformCard[]`. A presentational server component renders the cards as links. `/me` loads the resolver alongside its existing reads and renders the component.

**Tech Stack:** Next.js App Router (React 19), Tailwind 3, Supabase (cookie-scoped route client), Jest + React Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-06-24-me-per-platform-cards-design.md`

## Global Constraints

- pnpm only. Tailwind 3; match `DESIGN.md` (near-black surfaces, hairline `border-borderGlass`, scarce yellow `#F2E600` = `bg-brand`, Inter).
- Work on a branch off `main` (e.g. `feat/me-platform-cards`). Do NOT commit to `main`.
- No schema / migration / RLS changes.
- Owned reads use the **cookie-scoped** route client (owner-guarded RPC). Scraped reads are public.
- **Test runner:** from `apps/frontend`, run `npx jest --testPathPattern "<name>" --no-coverage`. This project does NOT load `@testing-library/jest-dom` — assert with `.toBeTruthy()` / `.toBeNull()` / `.toEqual()`, never `.toBeInTheDocument()`. Component tests need the `/** @jest-environment jsdom */` pragma; pure-logic tests use `/** @jest-environment node */`.
- **Type-check:** from `apps/frontend`, `npx tsc --noEmit -p tsconfig.json` must exit 0 (the build job type-checks; `strictNullChecks` is on).
- **Lint:** from repo root, `npx eslint "<file>"` must exit 0.

---

### Task 0: Branch

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/me-platform-cards
```

---

### Task 1: Resolver `getCreatorPlatformBreakdown`

**Files:**

- Create: `apps/frontend/src/lib/creator-platform-breakdown.ts`
- Test: `apps/frontend/src/lib/creator-platform-breakdown.test.ts`

**Interfaces:**

- Consumes:
  - `getLiveCreatorRows(): Promise<LiveCreatorRow[] | null>` from `./queries`. `LiveCreatorRow` has `creatorId: string` and `platforms: CreatorPlatformMetric[]`, where `CreatorPlatformMetric = { platform: PlatformKey; handle: string | null; followers: number; ... }`.
  - `getDashboardViewTotalsWindowed(opts: { client?; creatorIds? }): Promise<{ byCreator: Record<string, Record<string, Record<string, number>>> }>` from `./metrics-windowed`. Index as `byCreator[creatorId][platform][window]`.
  - `getMyOwnedInsights(client, profileId, days): Promise<{ profile: Array<{ captured_date: string; follower_total: number | null }> } | null>` from `./owned-insights`.
  - `MetricWindow = '7d' | '30d' | '90d' | 'lifetime'` from `./metrics-windowed`.
  - `PlatformKey` from `@gitroom/frontend/components/ui/platform-icons`.
- Produces:
  - `interface PlatformCard { platform: PlatformKey; handle: string; source: 'owned' | 'scraped'; followers: number | null; views: number | null; syncing?: boolean }`
  - `getCreatorPlatformBreakdown(window: MetricWindow, opts: { client: SupabaseClient; creatorId: string }): Promise<PlatformCard[]>`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/lib/creator-platform-breakdown.test.ts`:

```ts
/** @jest-environment node */
import { getCreatorPlatformBreakdown } from './creator-platform-breakdown';

jest.mock('./queries', () => ({ getLiveCreatorRows: jest.fn() }));
jest.mock('./metrics-windowed', () => ({
  getDashboardViewTotalsWindowed: jest.fn(),
}));
jest.mock('./owned-insights', () => ({ getMyOwnedInsights: jest.fn() }));

import { getLiveCreatorRows } from './queries';
import { getDashboardViewTotalsWindowed } from './metrics-windowed';
import { getMyOwnedInsights } from './owned-insights';

const mockRows = getLiveCreatorRows as jest.Mock;
const mockViews = getDashboardViewTotalsWindowed as jest.Mock;
const mockOwned = getMyOwnedInsights as jest.Mock;

// Minimal cookie-client stub: client.from('profile_claim').select(...).eq(...)
// resolves to { data, error }.
function client(
  claims: Array<{ profile_id: string; profile: { platform: string } }>,
): any {
  return {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: claims, error: null }),
      }),
    }),
  };
}

beforeEach(() => jest.clearAllMocks());

test('owned IG → owned followers; TikTok stays scraped; ordered IG then TikTok', async () => {
  mockRows.mockResolvedValue([
    {
      creatorId: 'c1',
      platforms: [
        { platform: 'tiktok', handle: 'tt_h', followers: 5000 },
        { platform: 'instagram', handle: 'ig_h', followers: 1000 },
      ],
    },
  ]);
  mockViews.mockResolvedValue({
    byPlatform: {},
    byCreator: { c1: { instagram: { '30d': 200 }, tiktok: { '30d': 9000 } } },
  });
  mockOwned.mockResolvedValue({
    profile: [{ captured_date: '2026-06-22', follower_total: 1234 }],
    demographics: [],
    posts: [],
  });

  const cards = await getCreatorPlatformBreakdown('30d', {
    client: client([
      { profile_id: 'p_ig', profile: { platform: 'instagram' } },
    ]),
    creatorId: 'c1',
  });

  expect(cards).toEqual([
    {
      platform: 'instagram',
      handle: 'ig_h',
      source: 'owned',
      followers: 1234,
      views: 200,
    },
    {
      platform: 'tiktok',
      handle: 'tt_h',
      source: 'scraped',
      followers: 5000,
      views: 9000,
    },
  ]);
  expect(mockOwned).toHaveBeenCalledWith(expect.anything(), 'p_ig', 1);
});

test('owner-claimed but no owned rows yet → scraped + syncing', async () => {
  mockRows.mockResolvedValue([
    {
      creatorId: 'c1',
      platforms: [{ platform: 'instagram', handle: 'ig_h', followers: 1000 }],
    },
  ]);
  mockViews.mockResolvedValue({
    byPlatform: {},
    byCreator: { c1: { instagram: { '30d': 200 } } },
  });
  mockOwned.mockResolvedValue({ profile: [], demographics: [], posts: [] });

  const cards = await getCreatorPlatformBreakdown('30d', {
    client: client([
      { profile_id: 'p_ig', profile: { platform: 'instagram' } },
    ]),
    creatorId: 'c1',
  });

  expect(cards).toEqual([
    {
      platform: 'instagram',
      handle: 'ig_h',
      source: 'scraped',
      followers: 1000,
      views: 200,
      syncing: true,
    },
  ]);
});

test('no claims → all scraped; slot without a handle is skipped', async () => {
  mockRows.mockResolvedValue([
    {
      creatorId: 'c1',
      platforms: [
        { platform: 'instagram', handle: null, followers: 1000 },
        { platform: 'douyin', handle: 'dy_h', followers: 7000 },
      ],
    },
  ]);
  mockViews.mockResolvedValue({
    byPlatform: {},
    byCreator: { c1: { douyin: { '30d': 7700000 } } },
  });

  const cards = await getCreatorPlatformBreakdown('30d', {
    client: client([]),
    creatorId: 'c1',
  });

  expect(cards).toEqual([
    {
      platform: 'douyin',
      handle: 'dy_h',
      source: 'scraped',
      followers: 7000,
      views: 7700000,
    },
  ]);
  expect(mockOwned).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/frontend && npx jest --testPathPattern "creator-platform-breakdown" --no-coverage`
Expected: FAIL — `Cannot find module './creator-platform-breakdown'` (the implementation does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `apps/frontend/src/lib/creator-platform-breakdown.ts`:

```ts
// apps/frontend/src/lib/creator-platform-breakdown.ts
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MetricWindow } from './metrics-windowed';
import { getDashboardViewTotalsWindowed } from './metrics-windowed';
import { getLiveCreatorRows } from './queries';
import { getMyOwnedInsights } from './owned-insights';
import type { PlatformKey } from '@gitroom/frontend/components/ui/platform-icons';

export interface PlatformCard {
  platform: PlatformKey;
  handle: string;
  source: 'owned' | 'scraped';
  followers: number | null;
  views: number | null;
  syncing?: boolean;
}

// Platforms whose owned (OAuth) followers we prefer when connected.
const OWNED_CAPABLE = new Set<string>(['instagram', 'facebook']);
// Owned-capable first; RedNote is already excluded upstream.
const ORDER: PlatformKey[] = ['instagram', 'facebook', 'tiktok', 'douyin'];

export async function getCreatorPlatformBreakdown(
  window: MetricWindow,
  opts: { client: SupabaseClient; creatorId: string },
): Promise<PlatformCard[]> {
  const { client, creatorId } = opts;

  // Scraped per-platform handle + followers (RedNote already excluded).
  const rows = await getLiveCreatorRows();
  const slots = rows?.find((r) => r.creatorId === creatorId)?.platforms ?? [];

  // Scraped window views, scoped to this creator.
  const totals = await getDashboardViewTotalsWindowed({
    client,
    creatorIds: [creatorId],
  });
  const viewsByPlatform = totals.byCreator[creatorId] ?? {};

  // Which owned-capable platforms are OAuth-connected (owner claims).
  const { data: claims } = await client
    .from('profile_claim')
    .select('profile_id, profile:profile_id(platform)')
    .eq('claim_kind', 'owner');
  const ownedProfileByPlatform = new Map<string, string>();
  for (const c of claims ?? []) {
    const prof = (Array.isArray(c.profile) ? c.profile[0] : c.profile) as
      | { platform: string | null }
      | null
      | undefined;
    if (prof?.platform && OWNED_CAPABLE.has(prof.platform)) {
      ownedProfileByPlatform.set(prof.platform, c.profile_id as string);
    }
  }

  const cards: PlatformCard[] = [];
  for (const platform of ORDER) {
    const slot = slots.find((s) => s.platform === platform);
    if (!slot || !slot.handle) continue; // not tracked / no handle → skip
    const handle = slot.handle;
    const views = viewsByPlatform[platform]?.[window] ?? null;
    const scrapedFollowers = slot.followers ?? null;

    const ownedProfileId = ownedProfileByPlatform.get(platform);
    if (ownedProfileId) {
      const owned = await getMyOwnedInsights(client, ownedProfileId, 1);
      const latest = owned?.profile[owned.profile.length - 1];
      if (latest && latest.follower_total != null) {
        cards.push({
          platform,
          handle,
          source: 'owned',
          followers: latest.follower_total,
          views,
        });
        continue;
      }
      // Connected, but the cron has not ingested owned rows yet.
      cards.push({
        platform,
        handle,
        source: 'scraped',
        followers: scrapedFollowers,
        views,
        syncing: true,
      });
      continue;
    }

    cards.push({
      platform,
      handle,
      source: 'scraped',
      followers: scrapedFollowers,
      views,
    });
  }
  return cards;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/frontend && npx jest --testPathPattern "creator-platform-breakdown" --no-coverage`
Expected: PASS — 3 passed.

- [ ] **Step 5: Type-check + commit**

Run: `cd apps/frontend && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0 (no output).

```bash
git add apps/frontend/src/lib/creator-platform-breakdown.ts apps/frontend/src/lib/creator-platform-breakdown.test.ts
git commit -m "feat(me): add getCreatorPlatformBreakdown resolver"
```

---

### Task 2: `PlatformCards` component

**Files:**

- Create: `apps/frontend/src/components/insights/platform-cards.tsx`
- Test: `apps/frontend/src/components/insights/platform-cards.test.tsx`

**Interfaces:**

- Consumes: `PlatformCard` from `@gitroom/frontend/lib/creator-platform-breakdown` (Task 1); `PLATFORM_ICONS`, `PLATFORM_LABELS` from `@gitroom/frontend/components/ui/platform-icons`; `next/link`.
- Produces: `PlatformCards({ cards }: { cards: PlatformCard[] }): JSX.Element | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/insights/platform-cards.test.tsx`:

```tsx
/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { PlatformCards } from './platform-cards';
import type { PlatformCard } from '@gitroom/frontend/lib/creator-platform-breakdown';

test('renders owned + scraped cards with badge + correct drill-down link', () => {
  const cards: PlatformCard[] = [
    {
      platform: 'instagram',
      handle: 'mei_yeo2507',
      source: 'owned',
      followers: 9840,
      views: 24860,
    },
    {
      platform: 'douyin',
      handle: 'eytan',
      source: 'scraped',
      followers: 49600,
      views: 501000,
    },
  ];
  render(<PlatformCards cards={cards} />);
  expect(screen.getByText('✓ first-party')).toBeTruthy();
  expect(screen.getByText('Tracked')).toBeTruthy();
  expect(screen.getByText('@mei_yeo2507')).toBeTruthy();
  const link = screen.getByText('@mei_yeo2507').closest('a');
  expect(link?.getAttribute('href')).toBe('/creators/mei_yeo2507/instagram');
});

test('renders nothing when there are no cards', () => {
  const { container } = render(<PlatformCards cards={[]} />);
  expect(container.firstChild).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/frontend && npx jest --testPathPattern "platform-cards" --no-coverage`
Expected: FAIL — `Cannot find module './platform-cards'`.

- [ ] **Step 3: Write the implementation**

Create `apps/frontend/src/components/insights/platform-cards.tsx`:

```tsx
// apps/frontend/src/components/insights/platform-cards.tsx
import Link from 'next/link';
import {
  PLATFORM_ICONS,
  PLATFORM_LABELS,
} from '@gitroom/frontend/components/ui/platform-icons';
import type { PlatformCard } from '@gitroom/frontend/lib/creator-platform-breakdown';

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
function fmt(n: number | null): string {
  return n == null ? '—' : compact.format(n);
}

export function PlatformCards({ cards }: { cards: PlatformCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-heading text-fg">Your platforms</h2>
        <p className="text-caption text-fgSubtle mt-1">
          Tap a platform to see its posts and views.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {cards.map((c) => {
          const Icon = PLATFORM_ICONS[c.platform];
          return (
            <Link
              key={c.platform}
              href={`/creators/${encodeURIComponent(c.handle)}/${c.platform}`}
              className="group flex items-center justify-between gap-4 p-4 rounded-xl glass-subtle border border-borderGlass hover:border-borderGlassStrong hover:bg-white/[0.04] transition-colors"
            >
              <span className="flex items-center gap-3 min-w-0">
                <span className="shrink-0 size-9 rounded-full glass-base border border-borderGlass flex items-center justify-center text-fg">
                  <Icon size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-label text-fg truncate">
                    @{c.handle}
                  </span>
                  <span className="block text-caption text-fgSubtle">
                    {PLATFORM_LABELS[c.platform]}
                    {c.syncing ? ' · syncing…' : ''}
                  </span>
                </span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="text-right">
                  <span className="block text-label text-fg tabular-nums">
                    {fmt(c.followers)}
                  </span>
                  <span className="block text-caption text-fgSubtle tabular-nums">
                    {fmt(c.views)} views
                  </span>
                </span>
                <span
                  className={`text-micro px-2 py-0.5 rounded-full border ${
                    c.source === 'owned'
                      ? 'bg-brand/10 text-fg border-brand/20'
                      : 'glass-base text-fgMuted border-borderGlass'
                  }`}
                >
                  {c.source === 'owned' ? '✓ first-party' : 'Tracked'}
                </span>
                <span
                  className="text-fgSubtle group-hover:text-fg transition-colors"
                  aria-hidden
                >
                  →
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/frontend && npx jest --testPathPattern "platform-cards" --no-coverage`
Expected: PASS — 2 passed.

- [ ] **Step 5: Type-check + commit**

Run: `cd apps/frontend && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

```bash
git add apps/frontend/src/components/insights/platform-cards.tsx apps/frontend/src/components/insights/platform-cards.test.tsx
git commit -m "feat(me): add PlatformCards component"
```

---

### Task 3: Wire into `/me`

**Files:**

- Modify: `apps/frontend/src/app/(creator)/me/page.tsx`

**Interfaces:**

- Consumes: `getCreatorPlatformBreakdown` (Task 1), `PlatformCards` (Task 2).

- [ ] **Step 1: Add the imports**

In `apps/frontend/src/app/(creator)/me/page.tsx`, after the existing `getTopContentWindowed` import block, add:

```ts
import { getCreatorPlatformBreakdown } from '@gitroom/frontend/lib/creator-platform-breakdown';
import { PlatformCards } from '@gitroom/frontend/components/insights/platform-cards';
```

- [ ] **Step 2: Load the breakdown in the existing `Promise.all`**

Replace:

```ts
const [rows, topContent] = await Promise.all([
  getCreatorMetricsWindowed(metricWindow, {
    client: sb,
    creatorIds: [creatorId],
  }),
  getTopContentWindowed(metricWindow, {
    client: sb,
    creatorIds: [creatorId],
    limit: 12,
  }),
]);
```

with:

```ts
const [rows, topContent, platformCards] = await Promise.all([
  getCreatorMetricsWindowed(metricWindow, {
    client: sb,
    creatorIds: [creatorId],
  }),
  getTopContentWindowed(metricWindow, {
    client: sb,
    creatorIds: [creatorId],
    limit: 12,
  }),
  getCreatorPlatformBreakdown(metricWindow, { client: sb, creatorId }),
]);
```

- [ ] **Step 3: Render the section after the top content**

Replace:

```tsx
        <ViewLeaderboard
          rows={topContent}
          title="Top content"
          subtitle={`Top by views · ${WINDOW_LABEL[metricWindow]}`}
        />
      </div>
```

with:

```tsx
        <ViewLeaderboard
          rows={topContent}
          title="Top content"
          subtitle={`Top by views · ${WINDOW_LABEL[metricWindow]}`}
        />
        <PlatformCards cards={platformCards} />
      </div>
```

- [ ] **Step 4: Type-check**

Run: `cd apps/frontend && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 5: Lint the touched files**

Run from repo root:
`npx eslint "apps/frontend/src/lib/creator-platform-breakdown.ts" "apps/frontend/src/components/insights/platform-cards.tsx" "apps/frontend/src/app/(creator)/me/page.tsx"`
Expected: exit 0 (npm/Next plugin warnings are fine; zero errors).

- [ ] **Step 6: Run the full frontend suite**

Run: `cd apps/frontend && npx jest --no-coverage`
Expected: all suites pass (the prior count plus the 5 new tests).

- [ ] **Step 7: Commit**

```bash
git add "apps/frontend/src/app/(creator)/me/page.tsx"
git commit -m "feat(me): render per-platform cards on the creator dashboard"
```

---

## Self-Review

**Spec coverage:**

- §4.1 resolver → Task 1 (owned/scraped/syncing, RedNote excluded upstream, no-handle skip, ordering). ✓
- §4.2 component → Task 2 (badge, drill-down link, empty → null). ✓
- §4.3 wiring → Task 3. ✓
- §8 tests → Task 1 (3 unit) + Task 2 (2 component). ✓
- §7 security → owned via cookie-scoped `getMyOwnedInsights`; scraped public reads; no schema. ✓

**Placeholder scan:** none — every step has full code + exact commands + expected output.

**Type consistency:** `PlatformCard` fields identical across Task 1 (def), its tests, Task 2 (consume), and Task 2's test. `getCreatorPlatformBreakdown(window, { client, creatorId })` signature identical in Task 1 and Task 3. The windowed-views type is `byCreator: Record<creatorId, DashboardViewTotals>` where `DashboardViewTotals = Record<platform, Record<window, number>>`, so `byCreator[creatorId][platform][window]` is the full three-level path.

**Post-review deviation (shipped):** Task 1's slot read was implemented as a `creatorId`-scoped pair of queries — `profile` (`id, platform, handle`, RedNote excluded) + latest `profile_snapshot.followers` per profile — instead of `getLiveCreatorRows()`, so the `/me` path no longer does a full-table scan (CodeRabbit #1) and each slot carries `profileId`. Owner claims are matched by `slot.profileId` restricted to this creator's slots (#2), and `getMyOwnedInsights` is wrapped in `.catch` so an RPC failure degrades to the scraped/syncing card (#3). The shipped resolver is the source of truth; the blueprint above predates these review fixes.

**Known caveat (intended):** card views (scraped) may not exactly equal the headline combined KPI (separate RPC, possible cross-platform dedup) — acceptable.
