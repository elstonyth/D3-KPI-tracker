/**
 * @d3/database — public surface.
 *
 * Server-side data access. NEVER import from browser code (this pulls in
 * the service_role client).
 *
 * Public read paths for the frontend will get a separate publishable-key
 * client wired in apps/frontend (Task 5).
 */

export { getSupabaseAdmin } from './supabase-server';
export {
  detectPlatform,
  normalizeHandle,
  resolveShortLink,
  validateProfileUrl,
  type ProfileUrlValidation,
  type ProfileUrlValidationError,
} from './profile-url';
export { addProfile, type AddProfileInput } from './profile';
export {
  addProfileClaim,
  decideInitialClaimKind,
  ensureCreatorForUser,
  findCandidatesByHandle,
  findOrCreateProfile,
  type AddClaimInput,
  type EnsureCreatorResult,
  type FindOrCreateInput,
  type FindOrCreateResult,
} from './claim';
export {
  listScrapeableProfiles,
  upsertProfileSnapshot,
  upsertPostSnapshots,
  setProfileStatus,
  requeueFacebookForFreshPost,
  type ProfileSnapshotInput,
  type PostSnapshotInput,
} from './snapshots';
export {
  persistPostMedia,
  persistMediaForPosts,
  persistAvatarForProfile,
  backfillCreatorAvatars,
  POST_MEDIA_BUCKET,
  POST_MEDIA_DEADLINE_MS,
} from './media';
export type { AvatarBackfillResult } from './media';
export type {
  Platform,
  ScrapeStatus,
  ClientRow,
  CreatorRow,
  ProfileRow,
  ProfileSnapshotRow,
  PostSnapshotRow,
  ProfileClaimRow,
  ClaimKind,
  ClaimedVia,
  DiscoveryCandidate,
  Result,
} from './types';
