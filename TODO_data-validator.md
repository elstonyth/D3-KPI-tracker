# TODO — Data Validator: Login + Registration Flow

> Audit of every input in the auth / login / "registration" surface of D3 Creator.
> Generated 2026-06-01. Source of truth — track each item by its stable ID.

---

## ⚠️ Scope reality (read first)

The request was "login + registration flow." The codebase does **not** have a self-service
registration flow:

- **No signup/register page exists** — signup was killed (commit `94113cb`, Phase 2).
- `(auth)/onboarding/page.tsx` is a **deprecated redirect** (no inputs) → forwards to `/me/account` or `/admin`.
- `(creator)/me/account/page.tsx` is **read-only** (Phase 3 lockdown) — display name is agency-managed text; the only interactive element is `SignOutButton`. **No validatable inputs.**
- There is **no `middleware.ts`** — route protection is layout-level `getAuthContext()` guards.

The genuine input surfaces in this area are therefore:

| # | Surface | File | Trust boundary |
|---|---------|------|----------------|
| A | **Login form** | `apps/frontend/src/components/auth/sign-in-form.tsx` | **Public / unauthenticated** (highest risk) |
| B | `redirectTo` query param | `(auth)/login/page.tsx`, `(auth)/auth/callback/route.ts` | Public — **already hardened** via `safeRedirect()` ✅ |
| C | `code` query param | `(auth)/auth/callback/route.ts` | Public — presence-checked; Supabase validates |
| D | **Admin creator-provisioning** (the "registration" equivalent) | `(admin)/admin/actions.ts` + `provision-form.tsx` | Admin-only — `email`, `password`, `display_name`, `url[]` |
| E | Profile-URL validation | `libraries/database/src/profile-url.ts` | Used by D — **already strong** ✅ (the model to follow) |

**Assumption made (proceeding without blocking):** "registration" = admin provisioning (D). If you also want password-reset or a future public signup covered, say so — neither exists today.

---

## Context

- **Stack:** Next.js App Router (React 19), Supabase Auth (`signInWithPassword`, `auth.admin.createUser`), Supabase Postgres, TypeScript, pnpm. No Zod in repo today — validation is hand-rolled discriminated-union helpers (`profile-url.ts`, `redirects.ts`, `provision-plan.ts`).
- **Entry points:** see table above. Login is a **direct browser→Supabase Auth call** (no intermediate Next route); provisioning is a **Next Server Action**.
- **Security posture already in place (do not regress):**
  - ✅ Open-redirect guard — `safeRedirect()`/`isSafeRedirect()` (`lib/redirects.ts`) blocks `//`, `/\`, absolute, `javascript:`.
  - ✅ Profile-URL validation — `validateProfileUrl()` rejects cross-platform mismatch, post/reel URLs, short-links, non-http(s); canonicalizes hosts.
  - ✅ DB allowlists — `CHECK` on `platform`, `role`, `scrape_status`, `claim_kind`, `claimed_via`.
  - ✅ RLS — admin-only write policies on `creator`/`profile`/etc.; `requireAdmin()` defense-in-depth in the action.
  - ✅ Server Actions get **built-in CSRF/origin protection** in App Router — no manual token needed.
- **Compliance/cost note:** per project memory, Facebook scraping costs ~20× TikHub per profile and there's a 5-profile/day cron cap. An unbounded URL list in provisioning is a **cost/DoS** vector, not just a correctness one — see `VAL-ITEM-D4`.

---

## Validation Plan (by layer)

- [ ] **VAL-PLAN-1 [Client]** — **Entry Points:** login form, provision form · **Rules:** enforce `maxLength` on every text input; trim+lowercase email before submit; keep HTML5 `required`/`type` as first-pass feedback only (never authoritative). · **Libraries:** native HTML attributes + the shared Input component.
- [ ] **VAL-PLAN-2 [Server]** — **Entry Points:** `admin/actions.ts createCreator` · **Rules:** authoritative format + length + allowlist checks for `email`, `password`, `display_name`; cap URL-array size; sanitize/normalize `display_name`; map raw provider/PG errors to safe messages. · **Libraries:** new pure helper `lib/account-validation.ts` (matches `profile-url.ts` style; unit-testable; no new deps).
- [ ] **VAL-PLAN-3 [Database]** — **Entry Points:** `public.creator` · **Rules:** add `CHECK (char_length(display_name) BETWEEN 1 AND 80)` as the final safety net (currently only `NOT NULL`). Email uniqueness/shape already enforced by Supabase `auth.users` (citext unique). · **Libraries:** Supabase migration.
- [ ] **VAL-PLAN-4 [Config — not code]** — **Entry Points:** Supabase Auth · **Rules:** confirm built-in **rate limiting** + **bot/attack protection (CAPTCHA)** are enabled on the auth endpoints, since login bypasses any app-layer route and brute-force defense is 100% Supabase's. Verify Sentry scrubbing drops `password` (see `sentry-scrub.ts`). · **Libraries:** Supabase dashboard + existing Sentry config.
- [ ] **VAL-PLAN-5 [Tests]** — Unit-test the new validators (valid/invalid/edge/attack); add a login-form input-cap test; assert the URL-count cap. Reuse the `*.test.ts` + existing `profile-url.test.ts` pattern.

---

## Validation Items

### A. Login form — `sign-in-form.tsx` (PUBLIC, highest priority)

- [ ] **VAL-ITEM-A1 [email]** — **Type:** RFC-pragmatic shape, `maxLength=254`. · **Sanitization:** `trim().toLowerCase()` before send (a leading space currently yields a confusing "invalid credentials"). · **Security:** length cap blocks oversized-payload abuse; Supabase is the authoritative validator. · **Error:** "Enter a valid email address."
- [ ] **VAL-ITEM-A2 [password]** — **Type:** non-empty, `maxLength=200` (client hint to bound payload; do **not** trim — spaces may be intentional). · **Security:** bounds request size; no min-length on *login* (only on creation). · **Error:** generic only.
- [ ] **VAL-ITEM-A3 [error surface]** — **Security:** currently renders raw `signInError.message` from Supabase. Collapse sign-in failures to a single generic **"Invalid email or password."** — avoids leaking provider internals and reduces account-enumeration signal. (All provisioned users are `email_confirm:true`, so "email not confirmed" shouldn't surface.)
- [ ] **VAL-ITEM-A4 [rate limiting]** — No app endpoint exists between browser and Supabase, so **brute-force protection is delegated entirely to Supabase Auth**. Verify rate limits + CAPTCHA/attack-protection are ON in the Supabase dashboard. (Config task — `VAL-PLAN-4`.)

### B. `redirectTo` query param — ALREADY VALIDATED ✅

- [ ] **VAL-ITEM-B1** — `safeRedirect()` already enforces same-origin absolute paths and blocks `//`, `/\`, `javascript:`, absolute URLs. **No change.** Action: confirm a unit test covers the backslash + protocol-relative cases (add to `lib/redirects.test.ts` if missing).

### C. `code` query param (auth callback) — LOW

- [ ] **VAL-ITEM-C1** — Presence is checked (`if (!code)` → `/login?error=missing_code`); Supabase validates the value in `exchangeCodeForSession`. **Optional hardening:** reject obviously malformed codes (empty after trim / absurd length) before the round-trip. Low priority.
- [ ] **VAL-ITEM-C2 [UX, not security]** — The callback sets `?error=…` on `/login`, but `login/page.tsx` reads only `redirectTo` and never renders `error`. Dead param — either render it (escaped, via React — safe) or drop it. Not a validation gap; noted for completeness.

### D. Admin provisioning — `admin/actions.ts` (the "registration" surface)

- [ ] **VAL-ITEM-D1 [email]** — **Type:** server-side shape check + `maxLength 254` (today only `if (!email)`; format is left entirely to Supabase). · **Sanitization:** `trim().toLowerCase()` (trim already done; add lowercase + format). · **Security:** fail-fast clear message instead of a raw Supabase createUser error. · **Error:** "Enter a valid email address."
- [ ] **VAL-ITEM-D2 [password]** — **Type:** `length >= 8` (exists) **+ reject > 72 bytes**. · **Security:** bcrypt (Supabase default) silently **truncates at 72 bytes** — rejecting longer prevents a "my full password isn't actually checked" surprise. · **Note:** password is intentionally echoed to screen + clipboard (provisioning hands it to the creator) — **accepted**, but it must never reach logs/Sentry (`VAL-PLAN-4`). · **Error:** "Password must be 8–72 bytes."
- [ ] **VAL-ITEM-D3 [display_name]** — **Type:** 1–80 chars after normalization (today only `if (!displayName)`). · **Sanitization:** NFC-normalize (homoglyph/combining safety); strip C0/C1 controls, zero-width, and **bidi-override chars** (RTL spoofing); collapse internal whitespace; trim. · **Security:** stored on `creator.display_name` + `user_metadata` and rendered across leaderboard/dashboards/`<title>`/OG. React escapes HTML, but normalization blocks impersonation + breaks non-React render contexts (CSV/OG/email) defensively. · **Error:** "Display name is required." / "Display name must be 80 characters or fewer."
- [ ] **VAL-ITEM-D4 [url[] — array size]** — **Type:** cap at **`MAX_PROVISION_URLS = 25`** per submit (today **unbounded**). · **Security/cost:** each URL → `findOrCreateProfile` → a tracked profile → daily scraper spend (Facebook ~20× cost). An unbounded list is a cost-amplification / DoS vector. · **Error:** "Too many URLs — provide at most 25."
- [ ] **VAL-ITEM-D5 [url[] — per URL]** — **Already strong** ✅ via `detectPlatform` → `findOrCreateProfile` → `validateProfileUrl` (rejects mismatch/post URLs/short-links/non-http(s); canonicalizes). **No change** beyond keeping this path.
- [ ] **VAL-ITEM-D6 [error surface]** — `catch` returns raw `error.message` to the admin UI (`getErrorMessage`). Admin-only ⇒ lower risk, but map known Supabase/PG errors (duplicate email, etc.) to friendly messages with a generic fallback so PG internals don't leak. Lower priority.

### E. Profile-URL validator — `profile-url.ts` — REFERENCE ✅

- [ ] **VAL-ITEM-E1** — No action. This is the template the new validators should imitate (discriminated-union result, `ensureScheme`, allowlist hosts, explicit reject reasons). Regexes are linear (no ReDoS); URLs are stored/handed to adapters, never fetched at validation time (no SSRF at this layer).

### Database

- [ ] **VAL-ITEM-DB1 [creator.display_name]** — Add `CHECK (char_length(display_name) BETWEEN 1 AND 80)`. Currently only `NOT NULL`. Final safety net mirroring `VAL-ITEM-D3`.
- [ ] **VAL-ITEM-DB2 [email]** — No action: uniqueness + basic shape enforced by Supabase `auth.users` (citext, unique). Documented as covered.

---

## Proposed Code Changes

> Diffs match current files exactly. New helper deliberately mirrors the
> existing `profile-url.ts` discriminated-union style — **no new dependency** (no Zod),
> per project "simplicity / match existing style" rules.

### 1. NEW FILE — `apps/frontend/src/lib/account-validation.ts`

```ts
/**
 * Pure, dependency-free validators for the auth/provisioning input surface.
 * Mirrors the discriminated-union style of profile-url.ts so callers branch on
 * `.ok` and unit tests stay trivial. Server-authoritative — the forms reuse the
 * exported constants only as client-side maxLength hints.
 */

export const EMAIL_MAX = 254; // RFC 5321 address length
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX_BYTES = 72; // bcrypt (Supabase default) truncates beyond this
export const DISPLAY_NAME_MAX = 80;
export const MAX_PROVISION_URLS = 25;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // pragmatic; Supabase is final authority

// Code-point ranges stripped from display names: control + invisible chars that
// enable impersonation/spoofing or corrupt non-React render contexts. Expressed
// as hex pairs (not a literal char class) so the SOURCE stays pure ASCII.
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],     // C0 controls (incl. NUL, tab, newline)
  [0x7f, 0x9f],     // DEL + C1 controls
  [0x200b, 0x200f], // zero-width space/joiner + LTR/RTL marks
  [0x202a, 0x202e], // bidi embeddings/overrides (RTL spoofing)
  [0x2060, 0x2060], // word joiner
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];

function stripUnsafeChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    const unsafe = UNSAFE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
    if (!unsafe) out += ch;
  }
  return out;
}

export function validateEmail(raw: string): Validated<string> {
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: false, error: 'Email is required.' };
  if (email.length > EMAIL_MAX) return { ok: false, error: 'Email is too long.' };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.' };
  return { ok: true, value: email };
}

export function validatePassword(raw: string): Validated<string> {
  // Do NOT trim — leading/trailing spaces can be intentional in a password.
  if (raw.length < PASSWORD_MIN) {
    return { ok: false, error: `Password must be at least ${PASSWORD_MIN} characters.` };
  }
  if (new TextEncoder().encode(raw).length > PASSWORD_MAX_BYTES) {
    // bcrypt silently truncates at 72 bytes; reject so the stored password is
    // exactly what the admin sees and types at login.
    return { ok: false, error: `Password must be ${PASSWORD_MAX_BYTES} bytes or fewer.` };
  }
  return { ok: true, value: raw };
}

export function validateDisplayName(raw: string): Validated<string> {
  const cleaned = stripUnsafeChars(raw.normalize('NFC')) // homoglyph + invisible safety
    .replace(/\s+/g, ' ') // collapse internal whitespace
    .trim();
  if (!cleaned) return { ok: false, error: 'Display name is required.' };
  if (cleaned.length > DISPLAY_NAME_MAX) {
    return { ok: false, error: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.` };
  }
  return { ok: true, value: cleaned };
}
```

### 2. `apps/frontend/src/app/(admin)/admin/actions.ts` — wire in validators + URL cap

```diff
@@
 import { getAuthContext } from '@gitroom/frontend/lib/auth';
 import { normalizeProvisionUrls } from '@gitroom/frontend/lib/provision-plan';
+import {
+  validateEmail,
+  validatePassword,
+  validateDisplayName,
+  MAX_PROVISION_URLS,
+} from '@gitroom/frontend/lib/account-validation';
@@
-    const email = String(formData.get('email') ?? '').trim();
-    const password = String(formData.get('password') ?? '');
-    const displayName = String(formData.get('display_name') ?? '').trim();
-    const rawUrls = formData.getAll('url').map((v) => String(v));
-
-    if (!email) return { ok: false, message: 'Email is required.' };
-    if (password.length < 8) return { ok: false, message: 'Password must be at least 8 characters.' };
-    if (!displayName) return { ok: false, message: 'Display name is required.' };
+    const emailRes = validateEmail(String(formData.get('email') ?? ''));
+    if (!emailRes.ok) return { ok: false, message: emailRes.error };
+    const email = emailRes.value;
+
+    const passwordRes = validatePassword(String(formData.get('password') ?? ''));
+    if (!passwordRes.ok) return { ok: false, message: passwordRes.error };
+    const password = passwordRes.value;
+
+    const nameRes = validateDisplayName(String(formData.get('display_name') ?? ''));
+    if (!nameRes.ok) return { ok: false, message: nameRes.error };
+    const displayName = nameRes.value;
+
+    const rawUrls = formData.getAll('url').map((v) => String(v));
@@
-    const urls = normalizeProvisionUrls(rawUrls);
+    const urls = normalizeProvisionUrls(rawUrls);
+    if (urls.length > MAX_PROVISION_URLS) {
+      return { ok: false, message: `Too many URLs — provide at most ${MAX_PROVISION_URLS}.` };
+    }
```

### 3. `apps/frontend/src/components/auth/sign-in-form.tsx` — caps, normalize, generic error

```diff
@@
     const supabase = getSupabaseBrowser();
-    const { error: signInError } = await supabase.auth.signInWithPassword({
-      email,
-      password,
-    });
-    if (signInError) {
-      setError(signInError.message);
-      setPending(false);
-      return;
-    }
+    const { error: signInError } = await supabase.auth.signInWithPassword({
+      email: email.trim().toLowerCase(),
+      password,
+    });
+    if (signInError) {
+      // Collapse provider errors to one generic message: no Supabase internals
+      // leaked, no account-enumeration signal.
+      setError('Invalid email or password.');
+      setPending(false);
+      return;
+    }
@@
           <Input
             type="email"
             required
+            maxLength={254}
             autoComplete="email"
             placeholder="you@agency.com"
             value={email}
             onChange={(e) => setEmail(e.target.value)}
             className="pl-9"
           />
@@
           <Input
             type="password"
             required
+            maxLength={200}
             autoComplete="current-password"
             value={password}
             onChange={(e) => setPassword(e.target.value)}
           />
```

### 4. `apps/frontend/src/app/(admin)/admin/provision-form.tsx` — client maxLength hints

```diff
-          <Input name="display_name" type="text" required placeholder="Creator name" />
+          <Input name="display_name" type="text" required maxLength={80} placeholder="Creator name" />
@@
-          <Input name="email" type="email" required placeholder="creator@example.com" />
+          <Input name="email" type="email" required maxLength={254} placeholder="creator@example.com" />
@@
-          <Input name="password" type="password" required minLength={8} placeholder="At least 8 characters" />
+          <Input name="password" type="password" required minLength={8} maxLength={72} placeholder="8 to 72 characters" />
```

### 5. NEW MIGRATION — `supabase/migrations/20260601000000_creator_display_name_length.sql`

```sql
-- Final-safety-net length bound on creator.display_name (was NOT NULL only).
-- Mirrors validateDisplayName() (1-80 chars). Production table: confirm no
-- existing row exceeds 80 before applying (see command below); clean/widen first if so.
alter table public.creator
  add constraint creator_display_name_len
  check (char_length(display_name) between 1 and 80);
```

### 6. NEW TEST — `apps/frontend/src/lib/account-validation.test.ts` (sketch)

```ts
import { describe, it, expect } from 'vitest';
import {
  validateEmail,
  validatePassword,
  validateDisplayName,
  PASSWORD_MAX_BYTES,
} from './account-validation';

describe('validateEmail', () => {
  it('lowercases + trims', () => expect(validateEmail('  A@B.Co ')).toEqual({ ok: true, value: 'a@b.co' }));
  it('rejects missing @', () => expect(validateEmail('nope').ok).toBe(false));
  it('rejects > 254 chars', () => expect(validateEmail('a'.repeat(250) + '@b.co').ok).toBe(false));
});

describe('validatePassword', () => {
  it('rejects < 8', () => expect(validatePassword('short').ok).toBe(false));
  it('rejects > 72 bytes', () => expect(validatePassword('x'.repeat(PASSWORD_MAX_BYTES + 1)).ok).toBe(false));
  it('keeps internal/edge spaces', () => expect(validatePassword(' pass word ')).toEqual({ ok: true, value: ' pass word ' }));
});

describe('validateDisplayName', () => {
  const RLO = String.fromCharCode(0x202e); // right-to-left override (bidi spoof)
  const ZWSP = String.fromCharCode(0x200b); // zero-width space
  it('strips bidi-override + zero-width', () =>
    expect(validateDisplayName(`a${RLO}${ZWSP}b`)).toEqual({ ok: true, value: 'ab' }));
  it('collapses whitespace', () => expect(validateDisplayName('  a   b  ')).toEqual({ ok: true, value: 'a b' }));
  it('rejects > 80', () => expect(validateDisplayName('n'.repeat(81)).ok).toBe(false));
  it('rejects whitespace-only', () => expect(validateDisplayName('   ').ok).toBe(false));
});
```

---

## Commands

```bash
# Lint (root only, per project rule)
pnpm lint

# Run the new/affected unit tests
pnpm test

# Pre-migration safety check (production table) — must return 0 rows
#   select id, char_length(display_name) from public.creator where char_length(display_name) > 80;
# Apply the migration via Supabase CLI:
supabase db push        # or: supabase migration up
```

---

## Standards Checklist

- [ ] Validation at client (maxLength/required), **server (authoritative)**, and DB (`CHECK`) for `display_name`; email/password authoritative at server + Supabase.
- [ ] Server validation cannot be bypassed — `createCreator` re-validates regardless of client (`requireAdmin` + new validators).
- [ ] Every string input has an enforced length limit (email 254, password 72 bytes, display_name 80); URL array capped at 25.
- [ ] Enums via allowlist — already true (`platform`, `role`, `claim_kind`, `claimed_via` `CHECK`s).
- [ ] No SQL injection — Supabase client is parameterized; zero string concatenation.
- [ ] XSS — React auto-escapes; `display_name` additionally normalized (controls/bidi/zero-width stripped) before storage.
- [ ] Open-redirect — covered by `safeRedirect()` ✅.
- [ ] Error responses leak no internals — login collapsed to generic; provisioning maps known errors (D6).
- [ ] Secrets never logged — verify Sentry scrubs `password` (`sentry-scrub.ts`).
- [ ] Rate limiting — delegated to Supabase Auth; confirm enabled (VAL-PLAN-4).
- [ ] Tests cover valid/invalid/edge/attack inputs for the new validators.
- [ ] No new dependency introduced; matches existing `profile-url.ts` style.

---

## Out of scope / explicitly NOT found (so nobody re-hunts)

- ❌ Self-service **registration/signup** — does not exist (killed Phase 2).
- ❌ **Password-reset / forgot-password** flow — no page or route exists.
- ❌ **Onboarding inputs** — `onboarding/page.tsx` is a pure redirect.
- ❌ **Account-edit inputs** — `me/account` is read-only (Phase 3).
- ❌ **`middleware.ts`** — none; guards are in layouts.

---
---

# PART 2 — Data Validator: Settings / profile forms

> Second scope, same file (PART 1 above = Login + Registration). Added 2026-06-01.
> New stable-ID namespace — surfaces **F–J + DB-S** — so nothing collides with PART 1's A–E.
> Track each item by its ID.

---

## ⚠️ Scope reality (read first)

"Settings / profile forms" maps to five real surfaces. Most user-facing *settings*
are read-only (Phase 3 lockdown); the live input surface is **admin profile
management** + the **manual-scrape API**.

| # | Surface | File | Trust boundary | Verdict |
|---|---------|------|----------------|---------|
| F | **Creator settings** | `(creator)/me/account/page.tsx` | Authenticated creator | **No validatable inputs** — display name is agency-managed text, only `SignOutButton` is interactive |
| G | **Admin claim/delete actions** | `(admin)/admin/profiles/actions.ts` | Admin-only Server Actions | ⚠️ `user_id`/`profile_id` **presence-checked only** (no UUID format); raw PG `error.message` returned |
| H | **Admin search** | `admin/profiles/admin-search.tsx` + `page.tsx` | Admin — `?q=` / `?platform=` query params | Low — in-memory `.includes()` filter (no SQLi); `q` unbounded, `platform` not allowlisted |
| I | **Manual scrape trigger** | `api/scrape/[profileId]/route.ts` | **Authenticated creator or admin** | 🔴 `profileId` presence-only → non-UUID = **500 + PG leak**; **NO rate limit on a paid scrape** = cost-amplification / DoS |
| J | **Disabled profile routes** | `api/profiles/{route,claim,discover}` | Public POST | ✅ All return **410 Gone** — no body parsed, no inputs |
| — | **Create-creator form** | `admin/provision-form.tsx` + `admin/actions.ts` | Admin-only | Already audited in **PART 1 §D/§E** (`email`/`password`/`display_name`/`url[]`) — see there, not re-audited here |

**Severity order:** `I` (paid-scrape cost/DoS) ≫ `G` (uuid + error leak) > `H` (param hygiene) > `F`/`J` (no-op, documented).

---

## Context

- **Stack:** Next.js App Router (React 19), TypeScript, Supabase Postgres (RLS + `uuid` PKs + `CHECK` allowlists), Supabase Auth (cookie session, SameSite=Lax), `@upstash/ratelimit` + `@upstash/redis` (already a dep — used by `proxy-image`), pnpm. No Zod — validation is hand-rolled (matches `profile-url.ts`).
- **Entry points (this scope):** 3 admin Server Actions (`approveClaim`, `rejectClaim`, `deleteProfile`); 1 authenticated POST Route Handler (`/api/scrape/[profileId]`); 2 admin search query params (`q`, `platform`); 3 disabled (410) POST routes; 1 read-only settings page.
- **Schema facts that drive the rules** (`init_v1_core_tables.sql`, `profile_claim.sql`):
  - `profile.id`, `profile.creator_id`, `profile_claim.user_id`, `profile_claim.profile_id` are all **`uuid`**. Postgres rejects any non-UUID string with `invalid input syntax for type uuid: "<value>"` — that string is what currently leaks.
  - `profile.platform` / `scrape_status`, `profile_claim.claim_kind` / `claimed_via` already have `CHECK` allowlists. ✅
  - Writes are RLS-gated (`admin manages *`); the actions also use service-role + `requireAdmin()` (defense-in-depth). ✅
- **Security posture already in place (do not regress):**
  - ✅ Admin Server Actions get built-in CSRF/origin protection (App Router).
  - ✅ Delete is double-gated: inline confirm (client) + `requireAdmin()` (server) + `ON DELETE CASCADE` cleans dependents.
  - ✅ `deleteProfile` IDs are server-rendered (trusted source) — but the action is still a callable POST endpoint, so it must self-validate (defense-in-depth: "no validation on internal APIs" red flag).
- **Cost/abuse note (the reason `I` is 🔴):** per project memory, a scrape calls a **paid** upstream — **Facebook ≈ 20× TikHub cost** — and there's a 5-profile/day cron budget. `/api/scrape/[profileId]` lets an authenticated creator trigger a real scrape of their **own** profile with **no throttle**, so a loop (or a CSRF-driven page) is direct money/compute burn, not just noise. This is a temporal/rate business rule, not a syntax one.

---

## Validation Plan (by layer)

- [ ] **VAL-PLAN-S1 [Server — authoritative]** — **Entry Points:** `actions.ts` (G), `api/scrape/[profileId]` (I) · **Rules:** UUID-format every id from formData/route params **before** it reaches a `uuid` column; map raw Supabase/PG `error.message` to a generic message + server-side `console.error`; never return DB internals. · **Libraries:** new `lib/ids.ts` (`isUuid`).
- [ ] **VAL-PLAN-S2 [Server — rate/temporal]** — **Entry Points:** `api/scrape/[profileId]` (I) · **Rules:** per-user sliding-window cap on non-admin self-scrapes (admins exempt — they bulk-retry); **fail-open** so a limiter outage never blocks the endpoint. · **Libraries:** new `lib/rate-limit.ts` extracted from `proxy-image` (reuses existing `@upstash/*`).
- [ ] **VAL-PLAN-S3 [Client + Server — param hygiene]** — **Entry Points:** admin search (H) · **Rules:** cap `q` length (client `maxLength` + authoritative server `slice`); allowlist `platform` against the 5-platform set server-side (unknown → no filter). · **Libraries:** native attrs + a module-scope `Set`.
- [ ] **VAL-PLAN-S4 [Database — backstop, already adequate]** — `uuid` types + `CHECK` allowlists + RLS already form the final net for this scope. **No new migration required** (contrast PART 1, which added a `display_name` `CHECK`). Documented so nobody re-adds it.
- [ ] **VAL-PLAN-S5 [Tests]** — Unit-test `isUuid` (valid v4 / wrong-shape / injection-y / empty); assert each action rejects a non-UUID before any DB call; assert the scrape route 400s a bad `profileId` and 429s on the 6th rapid non-admin hit (limiter mockable / skip when Upstash unset).

---

## Validation Items

### F. Creator settings — `me/account/page.tsx` (READ-ONLY)

- [ ] **VAL-ITEM-F1** — **No action.** Page renders `display_name` (agency-managed) as text + `auth.email` + a tracked-count; the only control is `SignOutButton`. No form, no writable field. React escapes the rendered `display_name`/`email`. Documented so the "settings" surface isn't re-hunted. *(If a future "edit display name" lands here, reuse PART 1 `validateDisplayName` — NFC + control/bidi strip + 1–80.)*

### G. Admin profile actions — `admin/profiles/actions.ts`

- [ ] **VAL-ITEM-G1 [`approveClaim` — user_id, profile_id]** — **Type:** both must be `isUuid` (today only `if (!userId || !profileId)`). A non-UUID flows into `.eq('user_id', …).eq('profile_id', …)` → PG `invalid input syntax for type uuid` → leaked via `error.message`. · **Security:** pre-check turns a 500-ish leak into a clean "Invalid id." · **Error:** "Invalid user or profile id."
- [ ] **VAL-ITEM-G2 [`rejectClaim` — user_id, profile_id]** — Same as G1; this one **DELETEs** the claim, so a malformed id should be rejected before the mutation builder runs. · **Error:** "Invalid user or profile id."
- [ ] **VAL-ITEM-G3 [`deleteProfile` — profile_id]** — **Type:** `isUuid(profileId)` (today only `if (!profileId)`). **Destructive:** cascades `profile_claim` + `profile_snapshot` + `post_snapshot`. Validate id shape **and** keep the existing confirm-step + `requireAdmin()`. · **Error:** "Invalid profile id."
- [ ] **VAL-ITEM-G4 [error surface — all three]** — **Security:** each returns raw `error.message` from the Supabase write straight to the admin UI; map to a fixed friendly string + `console.error(label, error)` server-side. Admin-only ⇒ medium, not high, but it leaks PG/constraint internals (table names, uuid syntax). The `catch`→`getErrorMessage` mostly surfaces our own `requireAdmin()` "Not authorized." — acceptable; the **per-query** `error.message` is the leak to close.

### H. Admin search params — `admin-search.tsx` + `page.tsx`

- [ ] **VAL-ITEM-H1 [`q`]** — **Type:** cap length. Client `maxLength={80}` + `q.trim().slice(0, 80)` before `router.push`; **authoritative** `q.trim().slice(0, 80)` in `page.tsx`. · **Sanitization:** none needed for storage (never stored / never hits SQL — pure JS `.includes()` over already-fetched rows). Reflected into the form `defaultValue` and `URLSearchParams` (React-escaped / URL-encoded → no XSS / no injection). · **Why:** an unbounded query string is a (minor) abuse/log-bloat vector. · **Error:** silent clamp (no message — it's a filter).
- [ ] **VAL-ITEM-H2 [`platform`]** — **Type:** allowlist against `{instagram, tiktok, facebook, rednote, douyin}` (the `profile.platform` `CHECK` set) server-side; unknown → treat as no filter. · **Security:** today an arbitrary `platform` just yields zero matches (safe) but is echoed unbounded into `AdminSearchForm` + chip `URLSearchParams`. Allowlisting is defense-in-depth + kills URL bloat. · **Error:** silent (unknown platform ⇒ "All").

### I. Manual scrape trigger — `api/scrape/[profileId]/route.ts` 🔴 (highest)

- [ ] **VAL-ITEM-I1 [`profileId` — format]** — **Type:** replace `if (!profileId || typeof profileId !== 'string')` with `isUuid(profileId)` → **400** "invalid profile id". · **Security:** a non-UUID currently reaches `.eq('id', profileId).maybeSingle()` → PG `invalid input syntax for type uuid` → returned as **500** `load profile failed: <pg msg>`. Pre-check = correct status + no leak. · **Error:** "invalid profile id."
- [ ] **VAL-ITEM-I2 [rate limit — the real fix]** — **Rule:** before the profile load, throttle **non-admin** callers by `user.id` (sliding window, e.g. **5 / 1 min**); admins exempt (bulk retry). **Fail-open** if Upstash is unset/erroring. · **Security:** closes the authenticated **cost-amplification / DoS** — each call = one paid upstream scrape (FB ≈ 20× TikHub). · **Error:** **429** "Too many scrape requests — try again shortly." + `Retry-After`. · **Complementary (optional, no migration):** a per-profile cooldown using the existing `profile.last_scraped_at` (skip if scraped < ~10 min ago & status `ok`) — kills *wasteful* re-scrapes even within the rate budget, since data only refreshes daily.
- [ ] **VAL-ITEM-I3 [error surface — infra 500s]** — **Security:** `is_admin check failed: …`, `load profile failed: …`, `creator_link lookup failed: …` each interpolate raw `error.message`. Replace with `console.error(…)` + generic `'internal error'`. *(The step-6 scrape **envelope** `err.message` — "profile is private", etc. — is a meaningful caller-facing outcome, **not** a system internal; leave it.)*
- [ ] **VAL-ITEM-I4 [CSRF — note]** — A POST **Route Handler** does **not** get Server-Action CSRF protection. Mitigations: Supabase auth cookie is `SameSite=Lax` (blocks cross-site POST from carrying it) **and** the new per-user rate limit bounds blast radius. **Optional hardening:** reject when `Sec-Fetch-Site === 'cross-site'`. Low priority given Lax + I2.

### J. Disabled profile routes — `api/profiles/{route,claim,discover}`

- [ ] **VAL-ITEM-J1** — **No action.** All three `POST` handlers return **410 Gone** with a fixed JSON string and **never read the request body** — zero attack surface. Keep them closed (Phase 3). Listed so they aren't mistaken for live, unvalidated endpoints.

### DB-S. Database backstop (this scope)

- [ ] **VAL-ITEM-DB-S1** — **No new migration.** `uuid` column types reject malformed ids (the final net behind `isUuid`); `platform` / `scrape_status` / `claim_kind` / `claimed_via` `CHECK`s are the enum allowlists; RLS `admin manages *` gates writes; `ON DELETE CASCADE` keeps deletes consistent. The app-layer gaps above are about **surfacing** these failures cleanly, not a missing constraint.

---

## Proposed Code Changes

> No new dependency — `@upstash/ratelimit` / `@upstash/redis` already ship with
> `proxy-image`. New helpers mirror existing style (`profile-url.ts` discriminated
> simplicity). Diffs match current files exactly.

### 1. NEW FILE — `apps/frontend/src/lib/ids.ts`

```ts
/**
 * UUID-format guard for ids arriving from route params / FormData before they
 * hit a Postgres `uuid` column. Passing a non-UUID to `.eq('id', x)` on a uuid
 * column raises `invalid input syntax for type uuid`, which today surfaces as a
 * raw 500 / error.message. Pre-checking turns that into a clean 400 and stops
 * the DB internals from leaking. Shape-only (any hex layout) — bounds length and
 * blocks garbage; the column itself remains the authority on real existence.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
```

### 2. NEW FILE — `apps/frontend/src/lib/rate-limit.ts`

```ts
/**
 * Shared, FAIL-OPEN rate limiter. Extracted from proxy-image so paid/expensive
 * endpoints (e.g. /api/scrape) can throttle abuse with one call. Inert when
 * UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are unset (local dev). If the
 * limiter THROWS (bad token / Redis down) we fail OPEN — a limiter outage must
 * never take an endpoint down. (Also the fix proxy-image should adopt: today its
 * limiter is fail-closed, so a bad token 500s every request.)
 */
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// e.g. '10 s' | '1 m' | '24 h' — matches @upstash/ratelimit's Duration shape.
type Window = `${number} ${'ms' | 's' | 'm' | 'h' | 'd'}`;

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

// One limiter per (prefix) reused across warm invocations. Keep prefixes unique
// per config — tokens/window are baked into the first instance for a prefix.
const limiters = new Map<string, Ratelimit>();

function getLimiter(prefix: string, tokens: number, window: Window): Ratelimit | null {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }
  const cached = limiters.get(prefix);
  if (cached) return cached;
  const limiter = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(tokens, window),
    analytics: false,
    prefix,
  });
  limiters.set(prefix, limiter);
  return limiter;
}

export async function checkRateLimit(opts: {
  prefix: string;
  key: string;
  tokens: number;
  window: Window;
}): Promise<RateLimitResult> {
  const limiter = getLimiter(opts.prefix, opts.tokens, opts.window);
  if (!limiter) return { ok: true }; // not configured → no-op
  try {
    const { success, reset } = await limiter.limit(opts.key);
    if (success) return { ok: true };
    return { ok: false, retryAfter: Math.max(0, Math.ceil((reset - Date.now()) / 1000)) };
  } catch {
    return { ok: true }; // fail OPEN — never block on a limiter error
  }
}
```

### 3. `apps/frontend/src/app/api/scrape/[profileId]/route.ts` — uuid + rate limit + generic 500s

```diff
 import { getSupabaseRoute } from '../../../../lib/supabase-route';
+import { isUuid } from '../../../../lib/ids';
+import { checkRateLimit } from '../../../../lib/rate-limit';
@@
   const { profileId } = await ctx.params;
-  if (!profileId || typeof profileId !== 'string') {
-    return jsonError(400, 'profileId is required');
-  }
+  if (!isUuid(profileId)) {
+    return jsonError(400, 'invalid profile id');
+  }
@@
   const adminCheck = await route.rpc('is_admin');
   if (adminCheck.error) {
-    return jsonError(500, `is_admin check failed: ${adminCheck.error.message}`);
+    console.error('[scrape] is_admin check failed', adminCheck.error);
+    return jsonError(500, 'internal error');
   }
   const isAdmin = adminCheck.data === true;
+
+  // Cost guard: every scrape calls a paid upstream (Facebook ~20x TikHub). Cap
+  // non-admin self-scrapes; admins bulk-retry failed profiles so they're exempt.
+  // Fail-open if Upstash is unconfigured/erroring (see lib/rate-limit).
+  if (!isAdmin) {
+    const rl = await checkRateLimit({ prefix: 'scrape', key: user.id, tokens: 5, window: '1 m' });
+    if (!rl.ok) {
+      return NextResponse.json(
+        { ok: false, error: 'Too many scrape requests — try again shortly.' },
+        { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
+      );
+    }
+  }
@@
   if (profileRes.error) {
-    return jsonError(500, `load profile failed: ${profileRes.error.message}`);
+    console.error('[scrape] load profile failed', profileRes.error);
+    return jsonError(500, 'internal error');
   }
@@
     if (linkRes.error) {
-      return jsonError(500, `creator_link lookup failed: ${linkRes.error.message}`);
+      console.error('[scrape] creator_link lookup failed', linkRes.error);
+      return jsonError(500, 'internal error');
     }
```

### 4. `apps/frontend/src/app/(admin)/admin/profiles/actions.ts` — uuid checks + generic errors

```diff
 import { revalidatePath } from 'next/cache';
 import { getSupabaseAdmin } from '@d3/database';
 import { getAuthContext } from '@gitroom/frontend/lib/auth';
+import { isUuid } from '@gitroom/frontend/lib/ids';
@@ approveClaim
-    if (!userId || !profileId) return { ok: false, message: 'Missing user or profile.' };
+    if (!isUuid(userId) || !isUuid(profileId)) {
+      return { ok: false, message: 'Invalid user or profile id.' };
+    }
@@ approveClaim
-    if (error) return { ok: false, message: error.message };
+    if (error) {
+      console.error('[admin/approveClaim]', error);
+      return { ok: false, message: 'Could not approve the claim.' };
+    }
@@ rejectClaim
-    if (!userId || !profileId) return { ok: false, message: 'Missing user or profile.' };
+    if (!isUuid(userId) || !isUuid(profileId)) {
+      return { ok: false, message: 'Invalid user or profile id.' };
+    }
@@ rejectClaim
-    if (error) return { ok: false, message: error.message };
+    if (error) {
+      console.error('[admin/rejectClaim]', error);
+      return { ok: false, message: 'Could not reject the claim.' };
+    }
@@ deleteProfile
-    if (!profileId) return { ok: false, message: 'Missing profile.' };
+    if (!isUuid(profileId)) {
+      return { ok: false, message: 'Invalid profile id.' };
+    }
@@ deleteProfile
-    if (error) return { ok: false, message: error.message };
+    if (error) {
+      console.error('[admin/deleteProfile]', error);
+      return { ok: false, message: 'Could not delete the profile.' };
+    }
```

### 5. `apps/frontend/src/app/(admin)/admin/profiles/admin-search.tsx` — cap `q`

```diff
   function handleSubmit(e: React.FormEvent) {
     e.preventDefault();
     const params = new URLSearchParams();
-    if (q.trim()) params.set('q', q.trim());
+    const trimmed = q.trim().slice(0, 80);
+    if (trimmed) params.set('q', trimmed);
     if (platform) params.set('platform', platform);
@@
       <Input
         name="q"
         value={q}
         onChange={(e) => setQ(e.target.value)}
+        maxLength={80}
         placeholder="Search by creator name or handle…"
         className="max-w-[360px]"
       />
```

### 6. `apps/frontend/src/app/(admin)/admin/profiles/page.tsx` — authoritative cap + platform allowlist

```diff
+// Allowlist for the ?platform= filter — mirrors the profile.platform CHECK set.
+const FILTER_PLATFORMS = new Set(['instagram', 'tiktok', 'facebook', 'rednote', 'douyin']);
+
 export default async function AdminProfilesPage({
@@
-  const { q = '', platform = '' } = await searchParams;
-  const query = q.trim().toLowerCase();
+  const { q = '', platform: rawPlatform = '' } = await searchParams;
+  const query = q.trim().slice(0, 80).toLowerCase();
+  const platform = FILTER_PLATFORMS.has(rawPlatform) ? rawPlatform : '';
```

### 7. NEW TEST — `apps/frontend/src/lib/ids.test.ts` (sketch)

```ts
import { describe, it, expect } from 'vitest';
import { isUuid } from './ids';

describe('isUuid', () => {
  it('accepts a v4 uuid', () =>
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true));
  it('is case-insensitive', () =>
    expect(isUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true));
  it('rejects wrong shape', () => expect(isUuid('not-a-uuid')).toBe(false));
  it('rejects an injection-y string', () =>
    expect(isUuid("' or 1=1; drop table profile;--")).toBe(false));
  it('rejects empty + non-string', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});
```

---

## Commands

```bash
# Lint (root only, per project rule)
pnpm lint

# Unit tests (new isUuid + existing suites)
pnpm test

# Manual check — scrape route rejects a bad id with 400 (not 500), no PG leak:
#   curl -i -X POST http://localhost:3000/api/scrape/not-a-uuid   # expect 400 {"error":"invalid profile id"}
# Rate limit (needs UPSTASH_* set) — 6th rapid non-admin call returns 429 + Retry-After.
```

---

## Standards Checklist (this scope)

- [ ] Server-side validation cannot be bypassed — actions `requireAdmin()` + `isUuid`; scrape route auth + `isUuid` + rate limit re-checked regardless of client.
- [ ] Every id input UUID-format-checked before reaching a `uuid` column (G1–G3, I1); `q` length-capped (H1); `platform` allowlisted (H2).
- [ ] Enums via allowlist — `platform`/`scrape_status`/`claim_kind`/`claimed_via` `CHECK`s already enforce this. ✅
- [ ] No SQL injection — Supabase client is parameterized; `q`/`platform` filter is in-memory JS `.includes()`, never concatenated into SQL.
- [ ] XSS — React auto-escapes `q`/`display_name`/`email`/`profile_url`; no `dangerouslySetInnerHTML` on this surface.
- [ ] No string input unbounded — `q` ≤ 80; ids are fixed-shape; `platform` ∈ 5-set.
- [ ] Error responses leak no internals — per-query PG `error.message` replaced with generic text + server `console.error` (G4, I3); scrape-outcome envelope preserved intentionally.
- [ ] Rate limiting on the hot/expensive endpoint — per-user sliding window on `/api/scrape`, fail-open (I2). proxy-image can adopt the same helper to fix its fail-closed bug.
- [ ] File uploads — **N/A** (no upload on this surface; avatars are external scraper URLs, never user-uploaded).
- [ ] CSRF — Server Actions auto-protected; scrape Route Handler relies on SameSite=Lax + rate limit (I4).
- [ ] Destructive op guarded — `deleteProfile`: id-shape + confirm step + `requireAdmin()` + cascade.
- [ ] Tests cover valid/invalid/edge/injection ids; no new dependency added.

---

## Out of scope / explicitly NOT found (this scope)

- ❌ **Editable creator settings** — `me/account` is read-only (Phase 3); display name is agency-managed.
- ❌ **In-place profile/URL edit** — by design the admin does delete + re-add (URL is the canonical key); no edit-URL form exists (`page.tsx` header comment).
- ❌ **Creator-facing profile add/claim/discover** — all three API routes are **410 Gone**.
- ❌ **File uploads** — none anywhere on this surface.
- ➡️ **Create-creator form** (`email`/`password`/`display_name`/`url[]`) — audited in **PART 1 §D/§E**, not duplicated here.

---
---

# PART 3 — Data Validator: Access Control / Authorization (3-tier)

> Authorization audit (who-can-do-what), distinct from PART 1/2 (input validation).
> Focus: (1) every admin action behind a real admin check even via direct API,
> (2) a user cannot read/touch another user's data, (3) login is the only public input.
> Verified against code + RLS migrations 2026-06-01. Reference PART 2 for the scrape /
> proxy-image *input-validation* gaps — not duplicated here.

---

## The model (as actually implemented)

- **Admin = `user_role.role = 'admin'`.** DB helper `public.is_admin()` (SECURITY DEFINER, reads the caller's `user_role` row). App helper `getAuthContext().role`. Bootstrap: `admin_email` table → `handle_new_auth_user` trigger sets role at signup. Signup is killed, so admins are created by provisioning (or promoted with a manual `update user_role`).
- **Three Supabase clients** (the crux of every authz decision):
  - `getSupabaseRead()` — anon key, RLS-enforced. Public showcase reads.
  - `getSupabaseRoute()` — cookie/JWT, RLS-enforced **as the calling user**. `/me`, auth checks.
  - `getSupabaseAdmin()` (`@d3/database`, service_role) — **bypasses RLS entirely**. Cron, admin actions, scrape writes. Anywhere this is used, the *app-layer* check (`requireAdmin()` / `CRON_SECRET` / owner-check) is the **only** gate — RLS is not protecting it.
- **Page protection** = `(admin)/layout.tsx` (`role !== 'admin' → /me`) and `(creator)/layout.tsx` (`!auth → /login`). **There is no `middleware.ts`** — both layouts' "Middleware blocks…" comments are stale (see `AC-ADMIN-4`).
- **Mutation protection** = re-checked *inside each Server Action / Route Handler*, independent of the layout (correct — Server Actions are directly-invocable POST endpoints).

---

## Access-control matrix (the answer to the 3-tier ask)

| Resource / action | Public (anon) | User (creator) | Admin | Enforced by | Status |
|---|---|---|---|---|---|
| Login (`signInWithPassword`) | ✅ | ✅ | ✅ | Supabase Auth | ✅ |
| Public pages (home/leaderboard/creators) read | ✅ | ✅ | ✅ | `public read … using(true)` RLS | ✅ by design |
| Read **all** analytics (`creator/profile/*_snapshot`) | ✅ | ✅ | ✅ | same public-read RLS | ✅ public by design (1a) |
| Read own `user_role` / `creator_link` / `profile_claim` | ❌ | ✅ own only | ✅ all | RLS user-scoped (`auth.uid()=user_id`) | ✅ |
| `/me` dashboard | ❌→login | ✅ own creator | ✅→/admin | layout guard + app-scope by `creator_link.creator_id` | ✅ |
| **Update own `creator_link`** (acct details) | ❌ | 🔴 **allowed via direct API** (UI read-only) | ✅ | RLS `"user updates own creator_link"` | 🔴 `AC-USER-1` |
| **Insert/delete own `profile_claim`** | ❌ | 🔴 **allowed via direct API** (UI = 410) | ✅ | RLS `"user inserts/deletes own claims"` | 🔴 `AC-USER-2` |
| Create creator (provision) | ❌ | ❌ | ✅ | `requireAdmin()` | ✅ |
| Approve/reject claim, delete profile | ❌ | ❌ | ✅ | `requireAdmin()` + `isUuid()` | ✅ |
| Trigger scrape `/api/scrape/[id]` | ❌ 401 | ✅ own profile only | ✅ any | `getUser` + `is_admin` rpc + owner-match | ✅ (input gaps → PART 2 §I) |
| Cron / backfill / cron-health | ❌ | ❌ | operator only | `CRON_SECRET` + `timingSafeEqual` | ✅ |
| `/api/proxy-image?url=` | ✅ | ✅ | ✅ | host allowlist + https + image-only | ✅ (rate-limit fail-open → PART 2 §I2) |
| Disabled `/api/profiles/{route,claim,discover}` | 410 | 410 | 410 | returns 410 Gone | ✅ |
| Direct PostgREST **write** to core tables | ❌ | ❌ | ✅ | `"admin manages *"` + default-deny | ✅ |

🔴 = the only two authorization holes. Both are confined to the attacker's **own** `user_id` (no cross-user read/write) and the analytics data is public anyway — so neither is a cross-tenant breach. They matter because they violate the stated rules "**users cannot edit account details**" and "agency-managed / read-only", and they're reachable **exactly via the direct-API path you asked about**.

---

## DECISION-1 — public-read RLS vs "users see only their own data" (RESOLVED ✅ → 1a, 2026-06-01)

The five core tables carry `create policy "public read …" … for select to anon, authenticated using (true)`. This is **intentional** for the public showcase/leaderboard (home, `/creators`, `/leaderboard` render for anon). It **directly contradicts** requirement #2 read literally ("a user can access ONLY their own data").

Two coherent readings — pick one:

- [x] **DECISION-1a — Public showcase. ✅ CHOSEN by owner 2026-06-01** ("No privacy. Whatever admin adds shows on the dashboard and to the public."). Analytics are world-readable by design; "their own data" = identity rows only (`auth.users`, `user_role`, `creator_link`, `profile_claim`), already user-scoped by RLS. → **Keep** the public-read policies unchanged; the only authz work is closing `AC-USER-1/2` (those are *write* gaps, unaffected by the read decision).
- [ ] ~~**DECISION-1b — Confidential / white-label portal.**~~ **NOT CHOSEN.** (Would have meant claim/client-scoped SELECT policies + curated public views — no work to do.)

**Resolved:** owner confirmed **1a** on 2026-06-01 — analytics are intentionally public, so there is **no read-scoping work**. The remaining authz work is the two *write* gaps (`AC-USER-1/2`) only.

---

## Authz Items

### Focus 1 — every admin action behind a real admin check ✅ (with 2 clean-ups)

- [x] **AC-ADMIN-1 [server actions]** — `createCreator` (PART1 §D), `approveClaim`/`rejectClaim`/`deleteProfile` all call `requireAdmin()` as the **first** statement, independent of the layout. Direct invocation by action-id is therefore gated. ids are `isUuid()`-checked; errors are generic (`console.error` server-side). **Verified gated.**
- [x] **AC-ADMIN-2 [admin/cron API]** — `/api/admin/cron-health`, `/api/admin/backfill-media`, `/api/cron/daily-snapshot`, `/api/cron/archive-and-purge` all gate on `Bearer ${CRON_SECRET}` via `timingSafeEqual` (length-checked first). **Verified gated.** Note: these are **operator-secret** endpoints, not logged-in-admin endpoints — a logged-in admin *user* cannot reach them without the secret (stricter, fine). The `/api/admin/*` path naming is slightly misleading; consider documenting them as operator endpoints.
- [x] **AC-ADMIN-3 [scrape]** — `/api/scrape/[id]`: anon→401, then admin-bypass OR `creator_link.creator_id === profile.creator_id`→else 403. **Verified gated.** (UUID/rate-limit/500-leak are *input* issues already in PART 2 §I.)
- [ ] **AC-ADMIN-4 [stale "middleware" comments — fix]** — `(admin)/layout.tsx` and `(creator)/layout.tsx` claim "Middleware blocks non-admins / enforces auth", but **no `middleware.ts` exists**. The layout server-check is the real (and sufficient) gate. Correct the comments so a future dev doesn't delete the layout check believing middleware covers it. Optional hardening: add a real `middleware.ts` for belt-and-suspenders redirect before render. **Error/UX:** none (comment-only).
- [ ] **AC-ADMIN-5 [DRY the gate — low]** — `requireAdmin()` is duplicated verbatim in `admin/actions.ts` and `admin/profiles/actions.ts`. Because service-role writes bypass RLS, this app-check is the *sole* gate for those mutations — a future action that forgets it is wide open. Extract one shared `requireAdmin()` (e.g. `lib/auth.ts`) and use it everywhere to make "forgot the check" structurally harder.

### Focus 2 — a user cannot read or touch another user's data

- [ ] **AC-USER-1 [creator_link self-update] 🔴** — RLS `"user updates own creator_link" … using/with check (auth.uid()=user_id)` lets a logged-in creator `PATCH /rest/v1/creator_link` directly and change `creator_id` (repoint their binding at **any** creator), `dashboard_url`, `leaderboard_url`, `onboarding_completed` — despite `me/account` being read-only (Phase 3) and the rule "users cannot edit account details". **Scope:** own row only (cannot touch another user's row). **Impact:** integrity + lockdown bypass (repoint own `/me`, set misleading URLs). **Fix:** drop the policy — all legitimate writes go through service-role (provisioning). See migration below.
- [ ] **AC-USER-2 [profile_claim self-insert/delete] 🔴** — RLS `"user inserts own claims"` + `"user deletes own claims"` let a creator `POST/DELETE /rest/v1/profile_claim` directly, even though the claim feature is **410 Gone** at the app layer. They can self-insert `claim_kind='owner'` on an **unowned** profile (the `profile_claim_one_owner` unique index blocks stealing an already-owned one) or `tracker`/`pending` on any profile → surfaces that profile in their own `/me` views / inflates their tracked count. **Scope:** own `user_id` only. **Impact:** lockdown bypass + own-view manipulation. **Fix:** drop both policies (claims are admin/service-role-managed in Phase 3). See migration below.
- [x] **AC-USER-3 [identity reads scoped] ✅** — `user_role`, `creator_link`, `profile_claim` SELECT policies are `auth.uid() = user_id` (admins get `is_admin()` read-all). A user cannot read another user's role/link/claims. **Verified.**
- [x] **AC-USER-4 [/me app-scoping] ✅** — `/me` uses `getSupabaseRoute()` (not service-role), scopes aggregation to `creatorIds:[auth.creatorLink.creator_id]`, redirects admin→/admin and anon→/login. The cross-user separation of *which dashboard you see* is enforced (modulo `AC-USER-1`, which lets a user move their own pointer). **Verified.**
- [ ] **AC-USER-5 [confirm no cookie-client writes remain]** — Before applying the migration, confirm every legitimate `creator_link`/`profile_claim` write goes through service-role: provisioning (`ensureCreatorForUser`/`addProfileClaim` from admin actions), the `handle_new_auth_user` trigger (SECURITY DEFINER). The creator-facing write paths are 410 and `me/account` is read-only, so this should hold — verify, then the dropped policies remove nothing in use.

### Focus 3 — confirm the login form is the only public input

- [x] **AC-PUBLIC-1 [only public form] ✅** — Grep of `(public)/**` finds no `<form>`/`onSubmit`/`<input>`/`searchParams`-driven input. The login form is the only public **writeable form**. **Verified.**
- [ ] **AC-PUBLIC-2 [proxy-image is a 2nd public input]** — `/api/proxy-image?url=` is **anon-reachable** and takes a user-supplied URL. It is well-hardened: https-only, strict host **allowlist** (suffix `.endsWith` with a leading dot, so `evilcdninstagram.com` is rejected), `content-type` must be `image/*`, 8s timeout. SSRF-safe. Residual: the Upstash rate-limiter is **not** try/caught, so a misconfigured token throws → 500 on every image (the known fail-open/closed bug — PART 2 §I2 / memory). So: not the *only* public input, but the only *other* one and it's sound apart from the limiter.
- [ ] **AC-PUBLIC-3 [anon Supabase key = public read surface]** — The browser ships `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; under `DECISION-1a` anon can `select` **all** rows of the 5 public-read tables directly via PostgREST (not just through the app). That's intended for the showcase but is a "public input/data" surface to acknowledge. No writes are possible (no anon write policy + default-deny). Under `DECISION-1b` this becomes the primary thing to lock down.
- [x] **AC-PUBLIC-4 [disabled routes] ✅** — `/api/profiles/{route,claim,discover}` return 410 and process no input; reachable by anyone but harmless.

---

## Proposed Code Changes

> Audit only — nothing applied. Migration is **not** to be run here (DB changes handled separately). Per confirmed `DECISION-1a` (public showcase).

### 1. NEW MIGRATION — `supabase/migrations/20260601100000_lockdown_user_writes.sql`

```sql
-- Phase 3 = agency-managed, read-only to creators. All legitimate creator_link /
-- profile_claim writes go through the service-role admin client (which bypasses
-- RLS) or the SECURITY DEFINER signup trigger. The user-facing WRITE policies are
-- therefore unused AND let a creator mutate their own rows via direct PostgREST
-- (repoint creator_id; self-assign an owner claim on an unowned profile). Remove
-- them. Reads stay user-scoped; admins keep full control via "admin manages *".
--
-- PRE-FLIGHT (AC-USER-5): confirm no cookie-auth client still writes these tables
-- (creator add/claim/discover are 410; me/account is read-only) before applying.

drop policy if exists "user updates own creator_link" on public.creator_link;
drop policy if exists "user inserts own claims"       on public.profile_claim;
drop policy if exists "user deletes own claims"       on public.profile_claim;

-- Kept intentionally:
--   creator_link: "user reads own creator_link", "admin reads all creator_links"
--   profile_claim: "user reads own claims", "admin manages claims"
--   user_role:    "user reads own role", "admin reads all roles"
--   + service-role (RLS-exempt) for all provisioning/admin writes.
```

### 2. `(admin)/layout.tsx` + `(creator)/layout.tsx` — correct the stale "middleware" comments (`AC-ADMIN-4`)

```diff
- // Admin-only layout. Middleware blocks non-admins; this server-side check is a
- // defense-in-depth second gate.
+ // Admin-only layout. There is NO middleware.ts — THIS server-side check is the
+ // gate for admin *pages*. Admin *mutations* re-check requireAdmin() independently.
```

```diff
- // Creator-scoped layout. Middleware already enforces auth + onboarding gating;
- // we re-fetch here so child server components can rely on the auth context.
+ // Creator-scoped layout. There is NO middleware — THIS check enforces auth for
+ // /me/* pages; child server components re-read the cached auth context.
```

### 3. (Optional, `AC-ADMIN-5`) shared `requireAdmin()` in `lib/auth.ts`

```ts
// lib/auth.ts — single source of truth so no future action can forget the gate.
export async function requireAdmin(): Promise<AuthContext> {
  const auth = await getAuthContext();
  if (!auth || auth.role !== 'admin') throw new Error('Not authorized.');
  return auth;
}
```
…then delete the duplicated local `requireAdmin()` in both `admin/actions.ts` and `admin/profiles/actions.ts` and import this one.

---

## Commands — how to verify the authz (manual, against a logged-in creator JWT)

```bash
# 1. AC-USER-1 — a creator must NOT be able to PATCH their own creator_link via PostgREST.
#    BEFORE fix: 200 + row updated.  AFTER fix: 0 rows / policy denies.
curl -i -X PATCH "$SUPABASE_URL/rest/v1/creator_link?user_id=eq.$MY_UID" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $CREATOR_JWT" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"creator_id":"<some-other-creator-uuid>"}'

# 2. AC-USER-2 — a creator must NOT be able to self-insert a claim.
#    BEFORE fix: 201.  AFTER fix: 401/403 (RLS).
curl -i -X POST "$SUPABASE_URL/rest/v1/profile_claim" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $CREATOR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"'$MY_UID'","profile_id":"<unowned-profile-uuid>","claim_kind":"owner","claimed_via":"manual"}'

# 3. AC-ADMIN — admin mutation must reject a non-admin even via direct Server-Action POST
#    (exercise by signing in as a creator and replaying the /admin form POST → expect "Not authorized.").
# 4. Reads a creator MAY do (should still 200): own role/link/claims.
```

---

## Standards Checklist (authz scope)

- [ ] Every admin **mutation** re-checks `requireAdmin()`/secret independent of layout — ✅ verified (AC-ADMIN-1/2/3); make it structural via shared helper (AC-ADMIN-5).
- [ ] No layout-only protection on a state-changing path — ✅ (Server Actions + Route Handlers self-check).
- [ ] User cannot **read** another user's identity rows — ✅ user-scoped SELECT RLS (AC-USER-3).
- [ ] User cannot **write** any row (own or others') outside admin/service-role — 🔴 **fails today** for own `creator_link` (AC-USER-1) + own `profile_claim` (AC-USER-2); closed by migration #1.
- [x] User cannot read another user's *confidential* data — **N/A by design**: DECISION-1a confirmed; analytics are intentionally public.
- [ ] Public input surface enumerated & minimal — login form (only form) + `proxy-image` (hardened) + anon read key (AC-PUBLIC-1/2/3).
- [ ] Service-role usage audited — every `getSupabaseAdmin()` call site is admin/secret/owner-gated (✅).
- [ ] Errors leak no internals on authz failures — admin actions return generic text; scrape returns 401/403/404 (✅); scrape 500-on-bad-uuid is an *input* leak tracked in PART 2 §I.
- [ ] Default-deny verified — no `insert/update/delete` policy for `anon`; core-table writes admin-only.

---

## Out of scope / verified-clean (authz)

- ❌ **Cross-user data theft** — not possible: all user-scoped policies key on `auth.uid()=user_id`; the two gaps are self-row only.
- ❌ **Anonymous writes** — no anon write policy anywhere; default-deny holds.
- ❌ **Privilege escalation to admin** — `role` lives in `user_role`, which a user can only *read* (own); no self-update policy; admin set via `admin_email` trigger / manual SQL.
- ➡️ **Scrape / proxy-image input validation** (uuid, rate-limit, 500-leak, fail-open limiter) — covered in **PART 2 §I**, not duplicated here.
- ➡️ **Login / provisioning field validation** — **PART 1**.
