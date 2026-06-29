import { resolveMediaUrl } from './media-url';

describe('resolveMediaUrl', () => {
  it('returns null for nullish / empty input', () => {
    expect(resolveMediaUrl(null)).toBeNull();
    expect(resolveMediaUrl(undefined)).toBeNull();
    expect(resolveMediaUrl('')).toBeNull();
  });

  it('returns null for non-http input', () => {
    expect(resolveMediaUrl('data:image/png;base64,xxxx')).toBeNull();
    expect(resolveMediaUrl('/local/path.jpg')).toBeNull();
    expect(resolveMediaUrl('not a url')).toBeNull();
  });

  it('passes permanent Supabase Storage URLs through unchanged (no proxy)', () => {
    const url =
      'https://wmesjldkqvbzrcpitclu.supabase.co/storage/v1/object/public/post-media/abc/123';
    expect(resolveMediaUrl(url)).toBe(url);
  });

  it('routes ephemeral social-CDN URLs through the same-origin image proxy', () => {
    const cdn =
      'https://scontent-cph2-1.cdninstagram.com/v/t51.71878-15/503859606_n.jpg?oe=6A217468';
    expect(resolveMediaUrl(cdn)).toBe(
      `/api/proxy-image?url=${encodeURIComponent(cdn)}`,
    );
  });

  it('proxies tiktok / fbcdn hosts too (anything not supabase)', () => {
    const tt = 'https://p19-common-sign.tiktokcdn-us.com/x.jpeg?x-expires=1';
    expect(resolveMediaUrl(tt)).toBe(
      `/api/proxy-image?url=${encodeURIComponent(tt)}`,
    );
  });

  it('returns null for a malformed URL that slips past the http prefix check', () => {
    // "http://" with no host throws in the URL constructor.
    expect(resolveMediaUrl('http://')).toBeNull();
  });
});
