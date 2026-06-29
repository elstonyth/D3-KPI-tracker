import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getAuthContext } from '@gitroom/frontend/lib/auth';
import { getSupabaseRoute } from '@gitroom/frontend/lib/supabase-route';
import { resolveCreatorProfiles } from '@gitroom/frontend/lib/creator-metrics';
import { SignOutButton } from '@gitroom/frontend/components/auth/signout-button';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Account — D3 Creator',
};

export default async function AccountPage() {
  const auth = await getAuthContext();
  if (!auth) redirect('/login');
  if (auth.role === 'admin') redirect('/admin');

  // Current display name lives on the linked creator row (may not exist yet for
  // a brand-new creator — that's fine, the field starts blank and saving
  // provisions it). Same client also resolves how many profiles this user
  // tracks — via the shared resolver so the count matches /me + /me/leaderboard.
  const sb = await getSupabaseRoute();
  let displayName = '';
  const creatorId = auth.creatorLink?.creator_id ?? null;
  if (creatorId) {
    const { data } = await sb
      .from('creator')
      .select('display_name')
      .eq('id', creatorId)
      .maybeSingle();
    displayName = data?.display_name ?? '';
  }
  const { profiles } = await resolveCreatorProfiles(sb, {
    userId: auth.userId,
    creatorId,
  });
  const tracked = profiles.length;

  return (
    <div className="flex flex-col gap-10 pt-12 pb-24 max-w-[640px]">
      <header>
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass-subtle border border-borderGlass text-caption text-fgMuted mb-6">
          <span className="inline-block size-1.5 rounded-full bg-aurora-cta" />
          Account
        </span>
        <h1 className="text-display-2 text-fg mb-4">Your account.</h1>
        <p className="text-body-lg text-fgMuted">
          Manage how your creator appears and your sign-in.
        </p>
      </header>

      {/* Profile */}
      <section className="glass-subtle border border-borderGlass rounded-2xl p-6 flex flex-col gap-4">
        <div>
          <h2 className="text-heading text-fg">Profile</h2>
          <p className="text-body text-fgMuted mt-1">
            The name shown for your creator across D3.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="text-body text-fg">
            {displayName || 'Not set yet'}
          </div>
          <span className="text-caption text-fgSubtle">
            Managed by your agency — contact them to change it.
          </span>
        </div>
      </section>

      {/* Identity */}
      <section className="glass-subtle border border-borderGlass rounded-2xl p-6 flex flex-col gap-3">
        <h2 className="text-heading text-fg">Identity</h2>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-caption text-fgSubtle">Signed in as</div>
            <div className="text-body text-fg truncate">{auth.email}</div>
          </div>
          <SignOutButton />
        </div>
      </section>

      {/* Tracked profiles summary — read-only, agency-managed */}
      <section className="glass-subtle border border-borderGlass rounded-2xl p-6 flex flex-col gap-1">
        <h2 className="text-heading text-fg">Tracked profiles</h2>
        <p className="text-body text-fgMuted">
          {tracked === 0
            ? 'No accounts yet — your agency adds them for you.'
            : `${tracked} account${tracked === 1 ? '' : 's'} managed by your agency.`}
        </p>
      </section>
    </div>
  );
}
