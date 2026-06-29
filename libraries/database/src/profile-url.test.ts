/**
 * Unit tests for profile URL validators.
 * Run with: pnpm exec tsx --test libraries/database/src/profile-url.test.ts
 * (or: node --import tsx --test libraries/database/src/profile-url.test.ts)
 *
 * Using node:test so the libraries/* layer has zero jest/vitest plumbing.
 * Frontend tests (apps/frontend/) stay on whatever next.js test runner ships.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectPlatform, validateProfileUrl } from './profile-url';

describe('detectPlatform', () => {
  it('detects instagram', () => {
    assert.equal(detectPlatform('https://www.instagram.com/john'), 'instagram');
    assert.equal(detectPlatform('https://instagram.com/jane/'), 'instagram');
  });
  it('detects tiktok', () => {
    assert.equal(detectPlatform('https://www.tiktok.com/@user'), 'tiktok');
  });
  it('detects facebook', () => {
    assert.equal(detectPlatform('https://facebook.com/page'), 'facebook');
    assert.equal(detectPlatform('https://www.fb.com/page'), 'facebook');
  });
  it('detects rednote (xiaohongshu)', () => {
    assert.equal(
      detectPlatform('https://www.xiaohongshu.com/user/profile/abc123'),
      'rednote',
    );
  });
  it('detects douyin', () => {
    assert.equal(
      detectPlatform('https://www.douyin.com/user/MS4wLjA'),
      'douyin',
    );
  });
  it('returns null for unknown host', () => {
    assert.equal(detectPlatform('https://twitter.com/user'), null);
    assert.equal(detectPlatform('not a url'), null);
    assert.equal(detectPlatform(''), null);
  });
});

describe('validateProfileUrl — instagram', () => {
  it('accepts profile root with @', () => {
    const r = validateProfileUrl('instagram', 'https://www.instagram.com/@john_ig');
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.handle, 'john_ig');
      assert.equal(r.normalizedUrl, 'https://www.instagram.com/@john_ig');
    }
  });
  it('accepts profile root without @', () => {
    const r = validateProfileUrl('instagram', 'https://instagram.com/jane.smith/');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.handle, 'jane.smith');
  });
  it('rejects post URL', () => {
    const r = validateProfileUrl('instagram', 'https://www.instagram.com/p/ABC123/');
    assert.equal(r.ok, false);
  });
  it('rejects reel URL', () => {
    const r = validateProfileUrl('instagram', 'https://www.instagram.com/reel/XYZ/');
    assert.equal(r.ok, false);
  });
  it('rejects cross-platform paste (tiktok URL claimed as instagram)', () => {
    const r = validateProfileUrl('instagram', 'https://www.tiktok.com/@user');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /does not match platform instagram/);
  });
});

describe('validateProfileUrl — tiktok', () => {
  it('accepts @handle', () => {
    const r = validateProfileUrl('tiktok', 'https://www.tiktok.com/@dancer');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.handle, 'dancer');
  });
  it('rejects video URL', () => {
    const r = validateProfileUrl(
      'tiktok',
      'https://www.tiktok.com/@dancer/video/12345',
    );
    assert.equal(r.ok, false);
  });
});

describe('validateProfileUrl — facebook', () => {
  it('accepts vanity handle', () => {
    const r = validateProfileUrl('facebook', 'https://www.facebook.com/zuck');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.handle, 'zuck');
  });
  it('accepts profile.php?id=', () => {
    const r = validateProfileUrl(
      'facebook',
      'https://www.facebook.com/profile.php?id=100012345',
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.handle, '100012345');
      assert.equal(
        r.normalizedUrl,
        'https://www.facebook.com/profile.php?id=100012345',
      );
    }
  });
  it('rejects profile.php with non-numeric id', () => {
    const r = validateProfileUrl(
      'facebook',
      'https://www.facebook.com/profile.php?id=abc',
    );
    assert.equal(r.ok, false);
  });
  it('rejects /share path', () => {
    const r = validateProfileUrl('facebook', 'https://www.facebook.com/share/p/abc');
    assert.equal(r.ok, false);
  });
});

describe('validateProfileUrl — rednote', () => {
  it('accepts /user/profile/<id>', () => {
    const r = validateProfileUrl(
      'rednote',
      'https://www.xiaohongshu.com/user/profile/5f8a2b3c4d5e6f7g8h9i0',
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.handle, '5f8a2b3c4d5e6f7g8h9i0');
  });
  it('rejects post URL', () => {
    const r = validateProfileUrl(
      'rednote',
      'https://www.xiaohongshu.com/explore/abc',
    );
    assert.equal(r.ok, false);
  });
});

describe('validateProfileUrl — douyin', () => {
  it('accepts /user/<sec_uid>', () => {
    const r = validateProfileUrl(
      'douyin',
      'https://www.douyin.com/user/MS4wLjABAAAA_long-id-with-dashes',
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.handle, 'MS4wLjABAAAA_long-id-with-dashes');
  });
});

describe('validateProfileUrl — edge cases', () => {
  it('rejects empty string', () => {
    const r = validateProfileUrl('instagram', '');
    assert.equal(r.ok, false);
  });
  it('rejects whitespace-only', () => {
    const r = validateProfileUrl('instagram', '   ');
    assert.equal(r.ok, false);
  });
  it('rejects malformed URL', () => {
    const r = validateProfileUrl('instagram', 'not-a-url');
    assert.equal(r.ok, false);
  });
  it('rejects non-http protocol', () => {
    const r = validateProfileUrl('instagram', 'ftp://instagram.com/user');
    assert.equal(r.ok, false);
  });
  it('strips trailing slash in normalizedUrl', () => {
    const r = validateProfileUrl('instagram', 'https://www.instagram.com/user/');
    if (r.ok) assert.ok(!r.normalizedUrl.endsWith('/'));
  });
});

describe('validateProfileUrl — bare URLs (no scheme)', () => {
  const cases: Array<[Parameters<typeof validateProfileUrl>[0], string, string]> = [
    ['instagram', 'instagram.com/handle', 'handle'],
    ['instagram', 'www.instagram.com/handle', 'handle'],
    ['tiktok', 'www.tiktok.com/@handle', 'handle'],
    ['tiktok', 'tiktok.com/@handle', 'handle'],
    ['facebook', 'www.facebook.com/vanity', 'vanity'],
    ['facebook', 'facebook.com/profile.php?id=100012345', '100012345'],
    ['rednote', 'www.xiaohongshu.com/user/profile/64abc', '64abc'],
    ['douyin', 'www.douyin.com/user/MS4wLjABAAAA_x-y', 'MS4wLjABAAAA_x-y'],
  ];
  for (const [platform, url, handle] of cases) {
    it(`accepts bare ${url}`, () => {
      const r = validateProfileUrl(platform, url);
      assert.equal(r.ok, true, `expected ${url} to validate`);
      if (r.ok) {
        assert.equal(r.handle, handle);
        assert.ok(r.normalizedUrl.startsWith('https://'));
      }
    });
  }
  it('detectPlatform also handles bare URLs', () => {
    assert.equal(detectPlatform('instagram.com/x'), 'instagram');
    assert.equal(detectPlatform('www.tiktok.com/@x'), 'tiktok');
  });
});

describe('validateProfileUrl — canonical host normalization', () => {
  it('collapses m./web./no-www to one canonical URL', () => {
    const variants = [
      'https://m.instagram.com/handle',
      'https://instagram.com/handle',
      'http://www.instagram.com/handle/',
      'instagram.com/handle',
    ];
    for (const v of variants) {
      const r = validateProfileUrl('instagram', v);
      assert.equal(r.ok, true, v);
      if (r.ok) assert.equal(r.normalizedUrl, 'https://www.instagram.com/handle');
    }
  });
  it('canonicalizes facebook host (web./m./fb.com → www.facebook.com)', () => {
    for (const v of ['https://web.facebook.com/vanity', 'https://m.facebook.com/vanity', 'https://fb.com/vanity']) {
      const r = validateProfileUrl('facebook', v);
      assert.equal(r.ok, true, v);
      if (r.ok) assert.equal(r.normalizedUrl, 'https://www.facebook.com/vanity');
    }
  });
});

describe('validateProfileUrl — facebook extra shapes', () => {
  it('accepts /people/Name/id and canonicalizes to profile.php?id=', () => {
    const r = validateProfileUrl(
      'facebook',
      'https://www.facebook.com/people/Some-Name/61555000111222/',
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.handle, '61555000111222');
      assert.equal(r.normalizedUrl, 'https://www.facebook.com/profile.php?id=61555000111222');
    }
  });
  it('accepts a vanity URL with a sub-tab and drops the tab', () => {
    for (const tab of ['about', 'reels_tab', 'photos']) {
      const r = validateProfileUrl('facebook', `https://www.facebook.com/vanity/${tab}`);
      assert.equal(r.ok, true, tab);
      if (r.ok) assert.equal(r.normalizedUrl, 'https://www.facebook.com/vanity');
    }
  });
  it('still rejects reserved sections (/watch, /groups)', () => {
    assert.equal(validateProfileUrl('facebook', 'https://www.facebook.com/watch/').ok, false);
    assert.equal(validateProfileUrl('facebook', 'https://www.facebook.com/groups/123').ok, false);
  });
});

describe('validateProfileUrl — short links rejected with a clear message', () => {
  const cases: Array<[Parameters<typeof validateProfileUrl>[0], string]> = [
    ['tiktok', 'https://vm.tiktok.com/ZMabc123/'],
    ['tiktok', 'https://vt.tiktok.com/ZMabc123/'],
    ['douyin', 'https://v.douyin.com/abc123/'],
    ['rednote', 'https://xhslink.com/a/abc123'],
  ];
  for (const [platform, url] of cases) {
    it(`rejects ${url} with guidance`, () => {
      const r = validateProfileUrl(platform, url);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, /short link/i);
    });
  }
});
