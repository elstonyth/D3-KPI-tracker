import { Metadata } from 'next';
import Link from 'next/link';
import { GlassCard } from '@gitroom/frontend/components/ui/glass-card';
import { AuroraButton } from '@gitroom/frontend/components/ui/aurora-button';
import { Reveal } from '@gitroom/frontend/components/ui/reveal';
import { ShinyText } from '@gitroom/frontend/components/ui/shiny-text';
import { DottedSurface } from '@gitroom/frontend/components/reactbits/dotted-surface';
import { D3LogoParticles } from '@gitroom/frontend/components/reactbits/d3-logo-particles';
import FadeContent from '@gitroom/frontend/components/FadeContent';
import {
  PLATFORM_ICONS,
  PLATFORM_LABELS,
  type PlatformKey,
} from '@gitroom/frontend/components/ui/platform-icons';
import {
  exactFormatter,
  formatShowcase,
  handleToSlug,
  demoCreatorRows,
} from '@gitroom/frontend/components/dashboard-showcase/showcase-data';
import { ShowcaseNumber } from '@gitroom/frontend/components/dashboard-showcase/showcase-number';
import { ImageWithFallback } from '@gitroom/frontend/components/ui/image-with-fallback';
import {
  getLiveCreatorRows,
  summarizeCreatorRows,
  platformBreakdownFromRows,
  type LivePlatformBreakdown,
} from '@gitroom/frontend/lib/queries';
import { SITE_NAME, SITE_URL } from '@gitroom/frontend/lib/site';

// Server Component fetches live counts on each request — disable static
// optimization so the hero never goes stale.
// ISR: regenerate from Supabase at most once per hour. Daily cron writes
// snapshots once/day; 1h cache means at worst data is ~1h stale, no DB hit
// on warm requests, fast TTFB. Background revalidation happens on first
// request after expiry (stale-while-revalidate).
export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'D3 Creator — We don’t sell dreams. We show numbers.',
  description:
    'D3 Creator is a live showcase of the creators, brands, and IPs we grow across every platform. Real traffic. Real engagement. Real growth.',
  alternates: { canonical: '/' },
};

// Organization schema for rich results / knowledge panel.
const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/d3-logo.png`,
};

const PLATFORM_ORDER: PlatformKey[] = [
  'facebook',
  'instagram',
  'tiktok',
  'douyin',
  // xiaohongshu (RedNote) archived — hidden from the platform strip.
];

/**
 * Public landing page: live hero, manifesto, top-creators preview, platform
 * coverage cards, and the stat strip. Fetches live creator rows on each request
 * (ISR, hourly) and falls back to synthetic demo rows on error or when empty.
 */
export default async function HomePage() {
  // One fetch → derive the summary, top creators, and platform breakdown. When
  // there is no live data yet, the synthetic demo rows flow through the SAME
  // helpers, so the page always shows combined totals (followers + views),
  // never 30-day deltas.
  const liveRows = await getLiveCreatorRows().catch((err) => {
    console.error('[home] getLiveCreatorRows failed', err);
    return null;
  });
  const isLive = !!(liveRows && liveRows.length > 0);
  const rows = isLive ? liveRows! : demoCreatorRows();

  const summary = summarizeCreatorRows(rows);
  // Top 5 by views — matches the views-first ranking on the dashboard and
  // leaderboard so the public showcase is consistent end to end.
  const topCreators = [...rows]
    .sort((a, b) => b.totalViews - a.totalViews)
    .slice(0, 5)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const combinedEngagement = rows.reduce((s, c) => s + c.totalEngagement, 0);

  // Per-platform cards: each platform that has a profile shows its combined
  // totals; platforms with none render "Not yet tracked".
  const liveByPlatform = new Map<PlatformKey, LivePlatformBreakdown>();
  for (const p of platformBreakdownFromRows(rows))
    liveByPlatform.set(p.platform, p);

  return (
    <div className="flex flex-col w-full">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(organizationJsonLd),
        }}
      />
      {/* ----- HERO ----- */}
      <DottedSurface className="w-screen ml-[calc(50%-50vw)] mr-[calc(50%-50vw)]">
        <section className="w-full pt-16 pb-24 sm:pt-24 sm:pb-32 lg:pt-32 lg:pb-40 max-w-[1100px] mx-auto px-6 md:px-8">
          <Reveal>
            <div className="grid grid-cols-1 lg:grid-cols-[5fr_6fr] gap-12 lg:gap-14 items-center">
              {/* Text column */}
              <div className="flex flex-col gap-5 text-center lg:text-left">
                <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full glass-subtle border border-borderGlass text-caption text-fgMuted self-center lg:self-start">
                  <span className="inline-block size-1.5 rounded-full bg-brand-500" />
                  Live showcase
                </span>
                <h1 className="text-[clamp(36px,4.5vw,64px)] leading-[1.04] tracking-[-0.03em] font-semibold text-fg max-w-[520px] mx-auto lg:mx-0 text-balance">
                  We don&rsquo;t sell dreams.{' '}
                  <span className="text-brand">We show numbers.</span>
                </h1>
                <p className="text-body text-fgMuted max-w-[480px] mx-auto lg:mx-0">
                  D3 Creator is a live showcase of the creators, brands, and IPs
                  we grow across every platform. Real traffic. Real engagement.
                  Real growth.
                </p>
                <div className="flex flex-col sm:flex-row items-center lg:items-start justify-center lg:justify-start gap-3 mt-2">
                  <Link href="/dashboard" className="contents">
                    <AuroraButton variant="cta" size="lg">
                      View Dashboard
                    </AuroraButton>
                  </Link>
                  <Link href="/leaderboard" className="contents">
                    <AuroraButton variant="ghost" size="lg">
                      View Leaderboard
                    </AuroraButton>
                  </Link>
                </div>
                <ShinyText className="text-caption text-fgSubtle mt-1">
                  Built by D3
                </ShinyText>
              </div>

              {/* Visual column — push logo to the outer right edge */}
              <div className="flex items-center justify-center lg:justify-end lg:-mr-6">
                <D3LogoParticles
                  size={460}
                  particleCount={22000}
                  className="cursor-crosshair max-w-full"
                />
              </div>
            </div>
          </Reveal>
        </section>
      </DottedSurface>

      {/* ----- MANIFESTO STRIP ----- */}
      <section
        aria-labelledby="manifesto-heading"
        className="w-full pb-20 sm:pb-24 max-w-[1100px] mx-auto text-center"
      >
        <FadeContent>
          <h2 id="manifesto-heading" className="sr-only">
            Manifesto
          </h2>
          <p className="text-body-lg text-fgSubtle">
            <span className="line-through decoration-fgSubtle/60 mr-3">
              No screenshots.
            </span>
            <span className="line-through decoration-fgSubtle/60 mr-3">
              No fake case studies.
            </span>
            <span className="text-brand font-medium">Just live numbers.</span>
          </p>
          <blockquote className="mt-8 text-display-2 text-fg tracking-[-0.03em] leading-[1.06] max-w-[640px] mx-auto">
            <div>Real growth.</div>
            <div>Real-time numbers.</div>
          </blockquote>
        </FadeContent>
      </section>

      {/* ----- ETHOS (FadeContent on scroll) ----- */}
      <section
        aria-labelledby="ethos-heading"
        className="w-full pb-20 sm:pb-24 max-w-[1100px] mx-auto"
      >
        <FadeContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div>
              <p className="text-micro uppercase text-fgSubtle tracking-[0.04em] mb-2">
                Why this exists
              </p>
              <h3 id="ethos-heading" className="text-subsection text-fg mb-3">
                Numbers, not narratives.
              </h3>
              <p className="text-body text-fgMuted">
                Every creator we&apos;ve built shows up here with their live
                counts — not a cherry-picked deck.
              </p>
            </div>
            <div>
              <p className="text-micro uppercase text-fgSubtle tracking-[0.04em] mb-2">
                What you&apos;ll see
              </p>
              <h3 className="text-subsection text-fg mb-3">
                Followers, engagement, growth, reach.
              </h3>
              <p className="text-body text-fgMuted">
                Across every platform we operate. Snapshots every day. No edited
                screenshots.
              </p>
            </div>
            <div>
              <p className="text-micro uppercase text-fgSubtle tracking-[0.04em] mb-2">
                Who&apos;s behind it
              </p>
              <h3 className="text-subsection text-fg mb-3">
                A creator-growth ecosystem from Malaysia.
              </h3>
              <p className="text-body text-fgMuted">
                Since 2021. Founders, operators, and creators building real
                commercial IP.
              </p>
            </div>
          </div>
        </FadeContent>
      </section>

      {/* ----- LIVE PREVIEW BENTO ----- */}
      <section className="w-full pb-20 sm:pb-24 max-w-[1100px] mx-auto">
        <Reveal>
          <SectionLabel
            eyebrow="Live preview"
            title="What's behind the door."
            caption="A snapshot of the dashboard, refreshed continuously."
          />

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] gap-4 items-stretch">
            {/* Top creators — top 5, by followers (no platform column) */}
            <GlassCard
              variant="base"
              padding="md"
              radius="2xl"
              className="flex flex-col"
            >
              <div className="flex items-end justify-between mb-4">
                <div className="flex flex-col gap-1">
                  <span className="text-label text-fg font-medium">
                    Top Creators
                  </span>
                  <span className="text-body-sm text-fgMuted">
                    By views · all platforms
                  </span>
                </div>
                <Link
                  href="/leaderboard"
                  className="text-caption text-fgMuted hover:text-fg transition-colors duration-150 ease-out"
                >
                  See all →
                </Link>
              </div>

              <ul>
                {topCreators.map((creator) => {
                  const isWinner = creator.rank === 1;
                  const initial =
                    creator.displayName.trim().charAt(0).toUpperCase() || '?';
                  const slug = creator.primaryHandle
                    ? handleToSlug(creator.primaryHandle)
                    : null;
                  const rowClass = `grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 items-center px-2 min-h-[52px] rounded-lg border-b border-borderGlass last:border-b-0 transition-colors duration-150 ease-out ${
                    isWinner ? 'bg-brand/[0.06]' : ''
                  }`;
                  const cells = (
                    <>
                      <span
                        className={`font-mono tabular-nums text-body-sm ${
                          isWinner
                            ? 'text-brand font-semibold'
                            : 'text-fgSubtle'
                        }`}
                      >
                        {String(creator.rank).padStart(2, '0')}
                      </span>
                      <span className="flex items-center gap-3 min-w-0">
                        <span className="size-8 shrink-0 rounded-full bg-customColor1 border border-borderGlass grid place-items-center overflow-hidden text-caption text-fgMuted">
                          <ImageWithFallback
                            src={creator.avatarUrl}
                            alt=""
                            className="size-full object-cover"
                            fallback={initial}
                          />
                        </span>
                        <span className="truncate text-body text-fg font-medium">
                          {creator.displayName}
                        </span>
                      </span>
                      <span className="text-right font-mono tabular-nums text-body text-fg">
                        <ShowcaseNumber value={creator.totalViews} />
                      </span>
                    </>
                  );
                  return (
                    <li key={creator.creatorId}>
                      {slug ? (
                        <Link
                          href={`/creators/${slug}`}
                          className={`${rowClass} hover:bg-white/[0.03] focus-visible:bg-white/[0.05] outline-none`}
                        >
                          {cells}
                        </Link>
                      ) : (
                        <div className={rowClass}>{cells}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </GlassCard>

            {/* Total views + supporting stats (fills the card) */}
            <Link href="/dashboard" className="group block">
              <GlassCard
                variant="base"
                hover
                padding="md"
                radius="2xl"
                className="h-full flex flex-col"
              >
                <div className="flex items-end justify-between mb-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-label text-fg font-medium">
                      Total Views
                    </span>
                    <span className="text-body-sm text-fgMuted">
                      All platforms · recent posts
                    </span>
                  </div>
                  <span className="text-caption text-fgMuted">
                    Open{' '}
                    <span className="inline-block transition-transform duration-150 ease-out group-hover:translate-x-0.5">
                      →
                    </span>
                  </span>
                </div>

                <div className="flex flex-1 flex-col justify-center py-2">
                  <div className="text-[clamp(34px,4.2vw,52px)] leading-[1.0] tracking-[-0.03em] font-semibold text-fg tabular-nums">
                    {formatShowcase(summary.combinedViews)}
                  </div>
                  <div className="text-caption text-fgMuted mt-2">
                    views across tracked recent posts
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-4 border-t border-borderGlass">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-caption text-fgSubtle">
                      Combined followers
                    </span>
                    <span className="text-heading text-fg tabular-nums">
                      {formatShowcase(summary.combinedFollowers)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="text-caption text-fgSubtle">
                      Total engagement
                    </span>
                    <span className="text-heading text-fg tabular-nums">
                      {formatShowcase(combinedEngagement)}
                    </span>
                  </div>
                </div>
              </GlassCard>
            </Link>
          </div>
        </Reveal>
      </section>

      {/* ----- PLATFORMS ----- */}
      <section className="w-full pb-20 sm:pb-24 max-w-[1100px] mx-auto">
        <Reveal>
          <SectionLabel
            eyebrow="Coverage"
            title="Four platforms. One showcase."
            caption="Every creator we manage, every platform we run."
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 lg:gap-5">
            {PLATFORM_ORDER.map((platform) => {
              const Icon = PLATFORM_ICONS[platform];
              const live = liveByPlatform.get(platform);
              const isEmpty = !live;
              const followers = live?.followers ?? 0;
              const totalViews = live?.totalViews ?? 0;
              const creatorCount = live?.creatorCount ?? 0;
              return (
                <Link
                  key={platform}
                  href="/dashboard"
                  className={`block h-full group ${isEmpty ? 'opacity-50' : ''}`}
                >
                  <GlassCard
                    variant="base"
                    hover
                    padding="md"
                    radius="2xl"
                    className="h-full flex flex-col gap-4"
                  >
                    <div className="flex items-center justify-between">
                      <span className="inline-flex items-center justify-center size-10 rounded-md bg-customColor16 border border-borderGlass text-fg">
                        <Icon size={18} />
                      </span>
                      <span className="text-caption text-fgSubtle font-mono tabular-nums">
                        {isEmpty
                          ? 'Not yet tracked'
                          : `${creatorCount} creator${creatorCount === 1 ? '' : 's'}`}
                      </span>
                    </div>

                    <div className="flex flex-col gap-1">
                      <span className="text-label text-fg font-medium">
                        {PLATFORM_LABELS[platform]}
                      </span>
                      <span className="text-[clamp(20px,2vw,24px)] leading-none tracking-[-0.02em] font-semibold text-fg tabular-nums">
                        {isEmpty ? '—' : formatShowcase(totalViews)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-caption text-fgMuted font-mono tabular-nums pt-3 border-t border-borderGlass">
                      <span>{isEmpty ? '—' : formatShowcase(followers)}</span>
                      <span>followers</span>
                    </div>
                  </GlassCard>
                </Link>
              );
            })}
          </div>
        </Reveal>
      </section>

      {/* ----- STATS STRIP ----- */}
      <section className="w-full pb-20 sm:pb-24 max-w-[1100px] mx-auto">
        <Reveal>
          <GlassCard variant="base" padding="none" radius="2xl">
            <dl className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-borderGlass">
              <StatCell
                label="Tracked Creators"
                value={exactFormatter.format(summary.trackedCreators)}
                note="Across every platform"
              />
              <StatCell
                label="Combined Followers"
                value={formatShowcase(summary.combinedFollowers)}
                note="Summed across all profiles"
              />
              <StatCell
                label="Total Views"
                value={formatShowcase(summary.combinedViews)}
                note="across tracked recent posts"
              />
            </dl>
          </GlassCard>
        </Reveal>
      </section>

      {/* ----- BOTTOM CTA BAND ----- */}
      <section className="w-full pb-24 max-w-[1100px] mx-auto">
        <Reveal>
          <GlassCard
            variant="base"
            padding="lg"
            radius="2xl"
            className="text-center"
          >
            <h2 className="text-display-2 text-fg max-w-[640px] mx-auto mb-4">
              Watch creators grow, live.
            </h2>
            <p className="text-body-lg text-fgMuted max-w-[520px] mx-auto mb-8">
              The dashboard refreshes the moment our scraper kicks in. Pick a
              platform, sort by growth, watch the numbers move.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link href="/dashboard" className="contents">
                <AuroraButton variant="cta" size="lg">
                  Open the dashboard
                </AuroraButton>
              </Link>
              <Link href="/leaderboard" className="contents">
                <AuroraButton variant="ghost" size="lg">
                  See the leaderboard
                </AuroraButton>
              </Link>
            </div>
            {!isLive && (
              <p className="text-caption text-fgSubtle mt-8 tabular-nums">
                Showcase preview · synthetic data until the scraper switches on.
              </p>
            )}
          </GlassCard>
        </Reveal>
      </section>
    </div>
  );
}

interface SectionLabelProps {
  eyebrow: string;
  title: string;
  caption?: string;
}

/** Eyebrow + title + optional caption heading block for a landing-page section. */
function SectionLabel({ eyebrow, title, caption }: SectionLabelProps) {
  return (
    <div className="mb-6 flex flex-col gap-1.5">
      <span className="text-micro uppercase text-fgSubtle tracking-[0.04em]">
        {eyebrow}
      </span>
      <h2 className="text-subsection text-fg">{title}</h2>
      {caption ? (
        <p className="text-body-sm text-fgMuted max-w-[520px]">{caption}</p>
      ) : null}
    </div>
  );
}

interface StatCellProps {
  label: string;
  value: string;
  note: string;
}

/** Single stat cell (label · value · note) in the bottom stats strip. */
function StatCell({ label, value, note }: StatCellProps) {
  return (
    <div className="p-6 sm:p-8 flex flex-col gap-3">
      <dt className="text-micro uppercase text-fgSubtle tracking-[0.04em]">
        {label}
      </dt>
      <dd className="text-[clamp(28px,3vw,40px)] leading-[1.02] tracking-[-0.03em] font-semibold text-fg tabular-nums">
        {value}
      </dd>
      <p className="text-caption text-fgMuted tabular-nums">{note}</p>
    </div>
  );
}
