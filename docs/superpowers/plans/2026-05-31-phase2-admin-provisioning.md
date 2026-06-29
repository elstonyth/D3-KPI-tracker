# Phase 2 — Admin Top-30 + Creator Provisioning + Kill Signup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/admin` into a Top-30 dashboard, let admins provision creator logins + social URLs in one form, and kill public signup.

**Architecture:** Server Component `/admin` reads windowed metrics via service-role and renders two Top-30 panels + an inline provisioning form. Provisioning is a `'use server'` action chaining `auth.admin.createUser` → `ensureCreatorForUser` → per-URL `findOrCreateProfile` + `addProfileClaim`. Signup death is a proxy redirect + file/CTA removal. No DB migration.

**Tech Stack:** Next.js App Router (React 19, Server Components + `useActionState`), Tailwind 3, Supabase service-role client, `@d3/database` helpers, Jest (ts-jest, relative/`import type` only).

**Spec:** [2026-05-31-phase2-admin-provisioning-design.md](../specs/2026-05-31-phase2-admin-provisioning-design.md)

---

## Conventions (read once)

- **pnpm only.** Verify commands are frontend-scoped: `pnpm --filter ./apps/frontend exec <tool>`.
- **Jest module resolution:** files imported by `*.test.ts` must avoid the `@gitroom/frontend/*` alias and avoid runtime imports of `@d3/database`/`./supabase-server`. Use **relative** imports and `import type` for type-only deps.
- **Yellow-mono (DESIGN.md):** status/deltas read from icon glyph + label + yellow intensity. Never red/green. (`admin-actions.tsx` uses `text-red-400` — that's a pre-existing violation; do not copy it.)
- **Branch:** `feat/phase2-admin-provisioning` (already created off `main`).
- Commit after each task.

---

## Task 1: Pure helper — `normalizeProvisionUrls`

**Files:**
- Create: `apps/frontend/src/lib/provision-plan.ts`
- Test: `apps/frontend/src/lib/provision-plan.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/lib/provision-plan.test.ts`:
```ts
import { normalizeProvisionUrls } from './provision-plan';

describe('normalizeProvisionUrls', () => {
  it('trims entries and drops blanks/whitespace-only', () => {
    expect(normalizeProvisionUrls(['  https://a.com  ', '', '   '])).toEqual(['https://a.com']);
  });
  it('de-duplicates case-insensitively, preserving first-seen order', () => {
    expect(
      normalizeProvisionUrls(['https://A.com', 'https://b.com', 'https://a.com']),
    ).toEqual(['https://A.com', 'https://b.com']);
  });
  it('returns an empty array for empty input', () => {
    expect(normalizeProvisionUrls([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./apps/frontend exec jest src/lib/provision-plan.test.ts`
Expected: FAIL — "Cannot find module './provision-plan'".

- [ ] **Step 3: Write minimal implementation**

`apps/frontend/src/lib/provision-plan.ts`:
```ts
/**
 * Normalize a raw list of profile-URL inputs from the provisioning form:
 * trim each entry, drop blanks, and de-duplicate case-insensitively while
 * preserving first-seen order. Pure + dependency-free so it is unit-testable
 * (no `@d3/database` import — platform detection/validation happens in the
 * server action, where `detectPlatform`/`findOrCreateProfile` are available).
 */
export function normalizeProvisionUrls(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const url = entry.trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./apps/frontend exec jest src/lib/provision-plan.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/provision-plan.ts apps/frontend/src/lib/provision-plan.test.ts
git commit -m "feat(admin): normalizeProvisionUrls helper for provisioning"
```

---

## Task 2: Pure helper — `rankCreatorsByFollowerDelta`

**Files:**
- Create: `apps/frontend/src/lib/admin-top30.ts`
- Test: `apps/frontend/src/lib/admin-top30.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/lib/admin-top30.test.ts`:
```ts
import type { CreatorMetricWindowRow } from './metrics-windowed';
import { rankCreatorsByFollowerDelta } from './admin-top30';

function row(over: Partial<CreatorMetricWindowRow>): CreatorMetricWindowRow {
  return {
    creatorId: 'id',
    displayName: 'name',
    avatarUrl: null,
    primaryPlatform: 'instagram',
    primaryHandle: 'h',
    followers: 0,
    followersDelta: 0,
    viewsGained: 0,
    engagement: null,
    postCount: 0,
    insufficient: false,
    ...over,
  };
}

describe('rankCreatorsByFollowerDelta', () => {
  it('sorts sufficient creators by followersDelta desc', () => {
    const out = rankCreatorsByFollowerDelta([
      row({ creatorId: 'a', followersDelta: 10 }),
      row({ creatorId: 'b', followersDelta: 50 }),
      row({ creatorId: 'c', followersDelta: 30 }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(['b', 'c', 'a']);
  });

  it('breaks delta ties by followers desc', () => {
    const out = rankCreatorsByFollowerDelta([
      row({ creatorId: 'a', followersDelta: 10, followers: 100 }),
      row({ creatorId: 'b', followersDelta: 10, followers: 900 }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(['b', 'a']);
  });

  it('appends insufficient creators after all ranked ones', () => {
    const out = rankCreatorsByFollowerDelta([
      row({ creatorId: 'young', insufficient: true, followers: 999 }),
      row({ creatorId: 'a', followersDelta: 5 }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(['a', 'young']);
  });

  it('returns an empty array for empty input', () => {
    expect(rankCreatorsByFollowerDelta([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./apps/frontend exec jest src/lib/admin-top30.test.ts`
Expected: FAIL — "Cannot find module './admin-top30'".

- [ ] **Step 3: Write minimal implementation**

`apps/frontend/src/lib/admin-top30.ts`:
```ts
/**
 * Admin Top-30 ranking. `import type` only — no runtime import of
 * metrics-windowed (which pulls supabase-server) so this stays unit-testable.
 *
 * A follower delta with no in-window baseline (`insufficient`) is not a real
 * growth number, so those creators can't be ranked by growth: rank the
 * sufficient ones by Δ desc, then append the insufficient ones (they render
 * "Building history…"). With ~1 snapshot day in prod today, most rows are
 * insufficient — expected, per the no-fake-deltas decision.
 */
import type { CreatorMetricWindowRow } from './metrics-windowed';

export function rankCreatorsByFollowerDelta(
  rows: CreatorMetricWindowRow[],
): CreatorMetricWindowRow[] {
  const sufficient = rows.filter((r) => !r.insufficient);
  const insufficient = rows.filter((r) => r.insufficient);

  sufficient.sort((a, b) => {
    if (b.followersDelta !== a.followersDelta) return b.followersDelta - a.followersDelta;
    if (b.followers !== a.followers) return b.followers - a.followers;
    return (a.displayName ?? '').localeCompare(b.displayName ?? '');
  });
  insufficient.sort((a, b) => b.followers - a.followers);

  return [...sufficient, ...insufficient];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./apps/frontend exec jest src/lib/admin-top30.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/admin-top30.ts apps/frontend/src/lib/admin-top30.test.ts
git commit -m "feat(admin): rankCreatorsByFollowerDelta helper"
```

---

## Task 3: Generalize `ViewLeaderboard` with optional title/subtitle

**Files:**
- Modify: `apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx`

- [ ] **Step 1: Add optional props (defaults preserve current Phase 1 output)**

Replace the props interface and the header copy. Change:
```tsx
export interface ViewLeaderboardProps {
  rows: TopContentRow[];
}

export function ViewLeaderboard({ rows }: ViewLeaderboardProps) {
```
to:
```tsx
export interface ViewLeaderboardProps {
  rows: TopContentRow[];
  title?: string;
  subtitle?: string;
}

export function ViewLeaderboard({
  rows,
  title = 'Top Content',
  subtitle = 'Top 20 posts by views · last 30 days',
}: ViewLeaderboardProps) {
```
Then in the JSX header, replace the two hardcoded strings:
```tsx
        <span className="text-micro uppercase text-fgSubtle tracking-[0.04em]">
          {title}
        </span>
        <span className="text-caption text-fgMuted">
          {subtitle}
        </span>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS (no new errors). Defaults mean existing `<ViewLeaderboard rows={...} />` call sites are unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/components/leaderboard-showcase/view-leaderboard.tsx
git commit -m "refactor(leaderboard): optional title/subtitle on ViewLeaderboard"
```

---

## Task 4: `Top30Creators` table component

**Files:**
- Create: `apps/frontend/src/app/(admin)/admin/top30-creators.tsx`

- [ ] **Step 1: Write the component**

`apps/frontend/src/app/(admin)/admin/top30-creators.tsx`:
```tsx
/**
 * Top 30 creators by 30-day follower growth. Server-rendered dense table.
 * No engagement column (private-only). Delta uses yellow-mono caret +
 * intensity; `insufficient` rows show "Building history…".
 */
import Link from 'next/link';

import type { CreatorMetricWindowRow } from '@gitroom/frontend/lib/metrics-windowed';
import { formatCompact, formatDelta } from '@gitroom/frontend/lib/creator-metrics';
import { BUILDING_HISTORY } from '@gitroom/frontend/lib/format-metric';
import { PlatformPill } from '@gitroom/frontend/components/ui/platform-pill';
import type { PlatformKey } from '@gitroom/frontend/components/ui/platform-icons';

function toPlatformKey(platform: string | null): PlatformKey | null {
  if (!platform) return null;
  return platform === 'rednote' ? 'xiaohongshu' : (platform as PlatformKey);
}
function deltaClass(n: number): string {
  if (n === 0) return 'text-fgSubtle';
  return n > 0 ? 'text-fg' : 'text-fgMuted';
}
function deltaCaret(n: number): string {
  if (n === 0) return '— ';
  return n > 0 ? '▲ ' : '▼ ';
}

export function Top30Creators({ rows }: { rows: CreatorMetricWindowRow[] }) {
  return (
    <section className="glass-base border border-borderGlass rounded-2xl overflow-hidden">
      <div className="p-5 border-b border-borderGlass">
        <span className="text-micro uppercase text-fgSubtle tracking-[0.04em]">
          Top Creators
        </span>
        <div className="text-caption text-fgMuted">
          Top 30 by follower growth · last 30 days
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="p-6 text-body text-fgMuted">
          No creators ranked yet — building history…
        </div>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="text-micro uppercase text-fgSubtle tracking-[0.04em]">
              <th className="font-normal px-4 py-2.5 w-10">#</th>
              <th className="font-normal px-4 py-2.5">Creator</th>
              <th className="font-normal px-4 py-2.5">Platform</th>
              <th className="font-normal px-4 py-2.5 text-right">Followers</th>
              <th className="font-normal px-4 py-2.5 text-right">Δ30D</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <CreatorRow key={row.creatorId} row={row} rank={i + 1} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CreatorRow({ row, rank }: { row: CreatorMetricWindowRow; rank: number }) {
  const pk = toPlatformKey(row.primaryPlatform);
  const name = row.displayName ?? '—';
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <tr className="border-t border-borderGlass hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-2.5 font-mono tabular-nums text-caption text-fgSubtle">
        {String(rank).padStart(2, '0')}
      </td>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="size-7 rounded-full bg-customColor1 border border-borderGlass flex items-center justify-center overflow-hidden shrink-0">
            {row.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- external avatar, dims vary
              <img src={row.avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              <span className="text-caption text-fgMuted">{initial}</span>
            )}
          </span>
          {row.primaryHandle ? (
            <Link
              href={`/creators/${row.primaryHandle}`}
              className="text-body text-fg truncate hover:text-aurora-cta transition-colors"
            >
              {name}
            </Link>
          ) : (
            <span className="text-body text-fg truncate">{name}</span>
          )}
        </div>
      </td>
      <td className="px-4 py-2.5">
        {pk ? (
          <PlatformPill platform={pk} iconSize={12} className="!px-2 !py-1">
            {''}
          </PlatformPill>
        ) : (
          <span className="text-caption text-fgSubtle">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-body text-fg">
        {formatCompact(row.followers)}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-caption">
        {row.insufficient ? (
          <span className="text-fgSubtle">{BUILDING_HISTORY}</span>
        ) : (
          <span className={deltaClass(row.followersDelta)}>
            {deltaCaret(row.followersDelta)}
            {formatDelta(row.followersDelta)}
          </span>
        )}
      </td>
    </tr>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS. (If `PlatformPill` rejects `className`, confirm against `apps/frontend/src/app/(admin)/admin/profiles/page.tsx` which already passes `className="!px-2 !py-1"` to it — the prop exists.)

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/app/\(admin\)/admin/top30-creators.tsx
git commit -m "feat(admin): Top30Creators leaderboard table"
```

---

## Task 5: `createCreator` server action

**Files:**
- Create: `apps/frontend/src/app/(admin)/admin/actions.ts`

- [ ] **Step 1: Write the action**

`apps/frontend/src/app/(admin)/admin/actions.ts`:
```ts
'use server';

/**
 * Admin creator-provisioning action. Mirrors profiles/actions.ts conventions:
 * re-check admin (defense-in-depth), service-role writes, return a result
 * object instead of throwing, revalidatePath.
 *
 * Flow: create the auth login (the handle_new_auth_user trigger assigns
 * role='creator' + an empty creator_link) -> ensureCreatorForUser binds the
 * creator row -> per URL: detectPlatform -> findOrCreateProfile (canonical,
 * validates internally) -> addProfileClaim (owner, admin_assigned).
 *
 * email_confirm:true so the creator can sign in immediately (login-free,
 * agency-provisioned). The auth user is never rolled back on a downstream URL
 * failure — the login is the valuable artifact; failures are reported per-URL.
 */

import { revalidatePath } from 'next/cache';
import {
  getSupabaseAdmin,
  ensureCreatorForUser,
  findOrCreateProfile,
  addProfileClaim,
  detectPlatform,
} from '@d3/database';
import { getAuthContext } from '@gitroom/frontend/lib/auth';
import { normalizeProvisionUrls } from '@gitroom/frontend/lib/provision-plan';

export interface UrlResult {
  url: string;
  platform?: string;
  status: 'created' | 'linked' | 'failed';
  detail?: string;
}

export interface ProvisionResult {
  ok: boolean;
  message: string;
  /** Echoed once on success so the admin can hand them to the creator. */
  credentials?: { email: string; password: string };
  urlResults?: UrlResult[];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

async function requireAdmin(): Promise<void> {
  const auth = await getAuthContext();
  if (!auth || auth.role !== 'admin') throw new Error('Not authorized.');
}

export async function createCreator(
  _prev: ProvisionResult | null,
  formData: FormData,
): Promise<ProvisionResult> {
  try {
    await requireAdmin();

    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const displayName = String(formData.get('display_name') ?? '').trim();
    const rawUrls = formData.getAll('url').map((v) => String(v));

    if (!email) return { ok: false, message: 'Email is required.' };
    if (password.length < 8) return { ok: false, message: 'Password must be at least 8 characters.' };
    if (!displayName) return { ok: false, message: 'Display name is required.' };

    const admin = getSupabaseAdmin();

    // 1. Auth login. Trigger assigns role='creator' + empty creator_link.
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (created.error || !created.data.user) {
      return { ok: false, message: created.error?.message ?? 'Could not create the login.' };
    }
    const userId = created.data.user.id;

    // 2. Create + bind the creator row.
    const creatorRes = await ensureCreatorForUser({ user_id: userId, display_name: displayName });
    if (!creatorRes.ok) {
      return {
        ok: false,
        message: `Login created, but linking the creator failed: ${creatorRes.error}. Add profiles via /admin/profiles or retry.`,
        credentials: { email, password },
      };
    }
    const creatorId = creatorRes.value.creator_id;

    // 3. Assign social URLs — owner claims, admin-initiated.
    const urls = normalizeProvisionUrls(rawUrls);
    const urlResults: UrlResult[] = [];
    for (const url of urls) {
      const platform = detectPlatform(url);
      if (!platform) {
        urlResults.push({ url, status: 'failed', detail: 'Unrecognized platform URL.' });
        continue;
      }
      const profileRes = await findOrCreateProfile({
        platform,
        profile_url: url,
        fallback_creator_id: creatorId,
      });
      if (!profileRes.ok) {
        urlResults.push({ url, platform, status: 'failed', detail: profileRes.error });
        continue;
      }
      const claimRes = await addProfileClaim({
        user_id: userId,
        profile_id: profileRes.value.profile.id,
        claim_kind: 'owner',
        claimed_via: 'admin_assigned',
      });
      if (!claimRes.ok) {
        urlResults.push({ url, platform, status: 'failed', detail: claimRes.error });
        continue;
      }
      urlResults.push({
        url,
        platform,
        status: profileRes.value.created ? 'created' : 'linked',
      });
    }

    revalidatePath('/admin');

    const failures = urlResults.filter((r) => r.status === 'failed').length;
    const message =
      failures === 0
        ? `Created ${displayName}.`
        : `Created ${displayName} — ${failures} URL${failures === 1 ? '' : 's'} need attention.`;
    return { ok: true, message, credentials: { email, password }, urlResults };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS. Confirms `detectPlatform`, `findOrCreateProfile`, `addProfileClaim`, `ensureCreatorForUser`, `getSupabaseAdmin` are all exported from `@d3/database` (verified) and the `Result`/claim types line up.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/app/\(admin\)/admin/actions.ts
git commit -m "feat(admin): createCreator provisioning server action"
```

---

## Task 6: `ProvisionForm` client component

**Files:**
- Create: `apps/frontend/src/app/(admin)/admin/provision-form.tsx`

> Bundle-safety: this is a client component. Do NOT import `@d3/database` here (it would pull the service-role client into the browser bundle). All detection/validation is server-side in the action; the form is local state + the returned result.

- [ ] **Step 1: Write the component**

`apps/frontend/src/app/(admin)/admin/provision-form.tsx`:
```tsx
'use client';

/**
 * Admin "create creator" form. Credentials group + a dynamic list of social
 * profile URLs (add/remove rows). Submits via the createCreator server action
 * (useActionState); renders per-URL results + a once-only credentials panel.
 *
 * Yellow-mono: success/failure read from a glyph + label, not color.
 */

import { useActionState, useState } from 'react';
import { Button } from '@gitroom/frontend/components/ui/button';
import { Input } from '@gitroom/frontend/components/ui/input';
import { createCreator, type ProvisionResult } from './actions';

let rowSeq = 0;
function nextRowId(): number {
  return ++rowSeq;
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-fg shrink-0">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
function XGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-fgMuted shrink-0">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function ProvisionForm() {
  const [state, action, pending] = useActionState<ProvisionResult | null, FormData>(
    createCreator,
    null,
  );
  const [rows, setRows] = useState<{ id: number; value: string }[]>([
    { id: nextRowId(), value: '' },
  ]);

  function updateRow(id: number, value: string) {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, value } : row)));
  }
  function addRow() {
    setRows((r) => [...r, { id: nextRowId(), value: '' }]);
  }
  function removeRow(id: number) {
    setRows((r) => (r.length === 1 ? r : r.filter((row) => row.id !== id)));
  }

  return (
    <form action={action} className="flex flex-col gap-5">
      {/* Credentials */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block space-y-1.5">
          <span className="text-label text-fgMuted">Display name</span>
          <Input name="display_name" type="text" required placeholder="Creator name" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-label text-fgMuted">Email</span>
          <Input name="email" type="email" required placeholder="creator@example.com" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-label text-fgMuted">Password</span>
          <Input name="password" type="text" required minLength={8} placeholder="At least 8 characters" />
        </label>
      </div>

      {/* Social URLs */}
      <div className="flex flex-col gap-2 border-t border-borderGlass pt-4">
        <span className="text-label text-fgMuted">Social profile URLs</span>
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-2">
            <Input
              name="url"
              type="url"
              value={row.value}
              onChange={(e) => updateRow(row.id, e.target.value)}
              placeholder="https://www.instagram.com/handle"
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => removeRow(row.id)}
              className="shrink-0 size-9 inline-flex items-center justify-center rounded-md text-fgMuted hover:bg-white/[0.04] border border-white/10"
              aria-label="Remove URL"
            >
              <XGlyph />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          className="self-start text-label text-fgMuted hover:text-fg px-2 py-1"
        >
          + Add URL
        </button>
      </div>

      {/* Submit */}
      <div className="flex justify-end">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? 'Creating…' : 'Create creator'}
        </Button>
      </div>

      {/* Error */}
      {state && !state.ok && (
        <p className="text-caption text-fg flex items-center gap-1.5" role="alert">
          <XGlyph /> {state.message}
        </p>
      )}

      {/* Success: credentials echo + per-URL results */}
      {state?.ok && (
        <div className="flex flex-col gap-4">
          <p className="text-caption text-fgMuted">{state.message}</p>
          {state.credentials && (
            <CredentialsPanel email={state.credentials.email} password={state.credentials.password} />
          )}
          {state.urlResults && state.urlResults.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {state.urlResults.map((r) => (
                <li key={r.url} className="flex items-center gap-2 text-caption min-w-0">
                  {r.status === 'failed' ? <XGlyph /> : <CheckGlyph />}
                  <span className="text-fgMuted truncate">
                    {r.platform ? `${r.platform} · ` : ''}
                    {r.url}
                  </span>
                  {r.detail && <span className="text-fgSubtle shrink-0">— {r.detail}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}

function CredentialsPanel({ email, password }: { email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(`${email}\n${password}`);
    setCopied(true);
  }
  return (
    <div className="glass-elevated rounded-xl border border-borderGlass p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-label text-fgMuted">Login credentials</span>
        <button type="button" onClick={copy} className="text-label text-aurora-cta hover:underline">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="font-mono text-body-sm text-fg break-all">{email}</div>
      <div className="font-mono text-body-sm text-fg break-all">{password}</div>
      <span className="text-caption text-fgSubtle">
        Shown once — copy and share securely now.
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS. (If `Input` rejects `value`/`onChange`/`className`, confirm against `components/auth/sign-up-form.tsx` which already passes all three.)

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/app/\(admin\)/admin/provision-form.tsx
git commit -m "feat(admin): ProvisionForm client component"
```

---

## Task 7: Rebuild the `/admin` page

**Files:**
- Modify (rewrite): `apps/frontend/src/app/(admin)/admin/page.tsx`

- [ ] **Step 1: Replace the page**

Full new contents of `apps/frontend/src/app/(admin)/admin/page.tsx`:
```tsx
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseAdmin } from '@d3/database';
import { getAuthContext } from '@gitroom/frontend/lib/auth';
import {
  getCreatorMetricsWindowed,
  getTopContentWindowed,
} from '@gitroom/frontend/lib/metrics-windowed';
import { rankCreatorsByFollowerDelta } from '@gitroom/frontend/lib/admin-top30';
import { ViewLeaderboard } from '@gitroom/frontend/components/leaderboard-showcase/view-leaderboard';
import { Top30Creators } from './top30-creators';
import { ProvisionForm } from './provision-form';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Admin — D3 Creator',
};

export default async function AdminPage() {
  // Defense-in-depth: layout already gates on role=admin, but re-check here
  // before touching service-role.
  const auth = await getAuthContext();
  if (!auth) redirect('/login');
  if (auth.role !== 'admin') redirect('/me');

  const admin = getSupabaseAdmin();

  const [
    { count: creatorCount },
    { count: profileCount },
    { count: userCount },
    creatorMetrics,
    topContent,
  ] = await Promise.all([
    admin.from('creator').select('*', { count: 'exact', head: true }),
    admin.from('profile').select('*', { count: 'exact', head: true }),
    admin.from('user_role').select('*', { count: 'exact', head: true }),
    getCreatorMetricsWindowed('30d', { client: admin }),
    getTopContentWindowed('30d', { client: admin, limit: 30 }),
  ]);

  const stats = [
    { label: 'Creators', value: creatorCount ?? 0 },
    { label: 'Platform profiles', value: profileCount ?? 0 },
    { label: 'Users', value: userCount ?? 0 },
  ];
  const rankedCreators = rankCreatorsByFollowerDelta(creatorMetrics).slice(0, 30);

  return (
    <div className="flex flex-col gap-10 pt-12 pb-24">
      <header className="max-w-[760px]">
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass-subtle border border-borderGlass text-caption text-aurora-cta mb-6">
          <span className="inline-block size-1.5 rounded-full bg-aurora-cta" />
          Admin
        </span>
        <h1 className="text-display-2 text-fg mb-4">Full agency view.</h1>
        <p className="text-body-lg text-fgMuted max-w-[600px]">
          Top growth across every creator and platform, plus everything you need
          to provision a new creator account.
        </p>
      </header>

      {/* Stat tiles with drill-in footer */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {stats.map((s) => (
          <article
            key={s.label}
            className="glass-elevated rounded-2xl overflow-hidden flex flex-col"
          >
            <div className="p-6">
              <div className="text-caption text-fgMuted">{s.label}</div>
              <div className="text-display-2 text-fg tabular-nums mt-2">
                {Intl.NumberFormat().format(s.value)}
              </div>
            </div>
            <Link
              href="/admin/profiles"
              className="border-t border-borderGlass px-6 py-3 text-caption text-fgMuted hover:text-fg hover:bg-white/[0.04] transition-colors text-right"
            >
              View accounts →
            </Link>
          </article>
        ))}
      </section>

      {/* Provision a creator */}
      <section className="flex flex-col gap-4">
        <div>
          <h2 className="text-section text-fg">Provision a creator</h2>
          <p className="text-caption text-fgMuted mt-1">
            Create the login and assign social URLs. The creator can sign in
            immediately — public signup is disabled.
          </p>
        </div>
        <div className="glass-elevated rounded-2xl p-6">
          <ProvisionForm />
        </div>
      </section>

      {/* Top-30 split */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <Top30Creators rows={rankedCreators} />
        <ViewLeaderboard
          rows={topContent}
          title="Top Content"
          subtitle="Top 30 by views · last 30 days"
        />
      </section>

      <div className="text-caption text-fgMuted">
        <Link href="/admin/profiles" className="text-aurora-cta underline underline-offset-4">
          Manage accounts →
        </Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/app/\(admin\)/admin/page.tsx
git commit -m "feat(admin): rebuild /admin as Top-30 + provisioning dashboard"
```

---

## Task 8: Kill public signup

**Files:**
- Modify: `apps/frontend/src/proxy.ts`
- Delete: `apps/frontend/src/app/(auth)/signup/page.tsx`
- Delete: `apps/frontend/src/components/auth/sign-up-form.tsx`
- Modify: `apps/frontend/src/app/(public)/layout.tsx`
- Modify: `apps/frontend/src/app/(auth)/login/page.tsx`

- [ ] **Step 1: Add the `/signup → /login` redirect in `proxy.ts`**

In `apps/frontend/src/proxy.ts`, change:
```ts
const AUTH_PAGES = new Set(['/login', '/signup']);
```
to:
```ts
const AUTH_PAGES = new Set(['/login']);
```
Then immediately after the `/api` bail (`if (pathname.startsWith('/api')) return response;`), add:
```ts
  // Public signup is killed — provisioning is admin-only. Redirect any /signup
  // hit to login (anon + authed; works even after the route file is gone since
  // middleware runs before routing).
  if (pathname === '/signup') {
    return NextResponse.redirect(new URL('/login', request.url));
  }
```

- [ ] **Step 2: Delete the signup route + form**

```bash
git rm apps/frontend/src/app/\(auth\)/signup/page.tsx apps/frontend/src/components/auth/sign-up-form.tsx
```

- [ ] **Step 3: Remove signup CTAs from the public header**

In `apps/frontend/src/app/(public)/layout.tsx`, in the **desktop nav** replace the anonymous branch:
```tsx
              ) : (
                <>
                  <NavLink href="/login">Sign in</NavLink>
                  <Link
                    href="/signup"
                    className="ml-1 inline-flex items-center px-3 py-1.5 rounded-md bg-aurora-cta text-brand-darker hover:bg-aurora-ctaHover transition-colors text-label font-medium"
                  >
                    Sign up
                  </Link>
                </>
              )}
```
with:
```tsx
              ) : (
                <NavLink href="/login">Sign in</NavLink>
              )}
```
In the **mobile nav**, replace:
```tsx
              {auth ? (
                <SignOutButton />
              ) : (
                <Link
                  href="/signup"
                  className="inline-flex items-center px-3 py-1.5 rounded-md bg-aurora-cta text-brand-darker hover:bg-aurora-ctaHover transition-colors text-label font-medium"
                >
                  Sign up
                </Link>
              )}
```
with:
```tsx
              {auth && <SignOutButton />}
```
(The mobile hamburger `MobileNav` already includes a `/login` "Sign in" link for anonymous users — leave that block unchanged.)

- [ ] **Step 4: Remove the signup link on the login page**

In `apps/frontend/src/app/(auth)/login/page.tsx`, delete the trailing paragraph:
```tsx
      <p className="text-caption text-fgMuted text-center">
        Don&apos;t have an account?{' '}
        <Link
          href="/signup"
          className="text-fg underline underline-offset-4 hover:text-aurora-cta transition-colors"
        >
          Sign up as a creator
        </Link>
      </p>
```
Then remove the now-unused `import Link from 'next/link';` at the top of that file (the `Link` import is orphaned by this deletion — confirm no other `Link` usage remains in the file before removing).

- [ ] **Step 5: Verify no live `/signup` references remain**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS (no missing-import / unused-var errors).

Then grep for stragglers:
Run (Grep tool): pattern `href="/signup"|/signup` across `apps/frontend/src`.
Expected: the ONLY match is the redirect line in `proxy.ts`. Any other match is a missed CTA — remove it.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/proxy.ts apps/frontend/src/app/\(public\)/layout.tsx apps/frontend/src/app/\(auth\)/login/page.tsx
git commit -m "feat(auth): kill public signup — delete route, redirect /signup to /login"
```

---

## Task 9: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `pnpm --filter ./apps/frontend exec tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 2: Unit tests**

Run: `pnpm --filter ./apps/frontend exec jest`
Expected: PASS, including `provision-plan.test.ts` (3) and `admin-top30.test.ts` (4). No pre-existing tests regress.

- [ ] **Step 3: Production build**

Run (bash): `cd apps/frontend && set -a && . ../../.env && set +a && pnpm exec next build`
Expected: build succeeds. (The `/dev/logo-preview` prerender warning is pre-existing and unrelated.)

- [ ] **Step 4: Manual smoke via Preview MCP**

Start the `preview` launch config (`preview_start`, name `preview`). Then:
1. Log in as `admin@d3.test` / `Passw0rd!`. Load `/admin`. Confirm: 3 stat tiles with "View accounts →" footers, the "Provision a creator" form, and the two Top-30 panels render (mostly "Building history…" today — expected with ~1 snapshot day).
2. Provision a creator: unique email (e.g. `phase2test+<n>@d3.test`), password `Passw0rd!`, a display name, and one valid URL (e.g. a real Instagram profile URL). Submit. Confirm: success message, credentials panel (Copy works), and a per-URL `created`/`linked` row.
3. Confirm the new creator appears at `/admin/profiles`.
4. Sign out; sign in with the new creator's email + password. Confirm immediate login (no email-confirmation wall) and landing on `/me`.
5. Navigate to `/signup` → confirm 307 redirect to `/login`. Confirm no "Sign up" CTA in the public header (desktop + mobile) or on `/login`.

Capture a screenshot of `/admin` for the PR.

- [ ] **Step 5: Update the knowledge graph**

Run (bash): `graphify update .`
Expected: AST-only refresh, no API cost.

---

## Self-review notes (spec coverage)

- Spec §4.2 `/admin` dashboard → Task 7. §4.3 `Top30Creators` → Task 4. §4.4 ranking → Task 2. §4.5 provisioning (action/form/helper) → Tasks 1, 5, 6. §4.6 `ViewLeaderboard` props → Task 3. §4.7 kill signup → Task 8. §6 verification → Task 9.
- **Deviation from spec §4.5:** the pure helper is `normalizeProvisionUrls` (trim/dedup only); platform detection/validation moved into the action (`detectPlatform` + `findOrCreateProfile`). Reason: keeps the unit-tested helper free of `@d3/database` (jest resolution + no server import in the test) and keeps the client form free of server code. Behavior is equivalent; per-URL outcomes are still reported.
- **Deviation from spec §4.5:** the form shows platform in the *results* (server-authoritative) rather than a live per-row icon preview, to avoid importing `@d3/database`/detection into the client bundle.
- Out of scope confirmed untouched: `/admin/profiles`, `(auth)/onboarding/`, `/me`, claim/discovery API routes.
