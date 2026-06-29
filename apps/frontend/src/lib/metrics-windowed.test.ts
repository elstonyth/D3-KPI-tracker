import {
  getCreatorMetricsWindowed,
  getTopContentWindowed,
} from './metrics-windowed';

/** Minimal mock matching the `.rpc()` surface the wrapper uses. */
function mockClient(result: { data?: unknown; error?: unknown }) {
  const rpc = jest.fn().mockResolvedValue({
    data: result.data ?? null,
    error: result.error ?? null,
  });
  return { client: { rpc }, rpc };
}

describe('getCreatorMetricsWindowed', () => {
  it('calls the RPC with window + null filters and maps snake->camel', async () => {
    const { client, rpc } = mockClient({
      data: [
        {
          creator_id: 'c1', display_name: 'Alice', avatar_url: null,
          primary_platform: 'tiktok', primary_handle: 'alice_tt',
          followers: 1200, followers_delta: 200,
          views_gained: 6000, engagement: 0.0643, post_count: 2, insufficient: false,
        },
      ],
    });
    const rows = await getCreatorMetricsWindowed('30d', { client: client as never });
    expect(rpc).toHaveBeenCalledWith('creator_metrics_windowed', {
      p_window: '30d', p_creator_ids: null, p_profile_ids: null,
    });
    expect(rows).toEqual([
      {
        creatorId: 'c1', displayName: 'Alice', avatarUrl: null,
        primaryPlatform: 'tiktok', primaryHandle: 'alice_tt',
        followers: 1200, followersDelta: 200,
        viewsGained: 6000, engagement: 0.0643, postCount: 2, insufficient: false,
      },
    ]);
  });

  it('maps primary_handle and tolerates a null handle', async () => {
    const { client } = mockClient({
      data: [
        {
          creator_id: 'c1', display_name: 'Alice', avatar_url: null,
          primary_platform: 'tiktok', primary_handle: 'alice_tt',
          followers: 10, followers_delta: 0, views_gained: 0,
          engagement: null, post_count: 0, insufficient: true,
        },
        {
          creator_id: 'c2', display_name: 'Bob', avatar_url: null,
          primary_platform: null, primary_handle: null,
          followers: 5, followers_delta: 0, views_gained: 0,
          engagement: null, post_count: 0, insufficient: true,
        },
      ],
    });
    const rows = await getCreatorMetricsWindowed('30d', { client: client as never });
    expect(rows[0].primaryHandle).toBe('alice_tt');
    expect(rows[1].primaryHandle).toBeNull();
  });

  it('forwards creatorIds / profileIds filters', async () => {
    const { client, rpc } = mockClient({ data: [] });
    await getCreatorMetricsWindowed('7d', {
      client: client as never, creatorIds: ['c1'], profileIds: ['p1', 'p2'],
    });
    expect(rpc).toHaveBeenCalledWith('creator_metrics_windowed', {
      p_window: '7d', p_creator_ids: ['c1'], p_profile_ids: ['p1', 'p2'],
    });
  });

  it('returns [] and does not throw on RPC error', async () => {
    const { client } = mockClient({ error: { message: 'boom' } });
    const rows = await getCreatorMetricsWindowed('30d', { client: client as never });
    expect(rows).toEqual([]);
  });

  it('coerces null engagement to null', async () => {
    const { client } = mockClient({
      data: [
        {
          creator_id: 'c1', display_name: null, avatar_url: null,
          primary_platform: null, followers: 0, followers_delta: 0,
          views_gained: 0, engagement: null, post_count: 0, insufficient: true,
        },
      ],
    });
    const rows = await getCreatorMetricsWindowed('lifetime', { client: client as never });
    expect(rows[0].engagement).toBeNull();
    expect(rows[0].insufficient).toBe(true);
  });

  it('coerces a malformed non-numeric value to 0 instead of NaN', async () => {
    const { client } = mockClient({
      data: [
        {
          creator_id: 'c1', display_name: 'Alice', avatar_url: null,
          primary_platform: 'tiktok', followers: 'not-a-number',
          followers_delta: 200, views_gained: 6000, engagement: 0.0643,
          post_count: 2, insufficient: false,
        },
      ],
    });
    const rows = await getCreatorMetricsWindowed('30d', { client: client as never });
    expect(rows[0].followers).toBe(0);
    expect(Number.isNaN(rows[0].followers)).toBe(false);
  });
});

describe('getTopContentWindowed', () => {
  it('calls the RPC with limit and proxy-wraps media_url', async () => {
    const { client, rpc } = mockClient({
      data: [
        {
          external_post_id: 'A', profile_id: 'p1', creator_id: 'c1',
          creator_name: 'Alice', platform: 'tiktok', handle: 'alice',
          caption_excerpt: 'hi', media_url: 'https://cdn.example.com/x.jpg',
          posted_at: '2026-05-01T00:00:00Z', views_gained: 4000,
          current_views: 5000, likes: 200, comments: 50, shares: 50,
          also_on: ['instagram', 'facebook'],
        },
      ],
    });
    const rows = await getTopContentWindowed('30d', { client: client as never, limit: 20 });
    expect(rpc).toHaveBeenCalledWith('top_content_windowed', {
      p_window: '30d', p_limit: 20, p_creator_ids: null, p_profile_ids: null,
    });
    expect(rows[0].thumbnailUrl).toBe(
      '/api/proxy-image?url=' + encodeURIComponent('https://cdn.example.com/x.jpg'),
    );
    expect(rows[0].externalPostId).toBe('A');
    expect(rows[0].viewsGained).toBe(4000);
    expect(rows[0].alsoOn).toEqual(['instagram', 'facebook']);
  });

  it('leaves null media_url as null and defaults limit to 20', async () => {
    const { client, rpc } = mockClient({
      data: [
        {
          external_post_id: 'B', profile_id: 'p1', creator_id: 'c1',
          creator_name: null, platform: 'instagram', handle: null,
          caption_excerpt: null, media_url: null, posted_at: null,
          views_gained: 0, current_views: 0, likes: 0, comments: 0, shares: 0,
        },
      ],
    });
    const rows = await getTopContentWindowed('7d', { client: client as never });
    expect(rpc).toHaveBeenCalledWith('top_content_windowed', {
      p_window: '7d', p_limit: 20, p_creator_ids: null, p_profile_ids: null,
    });
    expect(rows[0].thumbnailUrl).toBeNull();
    expect(rows[0].alsoOn).toBeUndefined();
  });

  it('returns [] on error', async () => {
    const { client } = mockClient({ error: { message: 'nope' } });
    expect(await getTopContentWindowed('30d', { client: client as never })).toEqual([]);
  });
});
