import {
  summarizeCreatorRows,
  platformBreakdownFromRows,
  topCreatorRows,
  type LiveCreatorRow,
} from './queries';

function row(over: Partial<LiveCreatorRow>): LiveCreatorRow {
  return {
    rank: 0,
    creatorId: 'c',
    displayName: 'C',
    avatarUrl: null,
    primaryHandle: 'c',
    primaryPlatform: 'instagram',
    followers: 0,
    totalViews: 0,
    totalEngagement: 0,
    platforms: [],
    ...over,
  };
}

// A multi-platform creator whose Facebook profile is bigger than its TikTok one
// (so primaryPlatform = facebook). The bug we fixed: the dashboard used to dump
// this creator's WHOLE follower count onto its primary platform.
const kopi = row({
  creatorId: 'kopi',
  displayName: 'kopi',
  primaryPlatform: 'facebook',
  primaryHandle: 'kopi-fb',
  followers: 4800,
  totalViews: 1000,
  totalEngagement: 100,
  platforms: [
    { platform: 'facebook', dbPlatform: 'facebook', handle: 'kopi-fb', followers: 4000, totalViews: 600, totalEngagement: 60, postCount: 5 },
    { platform: 'tiktok', dbPlatform: 'tiktok', handle: 'kopi7777', followers: 800, totalViews: 400, totalEngagement: 40, postCount: 5 },
  ],
});

const magie = row({
  creatorId: 'magie',
  displayName: 'magie',
  primaryPlatform: 'tiktok',
  primaryHandle: 'magie',
  followers: 5600,
  totalViews: 500,
  totalEngagement: 50,
  platforms: [
    { platform: 'tiktok', dbPlatform: 'tiktok', handle: 'magie', followers: 5600, totalViews: 500, totalEngagement: 50, postCount: 3 },
  ],
});

describe('platformBreakdownFromRows', () => {
  it('attributes each profile to its OWN platform (not the creator primary)', () => {
    const bk = platformBreakdownFromRows([kopi, magie]);
    const tiktok = bk.find((b) => b.platform === 'tiktok')!;
    const facebook = bk.find((b) => b.platform === 'facebook')!;

    // kopi's 800 TikTok followers count under tiktok (with magie's 5600), NOT
    // dumped onto facebook just because facebook is kopi's primary.
    expect(tiktok.followers).toBe(6400);
    expect(tiktok.totalViews).toBe(900);
    expect(tiktok.creatorCount).toBe(2);

    expect(facebook.followers).toBe(4000);
    expect(facebook.totalViews).toBe(600);
    expect(facebook.creatorCount).toBe(1);
  });

  it('partitions the grand total across platforms (sums match)', () => {
    const bk = platformBreakdownFromRows([kopi, magie]);
    const totalFollowers = bk.reduce((s, b) => s + b.followers, 0);
    const totalViews = bk.reduce((s, b) => s + b.totalViews, 0);
    expect(totalFollowers).toBe(10400); // 4800 + 5600
    expect(totalViews).toBe(1500); // 1000 + 500
  });
});

describe('summarizeCreatorRows', () => {
  it('sums combined followers + views over creators', () => {
    expect(summarizeCreatorRows([kopi, magie])).toEqual({
      trackedCreators: 2,
      combinedFollowers: 10400,
      combinedViews: 1500,
    });
  });

  it('is empty-safe', () => {
    expect(summarizeCreatorRows([])).toEqual({
      trackedCreators: 0,
      combinedFollowers: 0,
      combinedViews: 0,
    });
  });
});

describe('topCreatorRows', () => {
  it('ranks by followers desc and re-numbers rank', () => {
    const top = topCreatorRows([kopi, magie], 5);
    expect(top.map((r) => r.creatorId)).toEqual(['magie', 'kopi']); // 5600 > 4800
    expect(top.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('respects the limit', () => {
    expect(topCreatorRows([kopi, magie], 1)).toHaveLength(1);
  });
});
