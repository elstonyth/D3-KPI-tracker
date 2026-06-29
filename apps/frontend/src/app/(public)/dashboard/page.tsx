import { Metadata } from 'next';
import { DashboardShowcase } from '@gitroom/frontend/components/dashboard-showcase/dashboard-showcase';
import {
  getLiveCreatorRows,
  type LiveCreatorRow,
} from '@gitroom/frontend/lib/queries';
import { getDashboardViewTotalsWindowed } from '@gitroom/frontend/lib/metrics-windowed';

// ISR: 1h cache, see (public)/page.tsx for rationale.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Dashboard — D3 Creator',
  description:
    'Live overview of every creator we grow at D3 — combined views and followers across Instagram, TikTok, Facebook, and Douyin.',
  alternates: { canonical: '/dashboard' },
};

export default async function DashboardPage() {
  const [creators, windowed] = await Promise.all([
    getLiveCreatorRows().catch((e) => {
      console.error('[dashboard] creators', e);
      return null as LiveCreatorRow[] | null;
    }),
    // Windowed view totals power the period pills across the hero, platform
    // breakdown, and Top Creators ranking. Resolves to empty maps on error
    // (logged inside the helper) so those sections fall back to cumulative.
    getDashboardViewTotalsWindowed().catch((e) => {
      console.error('[dashboard] viewsByWindow', e);
      return undefined;
    }),
  ]);

  const isLive = !!(creators && creators.length > 0);

  return (
    <div className="flex flex-col gap-10 pt-12 pb-24">
      <header className="max-w-[760px]">
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass-subtle border border-borderGlass text-caption text-fgMuted mb-6">
          <span className="inline-block size-1.5 rounded-full bg-white/[0.78]" />
          Dashboard
        </span>
        <h1 className="text-display-2 text-fg mb-4">
          Every creator. Every platform.
        </h1>
        <p className="text-body-lg text-fgMuted max-w-[600px]">
          A live roll-up of every account we manage. Filter by platform; numbers
          refresh as our scraper collects them.
        </p>
        {isLive && (
          <p className="mt-4 text-caption text-fgSubtle">
            Tracking {creators!.length} creator
            {creators!.length === 1 ? '' : 's'} · combined followers and views
            across every platform.
          </p>
        )}
      </header>

      <DashboardShowcase
        creators={creators}
        viewsByWindow={windowed?.byPlatform}
        creatorViewsByWindow={windowed?.byCreator}
      />
    </div>
  );
}
