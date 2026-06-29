/**
 * Phase 0 — typed access to the windowed-metrics SQL functions.
 *
 * All metric math lives in the Postgres functions creator_metrics_windowed /
 * top_content_windowed (migration 20260530000000_windowed_metrics_rpcs.sql).
 * This module is a thin pass-through: call the RPC, return typed rows, and
 * route post thumbnails through /api/proxy-image. No business logic here.
 *
 * Consumers inject a SupabaseClient so the right key is used:
 *   - public pages  -> getSupabaseRead() (anon, public-RLS)
 *   - admin / /me   -> their cookie-aware or service-role client
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseRead } from './supabase-server';
import { resolveMediaUrl } from './media-url';

/** Time window for every windowed metric. */
export type MetricWindow = '7d' | '30d' | '90d' | 'lifetime';

/** One row from creator_metrics_windowed. */
export interface CreatorMetricWindowRow {
  creatorId: string;
  displayName: string | null;
  avatarUrl: string | null;
  primaryPlatform: string | null;
  /** Handle of the creator's highest-follower profile. This is the slug used
   *  for /creators/<handle> links (the route resolves by profile handle, not
   *  by display name or creator id). null when that profile has no handle. */
  primaryHandle: string | null;
  followers: number;
  followersDelta: number;
  viewsGained: number;
  /** Ratio (e.g. 0.0643 = 6.43%). null when no qualifying posts. */
  engagement: number | null;
  postCount: number;
  /** True when there is no follower baseline in the window yet (no delta).
   *  Drives the "Building history…" UI state in later phases. */
  insufficient: boolean;
}

/** One row from top_content_windowed. */
export interface TopContentRow {
  externalPostId: string;
  profileId: string;
  creatorId: string;
  creatorName: string | null;
  platform: string;
  handle: string | null;
  captionExcerpt: string | null;
  /** Already routed through /api/proxy-image; null when no media. */
  thumbnailUrl: string | null;
  postedAt: string | null;
  viewsGained: number;
  currentViews: number;
  likes: number;
  comments: number;
  shares: number;
  /** Normalized video length in whole seconds (post_snapshot.duration_seconds);
   *  null for images / posts without a duration. Cross-platform de-dup key. */
  durationSeconds?: number | null;
  /** Other platforms this same content ran on (db platform strings), set when
   *  cross-platform duplicates were collapsed into this row. */
  alsoOn?: string[];
}

export interface WindowedMetricsOpts {
  /** Defaults to the anon read client. Inject a different client for admin/me. */
  client?: SupabaseClient;
  creatorIds?: string[];
  profileIds?: string[];
}

export interface TopContentOpts extends WindowedMetricsOpts {
  /** Max rows to return. Defaults to 20. */
  limit?: number;
}


function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  // Guard against a malformed RPC value (e.g. a non-numeric string) yielding
  // NaN, which would otherwise silently corrupt every downstream sum/sort.
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Per-creator windowed metrics. Returns [] on error (logged) so Server
 * Components can fall back to an empty state instead of throwing.
 */
export async function getCreatorMetricsWindowed(
  window: MetricWindow,
  opts: WindowedMetricsOpts = {},
): Promise<CreatorMetricWindowRow[]> {
  const sb = opts.client ?? getSupabaseRead();
  const { data, error } = await sb.rpc('creator_metrics_windowed', {
    p_window: window,
    p_creator_ids: opts.creatorIds ?? null,
    p_profile_ids: opts.profileIds ?? null,
  });
  if (error) {
    console.error('[metrics-windowed] creator_metrics_windowed', error);
    return [];
  }
  // Archived platforms (e.g. rednote) are excluded inside the RPC's
  // scope_profile, before aggregation — so a multi-platform creator keeps their
  // visible-platform totals and primary platform is never 'rednote'.
  return (data ?? []).map(
    (r: Record<string, unknown>): CreatorMetricWindowRow => ({
      creatorId: r.creator_id as string,
      displayName: (r.display_name as string | null) ?? null,
      avatarUrl: (r.avatar_url as string | null) ?? null,
      primaryPlatform: (r.primary_platform as string | null) ?? null,
      primaryHandle: (r.primary_handle as string | null) ?? null,
      followers: toNum(r.followers),
      followersDelta: toNum(r.followers_delta),
      viewsGained: toNum(r.views_gained),
      engagement: r.engagement == null ? null : toNum(r.engagement),
      postCount: toNum(r.post_count),
      insufficient: Boolean(r.insufficient),
    }),
  );
}

/**
 * Top posts by views_gained in the window. Returns [] on error (logged).
 */
export async function getTopContentWindowed(
  window: MetricWindow,
  opts: TopContentOpts = {},
): Promise<TopContentRow[]> {
  const sb = opts.client ?? getSupabaseRead();
  const { data, error } = await sb.rpc('top_content_windowed', {
    p_window: window,
    p_limit: opts.limit ?? 20,
    p_creator_ids: opts.creatorIds ?? null,
    p_profile_ids: opts.profileIds ?? null,
  });
  if (error) {
    console.error('[metrics-windowed] top_content_windowed', error);
    return [];
  }
  // Archived-platform posts are excluded inside the RPC before ORDER BY/LIMIT,
  // so the top-N is filled entirely with visible content (no short results).
  return (data ?? []).map(
    (r: Record<string, unknown>): TopContentRow => ({
      externalPostId: r.external_post_id as string,
      profileId: r.profile_id as string,
      creatorId: r.creator_id as string,
      creatorName: (r.creator_name as string | null) ?? null,
      platform: r.platform as string,
      handle: (r.handle as string | null) ?? null,
      captionExcerpt: (r.caption_excerpt as string | null) ?? null,
      thumbnailUrl: resolveMediaUrl((r.media_url as string | null) ?? null),
      postedAt: (r.posted_at as string | null) ?? null,
      viewsGained: toNum(r.views_gained),
      currentViews: toNum(r.current_views),
      likes: toNum(r.likes),
      comments: toNum(r.comments),
      shares: toNum(r.shares),
      // Other platforms this same content ran on (cross-platform dedup, RPC-side).
      // Empty array (singleton) → undefined so the UI's `alsoOn?.length` guard is clean.
      alsoOn:
        Array.isArray(r.also_on) && r.also_on.length ? (r.also_on as string[]) : undefined,
    }),
  );
}

/**
 * key → window-key → Σ total views of posts published in that window. Window
 * keys match the dashboard pills ('1d'/'1w'/'1m'/'3m'/'6m'/'12m'/'lifetime').
 * A key/window with no posts is simply absent — callers treat missing as 0.
 */
export type DashboardViewTotals = Record<string, Record<string, number>>;

/** Both rollups of the per-(creator × platform × window) view totals. */
export interface DashboardWindowedViews {
  /** platform-key | 'all' → window → Σ views across creators (hero + breakdown). */
  byPlatform: DashboardViewTotals;
  /** creatorId → platform-key | 'all' → window → views (Top Creators re-rank). */
  byCreator: Record<string, DashboardViewTotals>;
}

/**
 * Windowed view totals for the public dashboard — Σ views of posts PUBLISHED in
 * each window (content-recency, not a growth delta), per creator × platform
 * (dashboard_view_totals_windowed RPC, one round trip). Rolled up two ways:
 * `byPlatform` (Σ creators) powers the hero + breakdown; `byCreator` powers the
 * Top Creators ranking. Both carry a synthetic 'all' bucket. Returns empty maps
 * on error (logged) so the dashboard falls back to cumulative totals.
 */
export async function getDashboardViewTotalsWindowed(
  opts: WindowedMetricsOpts = {},
): Promise<DashboardWindowedViews> {
  const sb = opts.client ?? getSupabaseRead();
  const { data, error } = await sb.rpc('dashboard_view_totals_windowed', {
    p_creator_ids: opts.creatorIds ?? null,
  });
  if (error) {
    console.error('[metrics-windowed] dashboard_view_totals_windowed', error);
    return { byPlatform: {}, byCreator: {} };
  }
  const byPlatform: DashboardViewTotals = {};
  const byCreator: Record<string, DashboardViewTotals> = {};
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    const creatorId = row.creator_id as string;
    const platform = row.platform as string;
    const win = row.win as string;
    if (!creatorId || !platform || !win) continue;
    const total = toNum(row.total_views);

    // Per-platform rollup (Σ creators) + synthetic 'all'.
    if (!byPlatform[platform]) byPlatform[platform] = {};
    byPlatform[platform][win] = (byPlatform[platform][win] ?? 0) + total;
    if (!byPlatform.all) byPlatform.all = {};
    byPlatform.all[win] = (byPlatform.all[win] ?? 0) + total;

    // Per-creator: per platform + 'all' (Σ this creator's platforms).
    if (!byCreator[creatorId]) byCreator[creatorId] = {};
    const c = byCreator[creatorId];
    if (!c[platform]) c[platform] = {};
    c[platform][win] = (c[platform][win] ?? 0) + total;
    if (!c.all) c.all = {};
    c.all[win] = (c.all[win] ?? 0) + total;
  }
  return { byPlatform, byCreator };
}
