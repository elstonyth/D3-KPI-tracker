import { collapseByContent, contentKey } from './content-dedup';
import type { TopContentRow } from './metrics-windowed';

function mk(p: Partial<TopContentRow>): TopContentRow {
  return {
    externalPostId: 'x',
    profileId: 'prof',
    creatorId: 'c1',
    creatorName: 'name',
    platform: 'instagram',
    handle: 'h',
    captionExcerpt: null,
    thumbnailUrl: null,
    postedAt: null,
    viewsGained: 0,
    currentViews: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    durationSeconds: null,
    ...p,
  };
}

const byViews = (r: TopContentRow) => r.currentViews;
const byInteractions = (r: TopContentRow) => r.likes + r.comments + r.shares;
const HOOK = '家里有旧衣服的千万别大发慈悲捐出去...';

describe('contentKey', () => {
  it('merges the same video cross-posted (same creator + duration + hook), despite divergent caption tails', () => {
    const fb = mk({ platform: 'facebook', externalPostId: 'fb', durationSeconds: 136, captionExcerpt: `${HOOK}\n她好心捐了几袋` });
    const tt = mk({ platform: 'tiktok', externalPostId: 'tt', durationSeconds: 136, captionExcerpt: `${HOOK} #旧衣服别乱捐` });
    expect(contentKey(fb)).toBe(contentKey(tt));
  });

  it('does NOT merge different videos of the same length by one creator (over-merge guard)', () => {
    expect(contentKey(mk({ durationSeconds: 136, captionExcerpt: HOOK }))).not.toBe(
      contentKey(mk({ durationSeconds: 136, captionExcerpt: '清明扫墓后，最容易被跟的3种人' })),
    );
  });

  it('does not merge different creators that share a duration + hook', () => {
    expect(contentKey(mk({ creatorId: 'a', durationSeconds: 90, captionExcerpt: '民宿不是给你们拿来睡觉的' }))).not.toBe(
      contentKey(mk({ creatorId: 'b', durationSeconds: 90, captionExcerpt: '民宿不是给你们拿来睡觉的' })),
    );
  });

  it('never merges no-duration posts (images) even with the same caption hook', () => {
    // No duration => no reliable cross-platform signal; the hook alone would
    // over-merge unrelated posts sharing an intro line, so they stay separate.
    expect(
      contentKey(mk({ profileId: 'p1', externalPostId: 'e1', durationSeconds: null, captionExcerpt: '散钱就能，吃到梦加拉餐' })),
    ).not.toBe(
      contentKey(mk({ profileId: 'p2', externalPostId: 'e2', durationSeconds: null, captionExcerpt: '散钱就能，吃到梦加拉餐 #foodie' })),
    );
  });

  it('never merges captionless videos that share a duration', () => {
    expect(
      contentKey(mk({ profileId: 'p1', externalPostId: 'e1', durationSeconds: 60, captionExcerpt: null })),
    ).not.toBe(
      contentKey(mk({ profileId: 'p2', externalPostId: 'e2', durationSeconds: 60, captionExcerpt: null })),
    );
  });

  it('never merges captionless, duration-less posts', () => {
    expect(contentKey(mk({ profileId: 'p1', externalPostId: 'e1' }))).not.toBe(
      contentKey(mk({ profileId: 'p2', externalPostId: 'e2' })),
    );
  });
});

describe('collapseByContent', () => {
  it('collapses a cross-posted video to one row tagged with the other platforms', () => {
    const rows = [
      mk({ platform: 'facebook', externalPostId: 'fb', durationSeconds: 136, captionExcerpt: `${HOOK}\n她好心`, currentViews: 2_180_000 }),
      mk({ platform: 'tiktok', externalPostId: 'tt', durationSeconds: 136, captionExcerpt: `${HOOK} #旧衣服`, currentViews: 1_320_000 }),
      mk({ platform: 'instagram', externalPostId: 'ig', durationSeconds: 136, captionExcerpt: `${HOOK}\n\n#旧衣服`, currentViews: 1_060_000 }),
    ];
    const out = collapseByContent(rows, byViews);
    expect(out).toHaveLength(1);
    expect(out[0].platform).toBe('facebook'); // highest views wins
    expect(new Set(out[0].alsoOn)).toEqual(new Set(['tiktok', 'instagram']));
  });

  it('keeps different videos of the same length as separate rows', () => {
    const rows = [
      mk({ platform: 'facebook', externalPostId: 'a', durationSeconds: 136, captionExcerpt: HOOK, currentViews: 100 }),
      mk({ platform: 'facebook', externalPostId: 'b', durationSeconds: 136, captionExcerpt: '清明扫墓后', currentViews: 200 }),
    ];
    expect(collapseByContent(rows, byViews)).toHaveLength(2);
  });

  it('is metric-aware: the by-views and by-interactions copies can differ', () => {
    const h = '什么100块钱不到可以买到20kg的海鲜';
    const rows = [
      mk({ platform: 'facebook', externalPostId: 'fb', durationSeconds: 90, captionExcerpt: h, currentViews: 900, likes: 1 }),
      mk({ platform: 'tiktok', externalPostId: 'tt', durationSeconds: 90, captionExcerpt: h, currentViews: 100, likes: 500 }),
    ];
    expect(collapseByContent(rows, byViews)[0].platform).toBe('facebook');
    expect(collapseByContent(rows, byInteractions)[0].platform).toBe('tiktok');
  });

  it('leaves genuinely distinct content untouched and untagged', () => {
    const out = collapseByContent(
      [
        mk({ durationSeconds: 30, externalPostId: 'a', captionExcerpt: 'one' }),
        mk({ durationSeconds: 45, externalPostId: 'b', captionExcerpt: 'two' }),
      ],
      byViews,
    );
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.alsoOn === undefined)).toBe(true);
  });
});
