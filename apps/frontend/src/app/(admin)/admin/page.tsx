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
