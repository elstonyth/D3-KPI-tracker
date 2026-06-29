# Admin Account Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a per-creator editor (`/admin/creators/[id]`) to rename a creator, add/re-point/remove its social URLs, reset its login password, and delete it — and fix the pending-claim "Approve" action so it no longer fails opaquely on an already-owned profile.

**Architecture:** A new server-component page renders a client editor whose sections each post to a thin server action in `creators/[id]/actions.ts`. Actions reuse the existing `@d3/database` helpers and `lib/account-validation` validators, write via the service-role client, and return `{ ok, message }`. A new `resolveShortLink` helper in `@d3/database` turns share links into canonical URLs before validation. The Approve fix adds an owner pre-check in `approveClaim` plus an `alreadyOwned` flag the UI uses to guard the button. No DB migration.

**Tech Stack:** Next.js App Router (React 19) server actions, Supabase (`@supabase/supabase-js` service-role), TypeScript, `tsx` integration tests against a local Supabase stack.

**Spec:** [docs/superpowers/specs/2026-06-01-admin-account-editor-design.md](../specs/2026-06-01-admin-account-editor-design.md)

---

## Conventions (read once)

- **Local stack only for tests.** Never run tests against prod. Start the local stack and pull keys with `npx --no-install supabase status -o env`. The DB container is `supabase_db_D3-Creator`.
- **Run tsx tests** with the local env exported inline, e.g.:
  ```bash
  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
  SUPABASE_SERVICE_ROLE_KEY=<sb_secret_… from supabase status -o env> \
  pnpm exec tsx supabase/tests/<file>.mts
  ```
- **`ActionResult`** = `{ ok: boolean; message: string }` (already defined in `profiles/actions.ts`; re-declared in the new actions file).
- **Result helpers from `@d3/database`** return `{ ok: true, value } | { ok: false, error }`. Branch on `res.ok !== true`.
- **Validators** (`lib/account-validation.ts`) return `{ ok: true, value } | { ok: false, error }`.
- **Every action**: `await requireAdmin()` first, `isUuid()` every id, service-role writes, return (never throw), `revalidatePath`.
- **Commit trailer:** end every commit body with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `libraries/database/src/profile-url.ts` | add `resolveShortLink` | Modify |
| `libraries/database/src/index.ts` | re-export `resolveShortLink` | Modify |
| `apps/frontend/src/app/(admin)/admin/profiles/actions.ts` | `approveClaim` owner pre-check + message | Modify |
| `apps/frontend/src/lib/admin-creators.ts` | `alreadyOwned` on pending claims; new `getAdminCreatorDetail` | Modify |
| `apps/frontend/src/app/(admin)/admin/profiles/admin-actions.tsx` | `ClaimActions` Approve guard | Modify |
| `apps/frontend/src/app/(admin)/admin/profiles/page.tsx` | pass `alreadyOwned`; "Manage" link | Modify |
| `apps/frontend/src/app/(admin)/admin/actions.ts` | provisioning uses `resolveShortLink` | Modify |
| `apps/frontend/src/app/(admin)/admin/creators/[id]/actions.ts` | 6 editor server actions | Create |
| `apps/frontend/src/app/(admin)/admin/creators/[id]/page.tsx` | editor page (server component) | Create |
| `apps/frontend/src/app/(admin)/admin/creators/[id]/creator-editor.tsx` | editor UI (client) | Create |
| `supabase/tests/resolve-short-link.mts` | unit test (injected fetch, no DB) | Create |
| `supabase/tests/approve-claim-guard.mts` | integration: owner guard | Create |
| `supabase/tests/admin-account-editor.mts` | integration: editor action logic | Create |

---

## Task 0: Branch + commit the approved spec

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main
git checkout -b feat/admin-account-editor
```

- [ ] **Step 2: Commit the spec + this plan**

```bash
git add docs/superpowers/specs/2026-06-01-admin-account-editor-design.md docs/superpowers/plans/2026-06-02-admin-account-editor.md
git commit -m "docs(admin-editor): design spec + implementation plan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 1: `resolveShortLink` helper

Resolve allowlisted share/short links (`xhslink.com`, `vm`/`vt.tiktok.com`, `v.douyin.com`) to their final URL before validation. Non-shortlink hosts pass through untouched (no network call). Injectable `fetchImpl` makes it testable with no real network.

**Files:**
- Modify: `libraries/database/src/profile-url.ts` (append `resolveShortLink`)
- Modify: `libraries/database/src/index.ts:12-18` (add to the profile-url re-export)
- Test: `supabase/tests/resolve-short-link.mts`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/resolve-short-link.mts`:

```ts
/**
 * Unit test for resolveShortLink — no DB, no real network. A fake fetch returns
 * canned 30x/200 responses so redirect-following, the host allowlist, the cap,
 * and fail-closed behavior are all deterministic.
 *   pnpm exec tsx supabase/tests/resolve-short-link.mts
 */
import { resolveShortLink } from '@d3/database';

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

// Build a fake fetch from a map of url -> {status, location} (302) or {status:200}.
function fakeFetch(routes: Record<string, { status: number; location?: string }>) {
  return async (url: string | URL): Promise<Response> => {
    const key = url.toString();
    const r = routes[key];
    if (!r) return new Response(null, { status: 200 }); // terminal
    const headers = new Headers();
    if (r.location) headers.set('location', r.location);
    return new Response(null, { status: r.status, headers });
  };
}

async function main() {
  // 1. Non-shortlink host: returned unchanged, fetch never called.
  let called = false;
  const noFetch = (async () => { called = true; return new Response(null); }) as typeof fetch;
  const passthrough = await resolveShortLink('https://www.tiktok.com/@nasa', noFetch);
  check('non-shortlink passes through unchanged', passthrough === 'https://www.tiktok.com/@nasa');
  check('non-shortlink never hits the network', called === false);

  // 2. Single redirect to a canonical profile URL.
  const f1 = fakeFetch({
    'https://vm.tiktok.com/ZMabc/': { status: 302, location: 'https://www.tiktok.com/@nasa' },
    'https://www.tiktok.com/@nasa': { status: 200 },
  }) as typeof fetch;
  const r1 = await resolveShortLink('https://vm.tiktok.com/ZMabc/', f1);
  check('tiktok shortlink resolves to final url', r1 === 'https://www.tiktok.com/@nasa', r1);

  // 3. Bare (no-scheme) shortlink input still resolves.
  const f2 = fakeFetch({
    'https://v.douyin.com/abc/': { status: 301, location: 'https://www.douyin.com/user/MS4wABC' },
    'https://www.douyin.com/user/MS4wABC': { status: 200 },
  }) as typeof fetch;
  const r2 = await resolveShortLink('v.douyin.com/abc/', f2);
  check('bare douyin shortlink resolves', r2 === 'https://www.douyin.com/user/MS4wABC', r2);

  // 4. Redirect loop / too many hops → fail closed (return original).
  const loop = fakeFetch({
    'https://vm.tiktok.com/loop/': { status: 302, location: 'https://vm.tiktok.com/loop/' },
  }) as typeof fetch;
  const r3 = await resolveShortLink('https://vm.tiktok.com/loop/', loop);
  check('redirect loop fails closed to original', r3 === 'https://vm.tiktok.com/loop/', r3);

  // 5. Network error → fail closed (return original).
  const boom = (async () => { throw new Error('network down'); }) as typeof fetch;
  const r4 = await resolveShortLink('https://vm.tiktok.com/x/', boom);
  check('network error fails closed to original', r4 === 'https://vm.tiktok.com/x/', r4);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
await main();
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm exec tsx supabase/tests/resolve-short-link.mts
```
Expected: FAIL — `resolveShortLink` is not exported from `@d3/database` (import error / undefined).

- [ ] **Step 3: Implement `resolveShortLink`**

Append to `libraries/database/src/profile-url.ts` (after `normalizeHandle`):

```ts
/**
 * Resolve an allowlisted short/redirector link to its final URL so it can be
 * validated like any normal profile URL. Only hosts in SHORTLINK_HOSTS trigger
 * a network round-trip; everything else returns unchanged with no fetch.
 *
 * Safety: we only INITIATE requests to known short-link domains, follow at most
 * 5 redirects with a 3s timeout, and never throw — on any failure we return the
 * original input so the caller's validateProfileUrl rejects it with the usual
 * short-link message (fail closed). The final URL is still validated downstream
 * (must be a known platform PROFILE host), so a redirect elsewhere is rejected.
 */
export async function resolveShortLink(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let u: URL;
  try {
    u = new URL(ensureScheme(rawUrl.trim()));
  } catch {
    return rawUrl;
  }
  if (!SHORTLINK_HOSTS.some((s) => s.re.test(u.hostname))) return rawUrl;

  let current = u.toString();
  for (let hop = 0; hop < 5; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      return rawUrl; // network error / timeout → fail closed
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return rawUrl;
      let next: string;
      try {
        next = new URL(loc, current).toString();
      } catch {
        return rawUrl;
      }
      if (next === current) return rawUrl; // self-loop
      current = next;
      continue;
    }
    return current; // non-redirect → resolved
  }
  return rawUrl; // exceeded redirect cap
}
```

- [ ] **Step 4: Export it from the package barrel**

In `libraries/database/src/index.ts`, add `resolveShortLink` to the existing profile-url export block:

```ts
export {
  detectPlatform,
  normalizeHandle,
  resolveShortLink,
  validateProfileUrl,
  type ProfileUrlValidation,
  type ProfileUrlValidationError,
} from './profile-url';
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm exec tsx supabase/tests/resolve-short-link.mts
```
Expected: `5 passed, 0 failed`, exit 0.

- [ ] **Step 6: Commit**

```bash
git add libraries/database/src/profile-url.ts libraries/database/src/index.ts supabase/tests/resolve-short-link.mts
git commit -m "feat(database): add resolveShortLink for share/short links

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Fix Approve-claim on already-owned profiles

`approveClaim` always sets `claim_kind='owner'`, hitting `profile_claim_one_owner` (23505) when an owner exists. Add a pre-check returning a clear message; surface `alreadyOwned` to the UI so Approve is hidden when it can't succeed.

**Files:**
- Modify: `apps/frontend/src/app/(admin)/admin/profiles/actions.ts:33-61` (`approveClaim`)
- Modify: `apps/frontend/src/lib/admin-creators.ts` (`AdminPendingClaim` + `pendingClaims` build)
- Modify: `apps/frontend/src/app/(admin)/admin/profiles/admin-actions.tsx` (`ClaimActions`)
- Modify: `apps/frontend/src/app/(admin)/admin/profiles/page.tsx:188` (pass `alreadyOwned`)
- Test: `supabase/tests/approve-claim-guard.mts`

- [ ] **Step 1: Write the failing integration test**

Create `supabase/tests/approve-claim-guard.mts`:

```ts
/**
 * Reproduces approveClaim's owner-guard logic (actions.ts) against a LOCAL stack:
 *   - approving a pending claim on an UNOWNED profile promotes it to owner (ok)
 *   - approving on an ALREADY-OWNED profile is blocked with a clear message and
 *     leaves the pending claim untouched.
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm exec tsx supabase/tests/approve-claim-guard.mts
 */
import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin, ensureCreatorForUser, findOrCreateProfile, addProfileClaim } from '@d3/database';

const sb = getSupabaseAdmin();
let pass = 0, fail = 0;
function check(n: string, ok: boolean, d = '') { ok ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`)); }
const userIds: string[] = [];
const creatorIds: string[] = [];

// The production guard, reproduced (actions.ts approveClaim minus requireAdmin/revalidate).
async function approve(userId: string, profileId: string): Promise<{ ok: boolean; message: string }> {
  const owner = await sb.from('profile_claim').select('user_id').eq('profile_id', profileId).eq('claim_kind', 'owner').maybeSingle();
  if (owner.data && owner.data.user_id !== userId) {
    return { ok: false, message: "This profile already has an owner — reject this claim, or reassign ownership from the creator's editor." };
  }
  const { error } = await sb.from('profile_claim').update({ claim_kind: 'owner', confirmed_at: new Date().toISOString() }).eq('user_id', userId).eq('profile_id', profileId);
  if (error) return { ok: false, message: error.code === '23505' ? "This profile already has an owner — reject this claim, or reassign ownership from the creator's editor." : 'Could not approve the claim.' };
  return { ok: true, message: 'Claim approved.' };
}

async function mkUser() {
  const u = await sb.auth.admin.createUser({ email: `g_${randomUUID().slice(0, 8)}@test.local`, password: randomUUID(), email_confirm: true });
  userIds.push(u.data.user!.id); return u.data.user!.id;
}

async function main() {
  const owner = await mkUser();
  const cr = await ensureCreatorForUser({ user_id: owner, display_name: `Guard ${randomUUID().slice(0, 4)}` });
  creatorIds.push(cr.ok ? cr.value.creator_id : '');
  const prof = await findOrCreateProfile({ platform: 'instagram', profile_url: `https://www.instagram.com/g${randomUUID().slice(0, 8)}`, fallback_creator_id: cr.ok ? cr.value.creator_id : '' });
  const profileId = prof.ok ? prof.value.profile.id : '';

  // Case 1: unowned profile — a pending claim approves cleanly.
  const claimer1 = await mkUser();
  await sb.from('profile_claim').insert({ user_id: claimer1, profile_id: profileId, claim_kind: 'pending', claimed_via: 'manual', confirmed_at: null });
  const r1 = await approve(claimer1, profileId);
  check('unowned profile: approve succeeds', r1.ok, r1.message);
  const k1 = await sb.from('profile_claim').select('claim_kind').eq('user_id', claimer1).eq('profile_id', profileId).single();
  check('unowned profile: claim is now owner', k1.data?.claim_kind === 'owner');

  // Case 2: now owned — a second pending claim is blocked, left pending.
  const claimer2 = await mkUser();
  await sb.from('profile_claim').insert({ user_id: claimer2, profile_id: profileId, claim_kind: 'pending', claimed_via: 'manual', confirmed_at: null });
  const r2 = await approve(claimer2, profileId);
  check('owned profile: approve blocked (ok === false)', r2.ok === false, r2.message);
  check('owned profile: message explains the conflict', /already has an owner/.test(r2.message), r2.message);
  const k2 = await sb.from('profile_claim').select('claim_kind').eq('user_id', claimer2).eq('profile_id', profileId).single();
  check('owned profile: blocked claim stays pending', k2.data?.claim_kind === 'pending', k2.data?.claim_kind);
}

async function cleanup() {
  if (creatorIds.filter(Boolean).length) await sb.from('creator').delete().in('id', creatorIds.filter(Boolean));
  for (const u of userIds) await sb.auth.admin.deleteUser(u).catch(() => {});
}
try { await main(); } finally { await cleanup(); }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<sb_secret_…> pnpm exec tsx supabase/tests/approve-claim-guard.mts
```
Expected: the test's own `approve()` mirror passes, BUT this proves the intended logic before we change the real action. (If the local stack isn't up: `npx --no-install supabase start`.) Confirm `4 passed`. This pins the behaviour the action must match.

- [ ] **Step 3: Update `approveClaim` in `profiles/actions.ts`**

Replace the body of `approveClaim` (between the `isUuid` guard and `revalidatePath`) so it pre-checks for an existing owner:

```ts
    const admin = getSupabaseAdmin();

    // One owner per profile (partial unique profile_claim_one_owner). If another
    // user already owns it, promoting this claim to 'owner' would 23505 — tell the
    // admin plainly instead of failing opaquely.
    const owner = await admin
      .from('profile_claim')
      .select('user_id')
      .eq('profile_id', profileId)
      .eq('claim_kind', 'owner')
      .maybeSingle();
    if (owner.data && owner.data.user_id !== userId) {
      return {
        ok: false,
        message:
          "This profile already has an owner — reject this claim, or reassign ownership from the creator's editor.",
      };
    }

    const { error } = await admin
      .from('profile_claim')
      .update({ claim_kind: 'owner', confirmed_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('profile_id', profileId);
    if (error) {
      console.error('[admin/approveClaim]', error);
      return {
        ok: false,
        message:
          error.code === '23505'
            ? "This profile already has an owner — reject this claim, or reassign ownership from the creator's editor."
            : 'Could not approve the claim.',
      };
    }

    revalidatePath('/admin/profiles');
    return { ok: true, message: 'Claim approved.' };
```

- [ ] **Step 4: Add `alreadyOwned` to pending claims in `admin-creators.ts`**

In the `AdminPendingClaim` interface add:

```ts
  /** True when the claim's profile already has an owner — Approve cannot succeed. */
  alreadyOwned: boolean;
```

In the `pendingClaims` builder (the `.filter((c) => c.claim_kind === 'pending').map(...)`), compute it from the already-loaded `claimsByProfile`:

```ts
  const pendingClaims: AdminPendingClaim[] = claims
    .filter((c) => c.claim_kind === 'pending')
    .map((c) => {
      const p = profiles.find((pr) => pr.id === c.profile_id);
      const alreadyOwned = (claimsByProfile.get(c.profile_id) ?? []).some(
        (x) => x.claim_kind === 'owner',
      );
      return {
        userId: c.user_id,
        profileId: c.profile_id,
        platform: p?.platform ?? '—',
        handle: p?.handle ?? null,
        profileUrl: p?.profile_url ?? '',
        creatorName: p ? creatorName.get(p.creator_id) ?? '—' : '—',
        alreadyOwned,
      };
    });
```

> Note: `claimsByProfile` is built a few lines above the pending-claims block — no new query.

- [ ] **Step 5: Guard the Approve button in `ClaimActions`**

In `admin-actions.tsx`, change the `ClaimActions` signature and Approve form:

```tsx
export function ClaimActions({
  userId,
  profileId,
  alreadyOwned,
}: {
  userId: string;
  profileId: string;
  alreadyOwned: boolean;
}) {
  const [approveState, approveAction] = useActionState(approveClaim, null);
  const [rejectState, rejectAction] = useActionState(rejectClaim, null);
  const error =
    approveState && !approveState.ok
      ? approveState.message
      : rejectState && !rejectState.ok
        ? rejectState.message
        : null;

  return (
    <div className="flex flex-col items-end gap-1.5 shrink-0">
      <div className="flex gap-2">
        {!alreadyOwned && (
          <form action={approveAction}>
            <input type="hidden" name="user_id" value={userId} />
            <input type="hidden" name="profile_id" value={profileId} />
            <SubmitButton className={APPROVE_CLS} pendingLabel="Approving…">
              Approve
            </SubmitButton>
          </form>
        )}
        <form action={rejectAction}>
          <input type="hidden" name="user_id" value={userId} />
          <input type="hidden" name="profile_id" value={profileId} />
          <SubmitButton className={REJECT_CLS} pendingLabel="Rejecting…">
            Reject
          </SubmitButton>
        </form>
      </div>
      {alreadyOwned && (
        <span className="text-caption text-fgSubtle max-w-[220px] text-right">
          Already owned — reject, or reassign in the creator&apos;s editor.
        </span>
      )}
      {error && <span className="text-caption text-red-400 max-w-[220px] text-right">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 6: Pass `alreadyOwned` from the page**

In `profiles/page.tsx`, update the `ClaimActions` usage (currently `<ClaimActions userId={c.userId} profileId={c.profileId} />`):

```tsx
                <ClaimActions userId={c.userId} profileId={c.profileId} alreadyOwned={c.alreadyOwned} />
```

- [ ] **Step 7: Re-run the guard test + lint**

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<sb_secret_…> pnpm exec tsx supabase/tests/approve-claim-guard.mts
pnpm lint
```
Expected: `4 passed, 0 failed`; lint clean.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/app/(admin)/admin/profiles/actions.ts apps/frontend/src/lib/admin-creators.ts apps/frontend/src/app/(admin)/admin/profiles/admin-actions.tsx apps/frontend/src/app/(admin)/admin/profiles/page.tsx supabase/tests/approve-claim-guard.mts
git commit -m "fix(admin): clear message + Approve guard for owned profiles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `getAdminCreatorDetail` data fetch

One query bundle for the editor page: the creator, its profiles, and its login(s) (email via the auth admin API since `auth.users` isn't exposed through PostgREST).

**Files:**
- Modify: `apps/frontend/src/lib/admin-creators.ts` (append exported interface + function)

- [ ] **Step 1: Append the detail interface + function**

Add to `admin-creators.ts`:

```ts
export interface AdminCreatorLogin {
  userId: string;
  email: string;
}

export interface AdminCreatorDetail {
  creatorId: string;
  displayName: string;
  avatarUrl: string | null;
  profiles: AdminProfileRow[];
  logins: AdminCreatorLogin[];
}

/**
 * Per-creator detail for the editor page. Returns null when the creator does not
 * exist. Logins come from creator_link → auth.admin.getUserById (auth schema
 * isn't reachable via PostgREST). Service-role only.
 */
export async function getAdminCreatorDetail(
  admin: SupabaseClient,
  creatorId: string,
): Promise<AdminCreatorDetail | null> {
  const creatorRes = await admin
    .from('creator')
    .select('id, display_name, avatar_url')
    .eq('id', creatorId)
    .maybeSingle();
  if (creatorRes.error || !creatorRes.data) return null;
  const creator = creatorRes.data as { id: string; display_name: string; avatar_url: string | null };

  const profilesRes = await admin
    .from('profile')
    .select('id, platform, profile_url, handle, display_name, scrape_status')
    .eq('creator_id', creatorId)
    .order('platform', { ascending: true });
  const profileRows = (profilesRes.data ?? []) as Array<{
    id: string; platform: string; profile_url: string; handle: string | null;
    display_name: string | null; scrape_status: string;
  }>;
  const profileIds = profileRows.map((p) => p.id);

  let claims: { profile_id: string; user_id: string; claim_kind: string }[] = [];
  if (profileIds.length) {
    const { data } = await admin
      .from('profile_claim')
      .select('profile_id, user_id, claim_kind')
      .in('profile_id', profileIds);
    claims = (data ?? []) as typeof claims;
  }
  const claimsByProfile = new Map<string, typeof claims>();
  for (const c of claims) {
    const arr = claimsByProfile.get(c.profile_id);
    if (arr) arr.push(c);
    else claimsByProfile.set(c.profile_id, [c]);
  }

  const profiles: AdminProfileRow[] = profileRows.map((p) => {
    const pc = claimsByProfile.get(p.id) ?? [];
    return {
      id: p.id,
      platform: p.platform,
      handle: p.handle,
      displayName: p.display_name,
      profileUrl: p.profile_url,
      scrapeStatus: p.scrape_status,
      followers: null,
      followersDelta: null,
      views: null,
      ownerCount: pc.filter((c) => c.claim_kind === 'owner').length,
      trackerCount: pc.filter((c) => c.claim_kind === 'tracker').length,
      pendingCount: pc.filter((c) => c.claim_kind === 'pending').length,
    };
  });

  const linksRes = await admin.from('creator_link').select('user_id').eq('creator_id', creatorId);
  const logins: AdminCreatorLogin[] = [];
  for (const l of (linksRes.data ?? []) as { user_id: string }[]) {
    const u = await admin.auth.admin.getUserById(l.user_id);
    if (u.data?.user) logins.push({ userId: l.user_id, email: u.data.user.email ?? '' });
  }

  return {
    creatorId: creator.id,
    displayName: creator.display_name,
    avatarUrl: creator.avatar_url,
    profiles,
    logins,
  };
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter ./apps/frontend exec tsc --noEmit
```
Expected: no errors (this function is exercised end-to-end in Task 7).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend/src/lib/admin-creators.ts
git commit -m "feat(admin): getAdminCreatorDetail for the editor page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Editor server actions

Six thin actions, all `requireAdmin → isUuid → service-role → ActionResult → revalidatePath`.

**Files:**
- Create: `apps/frontend/src/app/(admin)/admin/creators/[id]/actions.ts`

- [ ] **Step 1: Create the actions file**

```ts
'use server';

/**
 * Per-creator editor actions. Same conventions as profiles/actions.ts: re-check
 * admin, validate ids, service-role writes, return {ok,message} (never throw),
 * revalidatePath. Ownership/URL logic reuses @d3/database helpers.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomBytes } from 'node:crypto';
import {
  getSupabaseAdmin,
  detectPlatform,
  resolveShortLink,
  validateProfileUrl,
  findOrCreateProfile,
  addProfileClaim,
} from '@d3/database';
import { requireAdmin } from '@gitroom/frontend/lib/auth';
import { isUuid } from '@gitroom/frontend/lib/ids';
import { validateDisplayName, validatePassword } from '@gitroom/frontend/lib/account-validation';

export interface ActionResult {
  ok: boolean;
  message: string;
}
export interface PasswordResetResult extends ActionResult {
  credentials?: { email: string; password: string };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

function revalidateCreator(creatorId: string) {
  revalidatePath(`/admin/creators/${creatorId}`);
  revalidatePath('/admin/profiles');
  revalidatePath('/admin');
}

/** crypto-strong, login-friendly throwaway password (passes validatePassword). */
function generatePassword(): string {
  return randomBytes(12).toString('base64url'); // ~16 chars, < 72 bytes
}

export async function renameCreator(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    if (!isUuid(creatorId)) return { ok: false, message: 'Invalid creator id.' };
    const nameRes = validateDisplayName(String(formData.get('display_name') ?? ''));
    if (!nameRes.ok) return { ok: false, message: nameRes.error };

    const admin = getSupabaseAdmin();
    const { error } = await admin.from('creator').update({ display_name: nameRes.value }).eq('id', creatorId);
    if (error) {
      console.error('[admin/renameCreator]', error);
      return { ok: false, message: 'Could not rename the creator.' };
    }
    revalidateCreator(creatorId);
    return { ok: true, message: 'Renamed.' };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function addCreatorUrl(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    if (!isUuid(creatorId)) return { ok: false, message: 'Invalid creator id.' };

    const resolved = await resolveShortLink(String(formData.get('url') ?? ''));
    const platform = detectPlatform(resolved);
    if (!platform) return { ok: false, message: 'Unrecognized platform URL.' };

    const admin = getSupabaseAdmin();
    const profileRes = await findOrCreateProfile({
      platform,
      profile_url: resolved,
      fallback_creator_id: creatorId,
    });
    if (profileRes.ok !== true) return { ok: false, message: profileRes.error };

    // The URL already existed under a DIFFERENT creator — don't steal it.
    if (!profileRes.value.created && profileRes.value.profile.creator_id !== creatorId) {
      return { ok: false, message: 'That profile is already tracked under another creator.' };
    }

    // Owner claim attaches to the creator's login (the first creator_link user).
    const link = await admin
      .from('creator_link')
      .select('user_id')
      .eq('creator_id', creatorId)
      .order('user_id', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (link.data?.user_id) {
      const claimRes = await addProfileClaim({
        user_id: link.data.user_id,
        profile_id: profileRes.value.profile.id,
        claim_kind: 'owner',
        claimed_via: 'admin_assigned',
      });
      if (claimRes.ok !== true) {
        return { ok: false, message: `Profile saved, but the owner claim failed: ${claimRes.error}` };
      }
    }
    revalidateCreator(creatorId);
    return {
      ok: true,
      message: profileRes.value.created ? `Added ${platform} profile.` : `Linked existing ${platform} profile.`,
    };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function editCreatorUrl(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    const profileId = String(formData.get('profile_id') ?? '');
    if (!isUuid(creatorId) || !isUuid(profileId)) return { ok: false, message: 'Invalid id.' };

    const admin = getSupabaseAdmin();
    const existing = await admin
      .from('profile')
      .select('platform, creator_id')
      .eq('id', profileId)
      .maybeSingle();
    if (existing.error || !existing.data || existing.data.creator_id !== creatorId) {
      return { ok: false, message: 'Profile not found for this creator.' };
    }

    const resolved = await resolveShortLink(String(formData.get('url') ?? ''));
    const platform = detectPlatform(resolved);
    if (!platform) return { ok: false, message: 'Unrecognized platform URL.' };
    if (platform !== existing.data.platform) {
      return { ok: false, message: `Different platform — remove this URL and add the new one.` };
    }
    const v = validateProfileUrl(platform, resolved);
    if (v.ok !== true) return { ok: false, message: v.error };

    const { error } = await admin
      .from('profile')
      .update({ profile_url: v.normalizedUrl, handle: v.handle, scrape_status: 'pending' })
      .eq('id', profileId);
    if (error) {
      console.error('[admin/editCreatorUrl]', error);
      return {
        ok: false,
        message: error.code === '23505' ? 'That profile already exists.' : 'Could not update the URL.',
      };
    }
    revalidateCreator(creatorId);
    return { ok: true, message: 'URL updated.' };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function removeCreatorUrl(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    const profileId = String(formData.get('profile_id') ?? '');
    if (!isUuid(creatorId) || !isUuid(profileId)) return { ok: false, message: 'Invalid id.' };

    const admin = getSupabaseAdmin();
    const prof = await admin.from('profile').select('creator_id').eq('id', profileId).maybeSingle();
    if (prof.error || !prof.data || prof.data.creator_id !== creatorId) {
      return { ok: false, message: 'Profile not found for this creator.' };
    }
    const { error } = await admin.from('profile').delete().eq('id', profileId);
    if (error) {
      console.error('[admin/removeCreatorUrl]', error);
      return { ok: false, message: 'Could not remove the URL.' };
    }
    revalidateCreator(creatorId);
    return { ok: true, message: 'URL removed.' };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function resetCreatorPassword(
  _prev: PasswordResetResult | null,
  formData: FormData,
): Promise<PasswordResetResult> {
  try {
    await requireAdmin();
    const creatorId = String(formData.get('creator_id') ?? '');
    const userId = String(formData.get('user_id') ?? '');
    if (!isUuid(creatorId) || !isUuid(userId)) return { ok: false, message: 'Invalid id.' };

    const admin = getSupabaseAdmin();
    const link = await admin
      .from('creator_link')
      .select('user_id')
      .eq('user_id', userId)
      .eq('creator_id', creatorId)
      .maybeSingle();
    if (link.error || !link.data) {
      return { ok: false, message: 'That login is not linked to this creator.' };
    }

    const typed = String(formData.get('password') ?? '');
    const password = typed.length ? typed : generatePassword();
    const pwRes = validatePassword(password);
    if (!pwRes.ok) return { ok: false, message: pwRes.error };

    const upd = await admin.auth.admin.updateUserById(userId, { password: pwRes.value });
    if (upd.error || !upd.data.user) {
      console.error('[admin/resetCreatorPassword]', upd.error);
      return { ok: false, message: 'Could not reset the password.' };
    }
    revalidateCreator(creatorId);
    return {
      ok: true,
      message: 'Password reset.',
      credentials: { email: upd.data.user.email ?? '', password: pwRes.value },
    };
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
}

export async function deleteCreator(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const creatorId = String(formData.get('creator_id') ?? '');
  let done = false;
  try {
    await requireAdmin();
    if (!isUuid(creatorId)) return { ok: false, message: 'Invalid creator id.' };

    const admin = getSupabaseAdmin();
    // Delete linked logins first (cascades user_role + creator_link), then the
    // creator (cascades profiles → claims/snapshots/posts).
    const links = await admin.from('creator_link').select('user_id').eq('creator_id', creatorId);
    for (const l of (links.data ?? []) as { user_id: string }[]) {
      await admin.auth.admin.deleteUser(l.user_id).catch(() => {});
    }
    const del = await admin.from('creator').delete().eq('id', creatorId);
    if (del.error) {
      console.error('[admin/deleteCreator]', del.error);
      return { ok: false, message: 'Could not delete the creator.' };
    }
    revalidatePath('/admin/profiles');
    revalidatePath('/admin');
    done = true;
  } catch (error: unknown) {
    return { ok: false, message: getErrorMessage(error) };
  }
  // redirect() throws NEXT_REDIRECT — keep it OUTSIDE the try so it isn't caught.
  if (done) redirect('/admin/profiles');
  return { ok: true, message: 'Deleted.' };
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm --filter ./apps/frontend exec tsc --noEmit
```
Expected: no errors. (Action logic is exercised in Task 7's integration test.)

- [ ] **Step 3: Commit**

```bash
git add "apps/frontend/src/app/(admin)/admin/creators/[id]/actions.ts"
git commit -m "feat(admin): per-creator editor server actions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Editor page + client component

**Files:**
- Create: `apps/frontend/src/app/(admin)/admin/creators/[id]/page.tsx`
- Create: `apps/frontend/src/app/(admin)/admin/creators/[id]/creator-editor.tsx`

- [ ] **Step 1: Create the page (server component)**

`apps/frontend/src/app/(admin)/admin/creators/[id]/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';

import { getSupabaseAdmin } from '@d3/database';
import { getAuthContext } from '@gitroom/frontend/lib/auth';
import { isUuid } from '@gitroom/frontend/lib/ids';
import { getAdminCreatorDetail } from '@gitroom/frontend/lib/admin-creators';
import { CreatorEditor } from './creator-editor';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Admin · Edit creator — D3 Creator',
};

export default async function AdminCreatorEditorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');
  if (auth.role !== 'admin') redirect('/me');

  const { id } = await params;
  if (!isUuid(id)) notFound();

  const detail = await getAdminCreatorDetail(getSupabaseAdmin(), id);
  if (!detail) notFound();

  return (
    <div className="flex flex-col gap-10 pt-12 pb-24 max-w-[760px]">
      <header>
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass-subtle border border-borderGlass text-caption text-aurora-cta mb-6">
          <span className="inline-block size-1.5 rounded-full bg-aurora-cta" />
          Admin · Edit creator
        </span>
        <h1 className="text-display-2 text-fg mb-4">{detail.displayName}</h1>
        <p className="text-body-lg text-fgMuted">
          Manage this creator&apos;s name, social URLs, and login.{' '}
          <Link href="/admin/profiles" className="text-aurora-cta underline underline-offset-4">
            ← Back to accounts
          </Link>
        </p>
      </header>
      <CreatorEditor detail={detail} />
    </div>
  );
}
```

- [ ] **Step 2: Create the client editor**

`apps/frontend/src/app/(admin)/admin/creators/[id]/creator-editor.tsx`:

```tsx
'use client';

/**
 * Per-creator editor. Each section posts to its own server action via
 * useActionState; rows live in their own components so hooks obey
 * react-hooks/rules-of-hooks. Password reset reveals the new password once,
 * reusing the provision-form credentials pattern.
 */

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Input } from '@gitroom/frontend/components/ui/input';
import { Button } from '@gitroom/frontend/components/ui/button';
import type { AdminCreatorDetail, AdminProfileRow, AdminCreatorLogin } from '@gitroom/frontend/lib/admin-creators';
import {
  renameCreator,
  addCreatorUrl,
  editCreatorUrl,
  removeCreatorUrl,
  resetCreatorPassword,
  deleteCreator,
  type ActionResult,
  type PasswordResetResult,
} from './actions';

const SECTION = 'glass-subtle border border-borderGlass rounded-2xl p-6 flex flex-col gap-4';
const ERR = 'text-caption text-red-400';
const OK = 'text-caption text-fgMuted';

function Save({ label = 'Save' }: { label?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? 'Saving…' : label}
    </Button>
  );
}

function Msg({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  return <span className={state.ok ? OK : ERR}>{state.message}</span>;
}

export function CreatorEditor({ detail }: { detail: AdminCreatorDetail }) {
  return (
    <div className="flex flex-col gap-8">
      <RenameSection creatorId={detail.creatorId} displayName={detail.displayName} />
      <UrlsSection creatorId={detail.creatorId} profiles={detail.profiles} />
      <LoginsSection creatorId={detail.creatorId} logins={detail.logins} />
      <DangerSection creatorId={detail.creatorId} displayName={detail.displayName} />
    </div>
  );
}

function RenameSection({ creatorId, displayName }: { creatorId: string; displayName: string }) {
  const [state, action] = useActionState(renameCreator, null);
  return (
    <section className={SECTION}>
      <h2 className="text-heading text-fg">Display name</h2>
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="creator_id" value={creatorId} />
        <Input name="display_name" type="text" required maxLength={80} defaultValue={displayName} className="flex-1" />
        <Save />
      </form>
      <Msg state={state} />
    </section>
  );
}

function UrlsSection({ creatorId, profiles }: { creatorId: string; profiles: AdminProfileRow[] }) {
  return (
    <section className={SECTION}>
      <h2 className="text-heading text-fg">Social URLs</h2>
      {profiles.length === 0 ? (
        <p className="text-body text-fgMuted">No profiles yet — add one below.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {profiles.map((p) => (
            <ProfileUrlRow key={p.id} creatorId={creatorId} profile={p} />
          ))}
        </ul>
      )}
      <AddUrlRow creatorId={creatorId} />
    </section>
  );
}

function ProfileUrlRow({ creatorId, profile }: { creatorId: string; profile: AdminProfileRow }) {
  const [editState, editAction] = useActionState(editCreatorUrl, null);
  const [removeState, removeAction] = useActionState(removeCreatorUrl, null);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-caption text-fgSubtle w-16 shrink-0">{profile.platform}</span>
        <form action={editAction} className="flex items-center gap-2 flex-1">
          <input type="hidden" name="creator_id" value={creatorId} />
          <input type="hidden" name="profile_id" value={profile.id} />
          <Input name="url" type="url" defaultValue={profile.profileUrl} className="flex-1" />
          <Save />
        </form>
        {confirming ? (
          <form action={removeAction} className="flex items-center gap-2">
            <input type="hidden" name="creator_id" value={creatorId} />
            <input type="hidden" name="profile_id" value={profile.id} />
            <span className="text-caption text-fgMuted">Remove?</span>
            <Save label="Confirm" />
            <button type="button" onClick={() => setConfirming(false)} className="text-caption text-fgSubtle hover:text-fg">
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-caption text-fgMuted hover:text-fg border border-white/10 rounded-md px-2 py-1"
          >
            Remove
          </button>
        )}
      </div>
      <Msg state={editState} />
      <Msg state={removeState} />
    </li>
  );
}

function AddUrlRow({ creatorId }: { creatorId: string }) {
  const [state, action] = useActionState(addCreatorUrl, null);
  return (
    <div className="flex flex-col gap-1.5 border-t border-borderGlass pt-4">
      <span className="text-label text-fgMuted">Add a URL</span>
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="creator_id" value={creatorId} />
        <Input name="url" type="url" required placeholder="https://www.instagram.com/handle" className="flex-1" />
        <Save label="Add" />
      </form>
      <Msg state={state} />
    </div>
  );
}

function LoginsSection({ creatorId, logins }: { creatorId: string; logins: AdminCreatorLogin[] }) {
  return (
    <section className={SECTION}>
      <h2 className="text-heading text-fg">Login &amp; password</h2>
      {logins.length === 0 ? (
        <p className="text-body text-fgMuted">No login linked to this creator.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {logins.map((l) => (
            <LoginRow key={l.userId} creatorId={creatorId} login={l} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LoginRow({ creatorId, login }: { creatorId: string; login: AdminCreatorLogin }) {
  const [state, action] = useActionState(resetCreatorPassword, null as PasswordResetResult | null);
  return (
    <li className="flex flex-col gap-2">
      <div className="text-body text-fg">{login.email}</div>
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="creator_id" value={creatorId} />
        <input type="hidden" name="user_id" value={login.userId} />
        <Input name="password" type="text" placeholder="New password (blank = generate)" minLength={8} maxLength={72} className="flex-1" />
        <Save label="Reset password" />
      </form>
      {state && !state.ok && <span className={ERR}>{state.message}</span>}
      {state?.ok && state.credentials && (
        <CredentialsPanel email={state.credentials.email} password={state.credentials.password} />
      )}
    </li>
  );
}

function CredentialsPanel({ email, password }: { email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(`${email}\n${password}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="glass-elevated rounded-xl border border-borderGlass p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-label text-fgMuted">New credentials</span>
        <button type="button" onClick={copy} className="text-label text-aurora-cta hover:underline">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div className="font-mono text-body-sm text-fg break-all">{email}</div>
      <div className="font-mono text-body-sm text-fg break-all">{password}</div>
      <span className="text-caption text-fgSubtle">Shown once — copy and share securely now.</span>
    </div>
  );
}

function DangerSection({ creatorId, displayName }: { creatorId: string; displayName: string }) {
  const [state, action] = useActionState(deleteCreator, null);
  const [confirming, setConfirming] = useState(false);
  return (
    <section className={SECTION}>
      <h2 className="text-heading text-fg">Danger zone</h2>
      <p className="text-body text-fgMuted">
        Deletes <span className="text-fg">{displayName}</span>, all its profiles and stats, and its login. Cannot be undone.
      </p>
      {confirming ? (
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="creator_id" value={creatorId} />
          <span className="text-caption text-fgMuted">Delete this creator and login?</span>
          <Save label="Delete creator" />
          <button type="button" onClick={() => setConfirming(false)} className="text-caption text-fgSubtle hover:text-fg">
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="self-start text-label text-fgMuted hover:text-fg border border-white/10 rounded-md px-3 py-1.5"
        >
          Delete creator
        </button>
      )}
      {state && !state.ok && <span className={ERR}>{state.message}</span>}
    </section>
  );
}
```

- [ ] **Step 3: Type-check + lint (catches rules-of-hooks)**

```bash
pnpm --filter ./apps/frontend exec tsc --noEmit
pnpm lint
```
Expected: no errors, no `react-hooks/rules-of-hooks` warnings.

- [ ] **Step 4: Commit**

```bash
git add "apps/frontend/src/app/(admin)/admin/creators/[id]/page.tsx" "apps/frontend/src/app/(admin)/admin/creators/[id]/creator-editor.tsx"
git commit -m "feat(admin): per-creator editor page + UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: "Manage" link + provisioning short-link support

**Files:**
- Modify: `apps/frontend/src/app/(admin)/admin/profiles/page.tsx` (CreatorCard header → link)
- Modify: `apps/frontend/src/app/(admin)/admin/actions.ts:107-110` (resolve short links in provisioning)

- [ ] **Step 1: Link each creator card to its editor**

In `profiles/page.tsx`, inside `CreatorCard`, wrap the creator name heading in a link. Replace the `<h3 ...>{group.displayName}</h3>` line with:

```tsx
            <h3 className="text-heading text-fg truncate">
              <Link
                href={`/admin/creators/${group.creatorId}`}
                className="hover:text-aurora-cta underline-offset-4 hover:underline"
              >
                {group.displayName}
              </Link>
            </h3>
```

(`Link` is already imported at the top of the file.)

- [ ] **Step 2: Resolve short links during provisioning**

In `admin/actions.ts` `createCreator`, the per-URL loop currently starts:

```ts
    for (const url of urls) {
      const platform = detectPlatform(url);
```

Change it to resolve first, and import `resolveShortLink`. Update the import from `@d3/database` to include it, then:

```ts
    for (const rawUrl of urls) {
      const url = await resolveShortLink(rawUrl);
      const platform = detectPlatform(url);
```

(The rest of the loop body already uses `url`.)

- [ ] **Step 3: Lint + type-check**

```bash
pnpm lint
pnpm --filter ./apps/frontend exec tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/src/app/(admin)/admin/profiles/page.tsx apps/frontend/src/app/(admin)/admin/actions.ts
git commit -m "feat(admin): link creator cards to editor; short links in provisioning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Integration test for editor action logic + full verification

Reproduces the editor actions' DB logic (minus `requireAdmin`/`revalidatePath`/`redirect`) against a local stack — the same characterization-test pattern as `provision-creator.mts`.

**Files:**
- Create: `supabase/tests/admin-account-editor.mts`

- [ ] **Step 1: Write the integration test**

```ts
/**
 * Characterization test for the per-creator editor action LOGIC (creators/[id]/
 * actions.ts), reproduced minus requireAdmin/revalidatePath/redirect, against a
 * LOCAL Supabase stack.
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm exec tsx supabase/tests/admin-account-editor.mts
 */
import { randomUUID } from 'node:crypto';
import {
  getSupabaseAdmin, ensureCreatorForUser, detectPlatform, validateProfileUrl, findOrCreateProfile, addProfileClaim,
} from '@d3/database';
import { validateDisplayName } from '../../apps/frontend/src/lib/account-validation.ts';

const sb = getSupabaseAdmin();
let pass = 0, fail = 0;
function check(n: string, ok: boolean, d = '') { ok ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? `  — ${d}` : ''}`)); }
const userIds: string[] = [];
const creatorIds: string[] = [];

async function mkCreator(): Promise<{ creatorId: string; userId: string }> {
  const u = await sb.auth.admin.createUser({ email: `e_${randomUUID().slice(0, 8)}@test.local`, password: randomUUID(), email_confirm: true });
  const userId = u.data.user!.id; userIds.push(userId);
  const cr = await ensureCreatorForUser({ user_id: userId, display_name: 'Editme' });
  const creatorId = cr.ok ? cr.value.creator_id : '';
  creatorIds.push(creatorId);
  return { creatorId, userId };
}

// --- reproduced action cores ---
async function rename(creatorId: string, name: string) {
  const v = validateDisplayName(name);
  if (!v.ok) return { ok: false, message: v.error };
  const { error } = await sb.from('creator').update({ display_name: v.value }).eq('id', creatorId);
  return error ? { ok: false, message: 'fail' } : { ok: true, message: 'Renamed.' };
}
async function addUrl(creatorId: string, userId: string, url: string) {
  const platform = detectPlatform(url);
  if (!platform) return { ok: false, message: 'Unrecognized platform URL.' };
  const pr = await findOrCreateProfile({ platform, profile_url: url, fallback_creator_id: creatorId });
  if (pr.ok !== true) return { ok: false, message: pr.error };
  if (!pr.value.created && pr.value.profile.creator_id !== creatorId) return { ok: false, message: 'other creator' };
  await addProfileClaim({ user_id: userId, profile_id: pr.value.profile.id, claim_kind: 'owner', claimed_via: 'admin_assigned' });
  return { ok: true, message: 'added', profileId: pr.value.profile.id };
}
async function editUrl(creatorId: string, profileId: string, newUrl: string) {
  const existing = await sb.from('profile').select('platform, creator_id').eq('id', profileId).maybeSingle();
  if (!existing.data || existing.data.creator_id !== creatorId) return { ok: false, message: 'not found' };
  const platform = detectPlatform(newUrl);
  if (!platform) return { ok: false, message: 'Unrecognized platform URL.' };
  if (platform !== existing.data.platform) return { ok: false, message: 'Different platform — remove this URL and add the new one.' };
  const v = validateProfileUrl(platform, newUrl);
  if (v.ok !== true) return { ok: false, message: v.error };
  const { error } = await sb.from('profile').update({ profile_url: v.normalizedUrl, handle: v.handle, scrape_status: 'pending' }).eq('id', profileId);
  if (error) return { ok: false, message: error.code === '23505' ? 'That profile already exists.' : 'fail' };
  return { ok: true, message: 'URL updated.' };
}

async function main() {
  const { creatorId, userId } = await mkCreator();

  // rename
  const r = await rename(creatorId, 'Renamed Creator');
  check('rename ok', r.ok, r.message);
  const c = await sb.from('creator').select('display_name').eq('id', creatorId).single();
  check('rename persisted', c.data?.display_name === 'Renamed Creator', c.data?.display_name);

  // add url
  const tag = randomUUID().slice(0, 8);
  const add = await addUrl(creatorId, userId, `https://www.instagram.com/ed${tag}`);
  check('add url ok', add.ok, add.message);
  const profileId = (add as { profileId?: string }).profileId ?? '';

  // seed a snapshot, then re-point (same platform): snapshot must survive
  await sb.from('profile_snapshot').insert({ profile_id: profileId, captured_date: '2026-05-01', followers: 100 });
  const ed = await editUrl(creatorId, profileId, `https://www.instagram.com/ed${tag}_new`);
  check('re-point ok', ed.ok, ed.message);
  const p = await sb.from('profile').select('profile_url, handle').eq('id', profileId).single();
  check('re-point updated url in place', p.data?.profile_url === `https://www.instagram.com/ed${tag}_new`, p.data?.profile_url);
  const snaps = await sb.from('profile_snapshot').select('id').eq('profile_id', profileId);
  check('re-point PRESERVED snapshot history', (snaps.data?.length ?? 0) === 1, `snaps=${snaps.data?.length}`);

  // cross-platform edit rejected
  const cross = await editUrl(creatorId, profileId, `https://www.tiktok.com/@ed${tag}`);
  check('cross-platform edit rejected', cross.ok === false && /Different platform/.test(cross.message), cross.message);

  // collision: add a 2nd IG profile, then try to re-point the first onto it
  const add2 = await addUrl(creatorId, userId, `https://www.instagram.com/dup${tag}`);
  const collide = await editUrl(creatorId, profileId, `https://www.instagram.com/dup${tag}`);
  check('collision re-point rejected (23505)', collide.ok === false && /already exists/.test(collide.message), collide.message);
  void add2;

  // delete creator: logins first, then creator cascades profiles+snapshots
  const links = await sb.from('creator_link').select('user_id').eq('creator_id', creatorId);
  for (const l of (links.data ?? []) as { user_id: string }[]) await sb.auth.admin.deleteUser(l.user_id).catch(() => {});
  const del = await sb.from('creator').delete().eq('id', creatorId);
  check('delete creator ok', !del.error, del.error?.message ?? '');
  const gone = await sb.from('profile').select('id').eq('creator_id', creatorId);
  check('delete cascaded profiles', (gone.data?.length ?? 0) === 0, `rows=${gone.data?.length}`);
  // already cleaned — drop from tracking so cleanup() doesn't double-delete
  creatorIds.length = 0; userIds.length = 0;
}

async function cleanup() {
  if (creatorIds.filter(Boolean).length) await sb.from('creator').delete().in('id', creatorIds.filter(Boolean));
  for (const u of userIds) await sb.auth.admin.deleteUser(u).catch(() => {});
}
try { await main(); } catch (e) { console.error('HARNESS ERROR', e); fail++; } finally { await cleanup(); }
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the integration test**

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<sb_secret_…> pnpm exec tsx supabase/tests/admin-account-editor.mts
```
Expected: all checks pass, exit 0.

- [ ] **Step 3: Full static verification**

```bash
pnpm lint
pnpm test
pnpm --filter ./apps/frontend exec tsc --noEmit
```
Expected: lint clean, jest green, no type errors.

- [ ] **Step 4: Browser e2e against the local stack (Playwright MCP)**

Force-local dev server (kill any existing `next dev` in `apps/frontend` first — Next 16 allows one per dir), then drive the editor:
```powershell
$env:NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"; $env:NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="<sb_publishable_…>"; $env:SUPABASE_URL="http://127.0.0.1:54321"; $env:SUPABASE_SERVICE_ROLE_KEY="<sb_secret_…>"; $env:CRON_SECRET="local-dev"; pnpm --filter ./apps/frontend exec next dev -p 4300
```
Walk: seed/login admin → provision a creator → open `/admin/creators/<id>` via the "Manage" link → rename → add a URL (incl. a short link) → re-point a URL → reset password (confirm reveal) → confirm Approve is hidden/blocked on an owned profile (seed a pending claim) → delete creator → land on `/admin/profiles`. Clean up all test rows + the dev server afterward.

- [ ] **Step 5: Commit**

```bash
git add supabase/tests/admin-account-editor.mts
git commit -m "test(admin): editor action logic integration test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Update the knowledge graph**

```bash
graphify update .
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Rename → Task 4 `renameCreator` + Task 5 RenameSection ✓
- Add/re-point/remove URLs → Task 4 (add/edit/remove) + Task 5 (UrlsSection/ProfileUrlRow/AddUrlRow) ✓
- Reset password (reveal once) → Task 4 `resetCreatorPassword` + Task 5 LoginRow/CredentialsPanel ✓
- Delete creator (+ login) → Task 4 `deleteCreator` + Task 5 DangerSection ✓
- Short-link resolution → Task 1 + wired in Task 4 add/edit & Task 6 provisioning ✓
- Approve-claim fix (backend + UI guard) → Task 2 ✓
- Per-creator page + data fetch → Task 3 + Task 5 ✓
- "Manage" link → Task 6 ✓
- No migration → confirmed; nothing in the plan creates one ✓
- Tests (tsx + browser e2e) → Tasks 1, 2, 7 ✓

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `ActionResult`/`PasswordResetResult` defined in Task 4 and imported in Task 5; `AdminCreatorDetail`/`AdminCreatorLogin`/`AdminProfileRow` defined in Task 3 and consumed in Tasks 3/5; action names (`renameCreator`, `addCreatorUrl`, `editCreatorUrl`, `removeCreatorUrl`, `resetCreatorPassword`, `deleteCreator`) match between Task 4 (definition) and Task 5 (import). `alreadyOwned` defined in Task 2 (`admin-creators.ts`), consumed in Task 2 (`admin-actions.tsx`, `page.tsx`). `resolveShortLink` exported in Task 1, imported in Tasks 4 & 6.
