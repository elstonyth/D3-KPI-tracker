import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAuthContext } from '@gitroom/frontend/lib/auth';
import { getSupabaseRoute } from '@gitroom/frontend/lib/supabase-route';
import { resolveCreatorProfiles } from '@gitroom/frontend/lib/creator-metrics';
import {
  getTopContentWindowed,
  type TopContentRow,
} from '@gitroom/frontend/lib/metrics-windowed';
import { EmptyState } from '@gitroom/frontend/components/ui/empty-state';
import { PLATFORM_ICONS, type PlatformKey } from '@gitroom/frontend/components/ui/platform-icons';
import { ImageWithFallback } from '@gitroom/frontend/components/ui/image-with-fallback';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'My leaderboard — D3 Creator',
};

export default async function CreatorMeLeaderboardPage() {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');
  if (auth.role === 'admin') redirect('/admin');
  // No onboarding gate — creators see their top posts straight away.

  // Cookie-aware client — same defense-in-depth reasoning as /me/page.tsx.
  // The data tables have "public read for anon + authenticated" RLS for the
  // showcase, so this client sees the same rows an anon visitor would, and
  // the profile filter narrows to this user's own posts at the query level.
  // If the filter ever broke, the leak is bounded by what's already public
  // via /leaderboard.
  const sb = await getSupabaseRoute();

  // Which profiles count as "this user's"? Source of truth is profile_claim
  // (owner + tracker), shared with /me — NOT profile.creator_id. A tracked
  // profile belonging to another creator still surfaces this user's view of
  // its top posts.
  const { profiles } = await resolveCreatorProfiles(sb, {
    userId: auth.userId,
    creatorId: auth.creatorLink?.creator_id ?? null,
  });
  const ids = profiles.map((p) => p.id);

  // Top posts across those profiles, by views. Uses the shared windowed RPC —
  // the same source as the public leaderboard and the /me dashboard's Top
  // content — so each post appears once (deduped to its latest snapshot) rather
  // than once per daily snapshot, which the old raw post_snapshot query did.
  // 'lifetime' ranks by absolute views (with no baseline, views_gained ==
  // current_views, so the order is highest-viewed first).
  let posts: TopContentRow[] = [];
  if (ids.length) {
    posts = await getTopContentWindowed('lifetime', {
      client: sb,
      profileIds: ids,
      limit: 20,
    });
  }

  return (
    <div className="flex flex-col gap-10 pt-12 pb-24">
      <header className="max-w-[760px]">
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass-subtle border border-borderGlass text-caption text-fgMuted mb-6">
          <span className="inline-block size-1.5 rounded-full bg-aurora-cta" />
          My leaderboard
        </span>
        <h1 className="text-display-2 text-fg mb-4">Your top posts.</h1>
        <p className="text-body-lg text-fgMuted max-w-[600px]">
          The 20 highest-viewed posts across your platforms.
        </p>
      </header>

      {posts.length === 0 ? (
        <EmptyState
          icon={
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 21V9M10 21V4M16 21v-7M22 21H2" />
            </svg>
          }
          title="No posts to rank yet"
          description={
            ids.length === 0
              ? 'Your agency manages your accounts. Your top posts will appear here once they are connected.'
              : 'Your top posts appear here once the first daily scrape collects them — usually within 24 hours.'
          }
        />
      ) : (
        <ol className="space-y-2">
          {posts.map((p, i) => {
            const thumb = p.thumbnailUrl;
            const isWinner = i === 0;
            return (
              <li
                key={`${p.profileId}:${p.externalPostId}`}
                className="glass-elevated rounded-xl p-4 flex items-center gap-4"
              >
                <span
                  className={`text-section w-10 text-right tabular-nums ${
                    isWinner ? 'text-aurora-cta font-semibold' : 'text-fgSubtle'
                  }`}
                >
                  {i + 1}
                </span>
                <div className="relative size-14 rounded-md overflow-hidden bg-customColor1 shrink-0">
                  <ImageWithFallback
                    src={thumb}
                    alt={p.captionExcerpt ?? 'Post thumbnail'}
                    loading="lazy"
                    className="absolute inset-0 size-full object-cover"
                    fallback={
                      <div className="absolute inset-0 flex items-center justify-center text-caption text-fgSubtle">
                        —
                      </div>
                    }
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-body text-fg truncate">
                    {p.captionExcerpt ?? '(no caption)'}
                  </p>
                  <p className="text-caption text-fgMuted">
                    {p.postedAt ? new Date(p.postedAt).toLocaleDateString() : '—'}
                  </p>
                  {p.alsoOn && p.alsoOn.length > 0 && (
                    <div className="mt-1 flex items-center gap-1 text-fgSubtle">
                      <span className="text-caption">also on</span>
                      {p.alsoOn.map((plat) => {
                        const AlsoIcon =
                          PLATFORM_ICONS[(plat === 'rednote' ? 'xiaohongshu' : plat) as PlatformKey];
                        return AlsoIcon ? <AlsoIcon key={plat} size={12} /> : null;
                      })}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-5 shrink-0 text-right tabular-nums">
                  <PostStat label="views" value={p.currentViews} strong />
                  <PostStat label="likes" value={p.likes} />
                  <PostStat label="comments" value={p.comments} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function PostStat({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: number | null;
  strong?: boolean;
}) {
  return (
    <div className={label === 'views' ? '' : 'hidden sm:block'}>
      <div className={`text-body tabular-nums ${strong ? 'text-fg' : 'text-fgMuted'}`}>
        {value != null ? Intl.NumberFormat().format(value) : '—'}
      </div>
      <div className="text-caption text-fgSubtle">{label}</div>
    </div>
  );
}
