# Admin Account Editor — Design

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**Scope owner:** admin tooling (agency-side)

## Summary

Today the admin can *provision* a creator (`createCreator`) and, on `/admin/profiles`,
delete a profile or approve/reject a pending claim. There is no way to **edit an
existing creator**: rename it, fix/add/remove a social URL, or reset the creator's
login password. This spec adds a dedicated **per-creator editor** at
`/admin/creators/[id]`, folds in a fix for the opaque "Approve" failure on
already-owned profiles, and adds server-side short-link resolution so share links
(`vm.tiktok.com`, `v.douyin.com`, Instagram share links) are accepted.

The creator-facing side (`/me/account`) stays read-only and agency-managed — no change.

## Goals

- Admin can **rename** an existing creator.
- Admin can **add**, **re-point (edit)**, and **remove** social URLs on an existing creator.
- Admin can **reset** a creator's login password and see the new password once.
- Admin can **delete** a whole creator (and its login).
- The pending-claim **Approve** action no longer fails opaquely on an already-owned profile.
- Share/short links are resolved to canonical profile URLs before validation.

## Non-goals (YAGNI)

- Editing the login **email** (auth email change needs a confirmation flow — out of scope).
- Ownership-**transfer** UI — Approve stays "block + clear message"; reassignment is manual.
- Bulk operations across creators.
- Multi-login UX beyond listing each login and resetting its password.
- Any creator-side editing — `/me/account` remains read-only.

## Decisions (confirmed)

| Decision | Choice |
|---|---|
| Editor placement | New per-creator page `/admin/creators/[id]` |
| URL edit semantics | **Re-point in place** (same profile row, **history preserved**); block on collision |
| Cross-platform URL edit | **Not allowed** in-place — admin removes + adds instead |
| Approve on owned profile | **Block + clear message** (keep one-owner rule) |
| Delete creator | Also deletes the linked **auth login(s)** |
| Short-link resolution | In scope (server-side, allowlisted hosts) |
| DB migration | **None required** — all changes use existing tables/policies |

## Architecture

### Route & page
`apps/frontend/src/app/(admin)/admin/creators/[id]/page.tsx` — server component:
- `force-dynamic`, `revalidate = 0`.
- `getAuthContext()` → redirect `/login` if unauthenticated, `/me` if not admin
  (same gate as `profiles/page.tsx`).
- Validate `params.id` with `isUuid`; if invalid or no creator found → `notFound()`.
- Fetch detail via `getAdminCreatorDetail(admin, id)` and render the client editor.

Each creator card on `/admin/profiles` gains a **"Manage"** link to
`/admin/creators/<creatorId>`.

### Data fetch — `lib/admin-creators.ts`
New `getAdminCreatorDetail(admin, creatorId)` returns:
```typescript
{
  creator: { id, displayName, avatarUrl },
  profiles: AdminProfileRow[],          // reuse existing shape (owner/tracker/pending counts)
  ownerByProfile: Record<profileId, userId | null>,
  logins: { userId: string; email: string }[],   // creator_link → auth.admin.getUserById
}
```
Logins: read `creator_link` rows for `creator_id`, then `admin.auth.admin.getUserById`
per `user_id` (auth schema isn't exposed through PostgREST). A creator normally has
exactly one login.

### Editor component — `creators/[id]/creator-editor.tsx` (client)
Mirrors `provision-form.tsx` conventions (dynamic URL rows, `useActionState`/transition,
inline ✓/✗ result lines, the once-only `CredentialsPanel` with copy). Sections:

1. **Display name** — `Input` + Save → `renameCreator`.
2. **Social URLs** — one row per existing profile: editable URL `Input` + Save (re-point)
   + Remove (inline confirm); plus an "Add URL" group with `+ Add URL`. Per-row result text.
3. **Login & password** — login email shown read-only; "Reset password" with a typed field
   *or* "Generate"; on success the new password renders once in `CredentialsPanel`.
4. **Danger zone** — "Delete creator" behind a strong confirm (two-step, matching the
   delete-profile pattern) → on success redirect to `/admin/profiles`.

### Server actions — `creators/[id]/actions.ts`
Shared contract (matches existing admin actions): `await requireAdmin()` →
`isUuid` validation on every id → service-role writes (`getSupabaseAdmin`) →
return `ActionResult` `{ ok, message }` (never throw) → `revalidatePath` for the
affected paths. Reuse existing validators (`validateDisplayName`, `validatePassword`,
`validateProfileUrl`, `detectPlatform`, `findOrCreateProfile`, `addProfileClaim`).

| Action | Behaviour |
|---|---|
| `renameCreator(creatorId, displayName)` | `validateDisplayName` → `update creator.display_name`. |
| `addCreatorUrl(creatorId, url)` | `resolveShortLink` → `detectPlatform` (→ "Unrecognized platform URL" if null) → `findOrCreateProfile({platform, profile_url, fallback_creator_id})` → `addProfileClaim({user_id: primary login, claim_kind:'owner', claimed_via:'admin_assigned'})`. If the creator has no login, the profile is still created under the creator and the claim is skipped (reported). |
| `editCreatorUrl(creatorId, profileId, newUrl)` | `resolveShortLink` → `validateProfileUrl` → require **same platform** as the existing profile (else "Different platform — remove this URL and add the new one"). Update `profile_url`, `handle`, `scrape_status='pending'` on the same row (**snapshots kept**). Catch `23505` (`profile_platform_url_unique`/`profile_platform_handle_unique`) → "That profile already exists." |
| `removeCreatorUrl(creatorId, profileId)` | Verify the profile belongs to `creatorId` → `delete profile` (cascades claims/snapshots/posts). Confirm-gated in UI. |
| `resetCreatorPassword(creatorId, userId, newPassword?)` | Verify `userId` is linked to `creatorId` via `creator_link` → if `newPassword` provided `validatePassword`, else generate a strong one → `auth.admin.updateUserById(userId, { password })` → return the password once in the result. Never persisted anywhere else. |
| `deleteCreator(creatorId)` | Delete linked auth login(s) via `auth.admin.deleteUser` (cascades `user_role` + `creator_link` via `creator_link.user_id → auth.users on delete cascade`), then `delete creator` (FK `profile.creator_id on delete cascade` removes profiles → claims/snapshots/posts). Note: `creator_link.creator_id` is `on delete set null`, and the AC-1 `forbid_creator_link_creator_change` trigger lets the **service-role** cascade through — so order is flexible, but deleting logins first removes the `creator_link` rows outright. Returns ok; client redirects to `/admin/profiles`. |

### Short-link resolution — `libraries/database/src/profile-url.ts`
New `resolveShortLink(url): Promise<string>`:
- If the host is **not** in `SHORTLINK_HOSTS`, return the URL unchanged (no network call).
- Otherwise fetch and follow redirects with **max 5 redirects** and a **3s timeout**;
  return the final URL.
- The resolved URL is then run through the normal `validateProfileUrl`, which only
  accepts known platform **profile** hosts — so a redirect to anything unexpected is
  rejected downstream (SSRF-safe: we only initiate against allowlisted short-link
  domains and only trust a final URL that validates as a real profile).
- On fetch failure/timeout: return the original URL (it will then be rejected by
  validation with the existing short-link message) — fail closed, never throw.

Wired into `addCreatorUrl`, `editCreatorUrl`, and `createCreator` (provisioning) — the
same single helper at the point just before `detectPlatform`/validation.

### Approve-claim fix — `profiles/actions.ts` + `admin-creators.ts` + `admin-actions.tsx`
- **Backend `approveClaim`**: before the update, look up an existing `owner` claim for
  the profile. If one exists for a different user → return
  `{ ok:false, message: "This profile already has an owner — reject this claim, or reassign ownership from the creator's editor." }`. Keep a `23505` catch as a backstop that
  returns the same message. Approve still succeeds normally on an unowned profile.
- **`getAdminCreatorsData`**: add `alreadyOwned: boolean` to `AdminPendingClaim`,
  computed from the already-loaded `claimsByProfile` (owner count > 0) — no extra query.
- **`ClaimActions`**: accept `alreadyOwned`; when true, hide/disable **Approve**, render
  the explanatory message, and keep **Reject** available.

## Security & access control

- Every action re-checks `requireAdmin()` (defense in depth even though the `(admin)`
  layout gates) and validates ids with `isUuid`.
- All writes use the service-role client (consistent with existing admin actions),
  which bypasses RLS; no RLS/policy changes are needed.
- Destructive actions (remove URL, delete creator, reset password) are confirm-gated in
  the UI. The new password is shown once and never stored anywhere.
- Short-link resolution only initiates requests to allowlisted short-link hosts, caps
  redirects, times out, and re-validates the final URL → no SSRF surface.

## Testing plan

- **Headless action test** (`supabase/tests/admin-account-editor.mts`, `tsx`, local stack)
  mirroring `provision-creator.mts`: provision → rename → add (incl. a short link that
  resolves) → re-point a URL (assert snapshots preserved, collision rejected,
  cross-platform rejected) → reset password → `approveClaim` blocked on an owned profile
  → delete creator (assert profiles/claims/snapshots and login all gone).
- **Browser e2e** against the local stack (same method as the prior session): walk the
  editor UI end-to-end and confirm the Approve guard renders.
- `pnpm lint` + `pnpm test` clean; `next build` type-checks (strictNullChecks is on for
  frontend).

## Files touched

- **New:** `app/(admin)/admin/creators/[id]/page.tsx`, `.../creator-editor.tsx`, `.../actions.ts`
- **New:** `supabase/tests/admin-account-editor.mts`
- **Edit:** `lib/admin-creators.ts` (`getAdminCreatorDetail`, `alreadyOwned`),
  `app/(admin)/admin/profiles/page.tsx` ("Manage" link),
  `app/(admin)/admin/profiles/admin-actions.tsx` (Approve guard),
  `app/(admin)/admin/profiles/actions.ts` (`approveClaim` message),
  `libraries/database/src/profile-url.ts` (`resolveShortLink`),
  `app/(admin)/admin/actions.ts` (provisioning uses `resolveShortLink`)
- **Migration:** none

## Open questions

None — all design decisions resolved.
