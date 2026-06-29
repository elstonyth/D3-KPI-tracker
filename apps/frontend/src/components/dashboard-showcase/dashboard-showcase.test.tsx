/**
 * @jest-environment jsdom
 *
 * Windowed-views cell resolution on the public dashboard.
 *
 * Contract (DashboardViewTotals in lib/metrics-windowed.ts): the RPC emits no
 * row for a key/window with no posts — with live windowed data a MISSING cell
 * means 0. The cumulative-lifetime fallback applies only when no windowed data
 * was loaded at all (demo mode, or the RPC errored and returned empty maps).
 *
 * Regression: the hero/breakdown/top-creators lookups used a bare
 * `matrix?.[key]?.[window] ?? cumulative`, so selecting e.g. "1D" with nothing
 * posted in 24h rendered the LIFETIME total under a "last 24 hours" caption,
 * and zero-post creators kept their lifetime views in the period re-rank.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { DashboardShowcase } from './dashboard-showcase';
import type { LiveCreatorRow } from '@gitroom/frontend/lib/queries';

const CUMULATIVE = 1_234_567; // ≥1M → formatShowcase renders exact "1,234,567"

const creator: LiveCreatorRow = {
  rank: 1,
  creatorId: 'c1',
  displayName: 'Creator One',
  avatarUrl: null,
  primaryHandle: 'creator.one',
  primaryPlatform: 'instagram',
  followers: 4800,
  totalViews: CUMULATIVE,
  totalEngagement: 77,
  platforms: [
    {
      platform: 'instagram',
      dbPlatform: 'instagram',
      handle: 'creator.one',
      followers: 4800,
      totalViews: CUMULATIVE,
      totalEngagement: 77,
      postCount: 5,
    },
  ],
};

// Live windowed matrices with ONLY lifetime cells — no '1d' rows, exactly what
// the RPC returns when nothing was posted in the last 24 hours.
const lifetimeOnlyByPlatform = {
  all: { lifetime: 999 },
  instagram: { lifetime: 999 },
};
const lifetimeOnlyByCreator = {
  c1: { all: { lifetime: 999 }, instagram: { lifetime: 999 } },
};

function clickPeriod(label: string) {
  fireEvent.click(screen.getByRole('tab', { name: label }));
}

test('a missing window cell renders 0 — never the lifetime total relabeled as the period', () => {
  render(
    <DashboardShowcase
      creators={[creator]}
      viewsByWindow={lifetimeOnlyByPlatform}
      creatorViewsByWindow={lifetimeOnlyByCreator}
    />,
  );

  clickPeriod('1D');

  // Period switched…
  expect(screen.getByText(/last 24 hours/)).toBeTruthy();
  // …and the cumulative lifetime total must appear NOWHERE (hero, top-creators
  // row, breakdown) — the matrices are live and have no '1d' cells, so every
  // windowed figure is a real 0.
  expect(screen.queryByText('1,234,567')).toBeNull();
  expect(screen.getAllByText('0').length).toBeGreaterThan(0);
});

test('lifetime period still reconciles with the matrix lifetime cell', () => {
  render(
    <DashboardShowcase
      creators={[creator]}
      viewsByWindow={lifetimeOnlyByPlatform}
      creatorViewsByWindow={lifetimeOnlyByCreator}
    />,
  );

  // Default period is Lifetime → hero reads the matrix 'all'/'lifetime' cell.
  expect(screen.getAllByText('999').length).toBeGreaterThan(0);
});

test('empty matrices (RPC error) keep the documented cumulative fallback', () => {
  render(
    <DashboardShowcase
      creators={[creator]}
      viewsByWindow={{}}
      creatorViewsByWindow={{}}
    />,
  );

  clickPeriod('1D');

  // No windowed data was loaded at all → cumulative totals stay on screen
  // rather than a sea of fake zeros.
  expect(screen.getAllByText('1,234,567').length).toBeGreaterThan(0);
});

test('omitted matrices (demo mode) keep the cumulative fallback', () => {
  render(<DashboardShowcase creators={[creator]} />);

  clickPeriod('1D');

  expect(screen.getAllByText('1,234,567').length).toBeGreaterThan(0);
});
