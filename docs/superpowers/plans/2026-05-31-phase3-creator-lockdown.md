# Phase 3 — Creator Lockdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lock creators out of account management — rebuild `/me` as a 3-stat windowed dashboard, make `/me/account` read-only, delete `/me/profiles`, and 410 the creator write APIs.

**Architecture:** `/me` becomes a server component reading a `?window=` query param (URL-as-state) and calling the Phase 0 windowed-metrics RPCs scoped to the signed-in creator; a pure `<Link>` tab row drives the window. Account edit + profile management surfaces are removed and their write endpoints return 410. No DB migration.

**Tech Stack:** Next.js App Router (React 19, async Server Components), Tailwind 3, Supabase (cookie-aware route client), Jest (ts-jest, relative / `import type` only).

**Spec:** [2026-05-31-phase3-creator-lockdown-design.md](../specs/2026-05-31-phase3-creator-lockdown-design.md)

---

## Conventions (read once)

- **pnpm only.** Verify frontend-scoped: `pnpm --filter ./apps/frontend exec <tool>`.
- **Jest module resolution:** test-imported files use **relative** imports and `import type` for `metrics-windowed` (it pulls server code at runtime).
- **Yellow-mono (DESIGN.md):** deltas via caret glyph + intensity; never red/green. `insufficient` → `BUILDING_HISTORY`.
- **Branch:** `feat/phase3-creator-lockdown` (already created off main).
- Commit after each task. Task order matters: helpers → components → page → orphan removal → deletions → API.

---

## Task 1: `parseWindowParam` + `WINDOW_LABEL` helper

**Files:**
- Create: `apps/frontend/src/lib/me-window.ts`
- Test: `apps/frontend/src/lib/me-window.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/lib/me-window.test.ts`:
```ts
import { parseWindowParam, WINDOW_LABEL } from './me-window';

describe('parseWindowParam', () => {
  it('passes through each valid window', () => {
    expect(parseWindowParam({ window: '7d' })).toBe('7d');
    expect(parseWindowParam({ window: '30d' })).toBe('30d');
    expect(parseWindowParam({ window: '90d' })).toBe('90d');
    expect(parseWindowParam({ window: 'lifetime' })).toBe('lifetime');
  });
  it('defaults to 30d when missing', () => {
    expect(parseWindowParam({})).toBe('30d');
  });
  it('defaults to 30d for junk or empty', () => {
    expect(parseWindowParam({ window: 'yesterday' })).toBe('30d');
    expect(parseWindowParam({ window: '' })).toBe('30d');
  });
});

describe('WINDOW_LABEL', () => {
  it('labels every window', () => {
    expect(WINDOW_LABEL['7d']).toBe('7D');
    expect(WINDOW_LABEL['30d']).toBe('30D');
    expect(WINDOW_LABEL['90d']).toBe('90D');
    expect(WINDOW_LABEL.lifetime).toBe('Lifetime');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./apps/frontend exec jest src/lib/me-window.test.ts`
Expected: FAIL — "Cannot find module './me-window'".

- [ ] **Step 3: Write the implementation**

`apps/frontend/src/lib/me-window.ts`:
```ts
/**
 * /me time-window query-param helpers. `import type` only — no runtime import
 * of metrics-windowed (which pulls supabase-server) so this stays unit-testable.
 */
import type { MetricWindow } from './metrics-windowed';

const WINDOWS: readonly MetricWindow[] = ['7d', '30d', '90d', 'lifetime'];

export const WINDOW_LABEL: Record<MetricWindow, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
  lifetime: 'Lifetime',
};

/** Read + validate the ?window= query param. Unknown/missing → '30d'. */
export function parseWindowParam(params: { window?: string }): MetricWindow {
  const w = params.window ?? '';
  return (WINDOWS as readonly string[]).includes(w) ? (w as MetricWindow) : '30d';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./apps/frontend exec jest src/lib/me-window.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/me-window.ts apps/frontend/src/lib/me-window.test.ts
git commit -m "feat(me): parseWindowParam + WINDOW_LABEL helpers"
```

---

## Task 2: `WindowTabs` component

**Files:**
- Create: `apps/frontend/src/app/(creator)/me/window-tabs.tsx`

- [ ] **Step 1: Write the component**

`apps/frontend/src/app/(creator)/me/window-tabs.tsx`:
```tsx
/**
 * Shared 7D/30D/90D/Lifetime selector for /me. Pure server component:
 * URL-as-state via <Link href="/me?window=…"> tabs, no client JS. Active tab
 * carries the brand tint; the page server-renders for the chosen window.
 */
import Link from 'next/link';

import type { MetricWindow } from '@gitroom/frontend/lib/metrics-windowed';
import { WINDOW_LABEL } from '@gitroom/frontend/lib/me-window';

const WINDOWS: MetricWindow[] = ['7d', '30d', '90d', 'lifetime'];

export function WindowTabs({ current }: { current: MetricWindow }) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Time window">
      {WINDOWS.map((w) => {
        const active = w === current;
        return (
          <Link
            key={w}
            href={`/me?window=${w}`}
            scroll={false}
            aria-current={active ? 'page' : undefined}
            className={`text-caption px-3 py-1.5 rounded-full border transition-colors ${
              active
                ? 'bg-brand/10 text-fg border-brand/20'
                : 'bg-white/[0.04] text-fgMuted border-white/10 hover:text-fg'
            }`}
          >
            {WINDOW_LABEL[w]}
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS. (The component is exported but not yet imported — fine for tsc.)

- [ ] **Step 3: Commit**

```bash
git add "apps/frontend/src/app/(creator)/me/window-tabs.tsx"
git commit -m "feat(me): WindowTabs URL-as-state selector"
```

---

## Task 3: Rewrite `/me` — 3-KPI windowed dashboard (page + CreatorStats together)

These two files change as one unit because the `CreatorStats` prop contract changes from `metrics` to `row`; doing them separately would break the type-check between steps.

**Files:**
- Rewrite: `apps/frontend/src/app/(creator)/me/creator-stats.tsx`
- Rewrite: `apps/frontend/src/app/(creator)/me/page.tsx`

- [ ] **Step 1: Rewrite `creator-stats.tsx`**

Full new contents of `apps/frontend/src/app/(creator)/me/creator-stats.tsx`:
```tsx
/**
 * CreatorStats — the 3-KPI body of /me for the selected time window.
 * Followers (absolute + window delta), Views gained in window, Engagement for
 * the window. Engagement is private to /me. Yellow-mono delta; insufficient
 * history → "Building history…".
 */
import type { CreatorMetricWindowRow } from '@gitroom/frontend/lib/metrics-windowed';
import {
  formatCompact,
  formatDelta,
  formatPercent,
} from '@gitroom/frontend/lib/creator-metrics';
import { BUILDING_HISTORY, formatWindowedValue } from '@gitroom/frontend/lib/format-metric';

function deltaClass(n: number): string {
  if (n === 0) return 'text-fgSubtle';
  return n > 0 ? 'text-fg' : 'text-fgMuted';
}
function deltaCaret(n: number): string {
  if (n === 0) return '— ';
  return n > 0 ? '▲ ' : '▼ ';
}

export function CreatorStats({ row }: { row: CreatorMetricWindowRow }) {
  return (
    <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {/* Followers — absolute count + window delta */}
      <div className="glass-elevated rounded-2xl p-6 flex flex-col justify-between min-h-[140px]">
        <div className="text-label text-fgMuted">Followers</div>
        <div>
          <div className="text-display-2 text-fg tabular-nums leading-none">
            {formatCompact(row.followers)}
          </div>
          <div
            className={`text-caption mt-1 tabular-nums ${
              row.insufficient ? 'text-fgSubtle' : deltaClass(row.followersDelta)
            }`}
          >
            {row.insufficient
              ? BUILDING_HISTORY
              : `${deltaCaret(row.followersDelta)}${formatDelta(row.followersDelta)} this window`}
          </div>
        </div>
      </div>

      <Kpi
        label="Views"
        value={formatWindowedValue(row.insufficient, row.viewsGained, formatCompact)}
        hint="gained this window"
      />
      <Kpi
        label="Engagement"
        value={formatWindowedValue(row.insufficient, row.engagement, formatPercent)}
        hint="likes ÷ views"
      />
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="glass-subtle border border-borderGlass rounded-2xl p-5 flex flex-col justify-between min-h-[140px]">
      <div className="text-label text-fgMuted">{label}</div>
      <div>
        <div className="text-section text-fg tabular-nums">{value}</div>
        {hint && <div className="text-caption text-fgSubtle mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `page.tsx`**

Full new contents of `apps/frontend/src/app/(creator)/me/page.tsx`:
```tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import { getAuthContext } from '@gitroom/frontend/lib/auth';
import { getSupabaseRoute } from '@gitroom/frontend/lib/supabase-route';
import {
  getCreatorMetricsWindowed,
  getTopContentWindowed,
} from '@gitroom/frontend/lib/metrics-windowed';
import { parseWindowParam, WINDOW_LABEL } from '@gitroom/frontend/lib/me-window';
import { EmptyState } from '@gitroom/frontend/components/ui/empty-state';
import { ViewLeaderboard } from '@gitroom/frontend/components/leaderboard-showcase/view-leaderboard';
import {
  PLATFORM_ICONS,
  PLATFORM_LABELS,
  type PlatformKey,
} from '@gitroom/frontend/components/ui/platform-icons';

import { WindowTabs } from './window-tabs';
import { CreatorStats } from './creator-stats';

const SUPPORTED_PLATFORMS: PlatformKey[] = ['instagram', 'tiktok', 'facebook', 'douyin'];

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'My dashboard — D3 Creator',
};

function NoAccountsState() {
  return (
    <EmptyState
      icon={
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 3v18h18" />
          <path d="M7 15l3-3 3 2 4-5" />
        </svg>
      }
      title="Your accounts are being set up"
      description="Your agency adds and manages your social accounts. Your stats will appear here once they're connected."
    >
      <div className="flex items-center gap-2.5 mt-1">
        {SUPPORTED_PLATFORMS.map((p) => {
          const Icon = PLATFORM_ICONS[p];
          return (
            <span
              key={p}
              title={PLATFORM_LABELS[p]}
              className="flex items-center justify-center size-9 rounded-full glass-base border border-borderGlass text-fgMuted"
            >
              <Icon size={16} />
            </span>
          );
        })}
      </div>
    </EmptyState>
  );
}

export default async function CreatorMePage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');
  // Admins manage from /admin.
  if (auth.role === 'admin') redirect('/admin');

  const creatorId = auth.creatorLink?.creator_id ?? null;
  const metricWindow = parseWindowParam(await searchParams);

  let body: ReactNode;
  if (!creatorId) {
    body = <NoAccountsState />;
  } else {
    // Cookie-aware client (NOT service-role). The windowed RPCs read public-RLS
    // tables; creatorIds scopes the aggregation to this creator.
    const sb = await getSupabaseRoute();
    const [rows, topContent] = await Promise.all([
      getCreatorMetricsWindowed(metricWindow, { client: sb, creatorIds: [creatorId] }),
      getTopContentWindowed(metricWindow, { client: sb, creatorIds: [creatorId], limit: 12 }),
    ]);
    const row = rows[0];
    body = !row ? (
      <NoAccountsState />
    ) : (
      <div className="flex flex-col gap-8">
        <WindowTabs current={metricWindow} />
        <CreatorStats row={row} />
        <ViewLeaderboard
          rows={topContent}
          title="Top content"
          subtitle={`Top by views · ${WINDOW_LABEL[metricWindow]}`}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-10 pt-12 pb-24">
      <header className="max-w-[760px]">
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass-subtle border border-borderGlass text-caption text-fgMuted mb-6">
          <span className="inline-block size-1.5 rounded-full bg-aurora-cta" />
          My data
        </span>
        <h1 className="text-display-2 text-fg mb-4">Your creator view.</h1>
        <p className="text-body-lg text-fgMuted max-w-[600px]">
          Signed in as <span className="text-fg">{auth.email}</span>. Live stats
          across the accounts your agency manages for you.
        </p>
      </header>

      {body}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS. (`/me` no longer imports `getCreatorMetrics`; `creator-stats` no longer imports `CreatorMetrics`/`TopPost`.)
Run: `pnpm --filter ./apps/frontend exec eslint "src/app/(creator)/me/page.tsx" "src/app/(creator)/me/creator-stats.tsx"`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "apps/frontend/src/app/(creator)/me/page.tsx" "apps/frontend/src/app/(creator)/me/creator-stats.tsx"
git commit -m "feat(me): 3-KPI windowed dashboard with shared window selector"
```

---

## Task 4: Remove orphaned `getCreatorMetrics` + types

**Files:**
- Rewrite: `apps/frontend/src/lib/creator-metrics.ts`

After Task 3, `getCreatorMetrics` and the `CreatorMetrics`/`TopPost`/`ProfileMetric`/`SnapshotRow`/`PostRow` types have no consumers. Keep `resolveCreatorProfiles` (used by `/me/leaderboard`), `ResolvedProfile`, and the three formatters (used app-wide).

- [ ] **Step 1: Verify the orphans have no other consumers**

Run (Grep tool): pattern `getCreatorMetrics\b|CreatorMetrics\b|\bTopPost\b` across `apps/frontend/src`.
Expected: matches only in `lib/creator-metrics.ts` (and possibly stale comments). If any **other** file imports them, STOP and report — the assumption is wrong.

- [ ] **Step 2: Replace the file with the trimmed version**

Full new contents of `apps/frontend/src/lib/creator-metrics.ts`:
```ts
/**
 * Creator profile resolution + shared metric formatters.
 *
 * resolveCreatorProfiles is the source of truth for *which* profiles a creator
 * user sees (confirmed owner + tracker claims, with a legacy profile.creator_id
 * fallback), shared by /me and /me/leaderboard. All reads go through the
 * cookie-aware client passed in by the caller (NOT service-role) — the data
 * tables are public-read for the showcase.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResolvedProfile {
  id: string;
  platform: string;
  handle: string | null;
  display_name: string | null;
  profile_url: string;
  scrape_status: string;
}

/**
 * The set of profiles a creator user should see, and where it came from.
 * Source of truth is profile_claim (confirmed owner + tracker), with a legacy
 * profile.creator_id fallback. Shared by /me and /me/leaderboard.
 */
export async function resolveCreatorProfiles(
  sb: SupabaseClient,
  args: { userId: string; creatorId: string | null },
): Promise<{ profiles: ResolvedProfile[]; source: 'claims' | 'creator_id' }> {
  const claimsRes = await sb
    .from('profile_claim')
    .select(
      'profile:profile_id(id, platform, handle, display_name, profile_url, scrape_status)',
    )
    .eq('user_id', args.userId)
    .in('claim_kind', ['owner', 'tracker'])
    .not('confirmed_at', 'is', null);

  const claimed = ((claimsRes.data ?? []) as unknown as { profile: ResolvedProfile | null }[])
    .map((c) => c.profile)
    .filter((p): p is ResolvedProfile => p != null);

  if (claimed.length > 0) return { profiles: claimed, source: 'claims' };

  if (args.creatorId) {
    const { data } = await sb
      .from('profile')
      .select('id, platform, handle, display_name, profile_url, scrape_status')
      .eq('creator_id', args.creatorId);
    return { profiles: (data ?? []) as ResolvedProfile[], source: 'creator_id' };
  }

  return { profiles: [], source: 'claims' };
}

// --- Formatters -------------------------------------------------------------

const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
});

export function formatCompact(n: number | null): string {
  if (n == null) return '—';
  return compactFmt.format(n);
}

/** Signed compact delta, e.g. "+1.2K" / "-340" / "0". */
export function formatDelta(n: number | null): string {
  if (n == null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${compactFmt.format(n)}`;
}

/** Fraction → percent string, e.g. 0.0423 → "4.2%". */
export function formatPercent(fraction: number | null): string {
  if (fraction == null) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
}
```

- [ ] **Step 3: Typecheck + tests**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS (the `resolveProfileName` import and the removed types/constants are gone; nothing references them).
Run: `pnpm --filter ./apps/frontend exec jest`
Expected: PASS (no regressions; `me-window` tests still green).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/lib/creator-metrics.ts
git commit -m "refactor(me): drop orphaned getCreatorMetrics + types after windowed switch"
```

---

## Task 5: `/me/account` read-only

**Files:**
- Modify: `apps/frontend/src/app/(creator)/me/account/page.tsx`
- Delete: `apps/frontend/src/app/(creator)/me/account/account-form.tsx`
- Delete: `apps/frontend/src/app/(creator)/me/account/actions.ts`

- [ ] **Step 1: Make the page read-only**

In `apps/frontend/src/app/(creator)/me/account/page.tsx`:

(a) Remove the import `import { AccountForm } from './account-form';`.

(b) Replace the Profile section body — change:
```tsx
        <AccountForm defaultDisplayName={displayName} />
```
to:
```tsx
        <div className="flex flex-col gap-1.5">
          <div className="text-body text-fg">{displayName || 'Not set yet'}</div>
          <span className="text-caption text-fgSubtle">
            Managed by your agency — contact them to change it.
          </span>
        </div>
```

(c) Reword the "Tracked profiles" copy — change:
```tsx
          {tracked === 0
            ? 'No profiles tracked yet — add one from the Profiles tab.'
            : `${tracked} profile${tracked === 1 ? '' : 's'} tracked across your platforms.`}
```
to:
```tsx
          {tracked === 0
            ? 'No accounts yet — your agency adds them for you.'
            : `${tracked} account${tracked === 1 ? '' : 's'} managed by your agency.`}
```

- [ ] **Step 2: Delete the now-unused form + action**

```bash
git rm "apps/frontend/src/app/(creator)/me/account/account-form.tsx" "apps/frontend/src/app/(creator)/me/account/actions.ts"
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS (no dangling import of `AccountForm`/`updateAccount`).
Run (Grep tool): pattern `account-form|updateAccount|AccountForm` across `apps/frontend/src`.
Expected: no matches (confirms nothing else referenced them).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(me): read-only /me/account — agency-managed display name"
```

---

## Task 6: Delete `/me/profiles` + redirect + nav + leaderboard CTA

**Files:**
- Delete: `apps/frontend/src/app/(creator)/me/profiles/` (page.tsx, add-profile-form.tsx, actions.ts, remove-claim-button.tsx)
- Modify: `apps/frontend/src/proxy.ts`
- Modify: `apps/frontend/src/app/(creator)/layout.tsx`
- Modify: `apps/frontend/src/app/(creator)/me/leaderboard/page.tsx`

- [ ] **Step 1: Delete the route**

```bash
git rm -r "apps/frontend/src/app/(creator)/me/profiles"
```

- [ ] **Step 2: Add the `/me/profiles → /me` redirect in `proxy.ts`**

In `apps/frontend/src/proxy.ts`, immediately after the existing `/signup` redirect block (the one ending `}` before `const isAuthPage = …`), insert:
```ts
  // /me/profiles is removed in Phase 3 — creators no longer self-manage
  // accounts. Send stale links to the dashboard (authed creators; anon falls
  // through to the creator-route -> /login rule below).
  if (pathname === '/me/profiles') {
    return NextResponse.redirect(new URL('/me', request.url));
  }
```

- [ ] **Step 3: Remove the "Profiles" nav link**

In `apps/frontend/src/app/(creator)/layout.tsx`, delete the line:
```tsx
              <NavLink href="/me/profiles">Profiles</NavLink>
```

- [ ] **Step 4: Fix the `/me/leaderboard` empty-state CTA**

In `apps/frontend/src/app/(creator)/me/leaderboard/page.tsx`, change:
```tsx
          description={
            ids.length === 0
              ? "You're not tracking any profiles yet. Add one and your highest-viewed posts will appear here."
              : 'Your top posts appear here once the first daily scrape collects them — usually within 24 hours.'
          }
          action={ids.length === 0 ? { href: '/me/profiles', label: 'Add a profile' } : undefined}
```
to:
```tsx
          description={
            ids.length === 0
              ? 'Your agency manages your accounts. Your top posts will appear here once they are connected.'
              : 'Your top posts appear here once the first daily scrape collects them — usually within 24 hours.'
          }
```
(Delete the `action=` line entirely.)

- [ ] **Step 5: Verify no live `/me/profiles` references remain**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS.
Run (Grep tool): pattern `/me/profiles` across `apps/frontend/src`.
Expected: only the `proxy.ts` redirect line and incidental code-comments (e.g. `nav-link.tsx`, `creator-metrics.ts` comments). NO `href`/`NavLink`/`action` to `/me/profiles`. Remove any stray link found.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(me): delete /me/profiles, redirect to /me, drop nav + leaderboard CTA"
```

---

## Task 7: Lock down the creator write APIs (410 Gone)

**Files:**
- Rewrite: `apps/frontend/src/app/api/profiles/route.ts`
- Rewrite: `apps/frontend/src/app/api/profiles/claim/route.ts`
- Rewrite: `apps/frontend/src/app/api/profiles/discover/route.ts`

All three are POST-only and their only in-app caller (`add-profile-form.tsx`) was deleted in Task 6, so replacing each with a 410 stub is safe. Disable-not-drop: the files stay, the data/tables are untouched.

- [ ] **Step 1: Replace `api/profiles/route.ts`**

Full new contents:
```ts
/**
 * Disabled in Phase 3 (creator lockdown). Creator profile add/claim moved to
 * the agency admin; this endpoint returns 410 Gone. The profile/claim tables
 * and rows are untouched — only the creator-facing write path is closed.
 */
export async function POST(): Promise<Response> {
  return new Response(
    JSON.stringify({ ok: false, error: 'Creator profile management has moved to your agency admin.' }),
    { status: 410, headers: { 'content-type': 'application/json' } },
  );
}
```

- [ ] **Step 2: Replace `api/profiles/claim/route.ts`**

Full new contents:
```ts
/**
 * Disabled in Phase 3 (creator lockdown). Auto-discovery claim acceptance is no
 * longer creator-facing; returns 410 Gone. Tables/rows untouched.
 */
export async function POST(): Promise<Response> {
  return new Response(
    JSON.stringify({ ok: false, error: 'Creator profile management has moved to your agency admin.' }),
    { status: 410, headers: { 'content-type': 'application/json' } },
  );
}
```

- [ ] **Step 3: Replace `api/profiles/discover/route.ts`**

Full new contents:
```ts
/**
 * Disabled in Phase 3 (creator lockdown). Cross-platform auto-discovery is no
 * longer creator-facing; returns 410 Gone. Tables/rows untouched.
 */
export async function POST(): Promise<Response> {
  return new Response(
    JSON.stringify({ ok: false, error: 'Creator profile management has moved to your agency admin.' }),
    { status: 410, headers: { 'content-type': 'application/json' } },
  );
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS (the old imports — zod, @d3/database, supabase-route, upstash — are gone with the handler bodies).
Run: `pnpm --filter ./apps/frontend exec eslint "src/app/api/profiles/route.ts" "src/app/api/profiles/claim/route.ts" "src/app/api/profiles/discover/route.ts"`
Expected: no errors (no unused imports).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/app/api/profiles/route.ts apps/frontend/src/app/api/profiles/claim/route.ts apps/frontend/src/app/api/profiles/discover/route.ts
git commit -m "feat(api): 410 the creator profile write endpoints (lockdown)"
```

---

## Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 2: Unit tests**

Run: `pnpm --filter ./apps/frontend exec jest`
Expected: PASS, including `me-window.test.ts` (5). No pre-existing test regresses.

- [ ] **Step 3: Production build**

Run (bash): `cd apps/frontend && set -a && . ../../.env && set +a && pnpm exec next build`
Expected: build succeeds. The route list no longer shows `/me/profiles`. (The `/dev/logo-preview` prerender warning is pre-existing/unrelated.)

- [ ] **Step 4: Manual smoke via Preview MCP**

Start the `preview` launch config. Log in as `creator@d3.test` / `Passw0rd!`. Then:
1. `/me` shows the header, the 7D/30D/90D/Lifetime tabs, 3 KPIs (Followers/Views/Engagement), and the windowed top-content grid. No Likes/Posts tiles, no by-platform list. Mostly "Building history…" today (~1 snapshot day — expected).
2. Click each window tab → URL gains `?window=…` and the active tab + figures update.
3. The creator nav has **no** "Profiles" tab.
4. `/me/account` shows the display name as read-only text + "Managed by your agency"; no editable form / Save button.
5. Navigate to `/me/profiles` → 307 to `/me`.
6. `/me/leaderboard` empty state has no "Add a profile" CTA.
7. `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:<port>/api/profiles` → **410** (repeat for `/api/profiles/claim` and `/api/profiles/discover`).

Capture a screenshot of `/me` for the PR.

- [ ] **Step 5: Update the knowledge graph**

Run (bash): `graphify update .`
Expected: AST-only refresh, no API cost.

---

## Self-review notes (spec coverage)

- Spec §5.2 `/me` page → Task 3. §5.3 WindowTabs → Task 2. §5.4 CreatorStats → Task 3. §5.5 empty state → Task 3 (`NoAccountsState`). §5.6 orphan removal → Task 4. §5.7 read-only account → Task 5. §5.8 delete `/me/profiles` + proxy redirect + nav → Task 6. §5.9 410 APIs → Task 7. §5.10 leaderboard CTA → Task 6. Helper §4/`me-window` → Task 1. §7 verification → Task 8.
- No DB migration (confirmed — no `supabase/` changes in any task).
- Out of scope confirmed untouched: `/me/leaderboard` body (only its CTA changes), `profile_claim` rows, admin surfaces, `(auth)/onboarding/`.
```
