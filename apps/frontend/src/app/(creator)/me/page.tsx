import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import { getAuthContext } from '@gitroom/frontend/lib/auth';
import { getSupabaseRoute } from '@gitroom/frontend/lib/supabase-route';
import {
  getCreatorMetricsWindowed,
  getTopContentWindowed,
} from '@gitroom/frontend/lib/metrics-windowed';
import {
  parseWindowParam,
  WINDOW_LABEL,
} from '@gitroom/frontend/lib/me-window';
import { EmptyState } from '@gitroom/frontend/components/ui/empty-state';
import { ViewLeaderboard } from '@gitroom/frontend/components/leaderboard-showcase/view-leaderboard';
import { getCreatorPlatformBreakdown } from '@gitroom/frontend/lib/creator-platform-breakdown';
import { PlatformCards } from '@gitroom/frontend/components/insights/platform-cards';
import {
  PLATFORM_ICONS,
  PLATFORM_LABELS,
  type PlatformKey,
} from '@gitroom/frontend/components/ui/platform-icons';

import { WindowTabs } from './window-tabs';
import { CreatorStats } from './creator-stats';

const SUPPORTED_PLATFORMS: PlatformKey[] = [
  'facebook',
  'instagram',
  'tiktok',
  'douyin',
];

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'My dashboard — D3 Creator',
};

function NoAccountsState() {
  return (
    <EmptyState
      icon={
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
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
    const [rows, topContent, platformCards] = await Promise.all([
      getCreatorMetricsWindowed(metricWindow, {
        client: sb,
        creatorIds: [creatorId],
      }),
      getTopContentWindowed(metricWindow, {
        client: sb,
        creatorIds: [creatorId],
        limit: 12,
      }),
      getCreatorPlatformBreakdown(metricWindow, { client: sb, creatorId }),
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
        <PlatformCards cards={platformCards} />
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
