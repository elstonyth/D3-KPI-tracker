import type { CreatorMetricWindowRow } from './metrics-windowed';
import { rankCreatorsByFollowerDelta } from './admin-top30';

function row(over: Partial<CreatorMetricWindowRow>): CreatorMetricWindowRow {
  return {
    creatorId: 'id',
    displayName: 'name',
    avatarUrl: null,
    primaryPlatform: 'instagram',
    primaryHandle: 'h',
    followers: 0,
    followersDelta: 0,
    viewsGained: 0,
    engagement: null,
    postCount: 0,
    insufficient: false,
    ...over,
  };
}

describe('rankCreatorsByFollowerDelta', () => {
  it('sorts sufficient creators by followersDelta desc', () => {
    const out = rankCreatorsByFollowerDelta([
      row({ creatorId: 'a', followersDelta: 10 }),
      row({ creatorId: 'b', followersDelta: 50 }),
      row({ creatorId: 'c', followersDelta: 30 }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(['b', 'c', 'a']);
  });

  it('breaks delta ties by followers desc', () => {
    const out = rankCreatorsByFollowerDelta([
      row({ creatorId: 'a', followersDelta: 10, followers: 100 }),
      row({ creatorId: 'b', followersDelta: 10, followers: 900 }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(['b', 'a']);
  });

  it('appends insufficient creators after all ranked ones', () => {
    const out = rankCreatorsByFollowerDelta([
      row({ creatorId: 'young', insufficient: true, followers: 999 }),
      row({ creatorId: 'a', followersDelta: 5 }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(['a', 'young']);
  });

  it('returns an empty array for empty input', () => {
    expect(rankCreatorsByFollowerDelta([])).toEqual([]);
  });

  it('breaks follower ties by displayName asc', () => {
    const out = rankCreatorsByFollowerDelta([
      row({ creatorId: 'z', followersDelta: 10, followers: 100, displayName: 'Zara' }),
      row({ creatorId: 'a', followersDelta: 10, followers: 100, displayName: 'Alice' }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(['a', 'z']);
  });

  it('sorts insufficient creators by followers desc', () => {
    const out = rankCreatorsByFollowerDelta([
      row({ creatorId: 'small', insufficient: true, followers: 10 }),
      row({ creatorId: 'big', insufficient: true, followers: 500 }),
    ]);
    expect(out.map((r) => r.creatorId)).toEqual(['big', 'small']);
  });
});
