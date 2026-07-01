/**
 * Typed access to the creator_daily_kpis RPC. Thin pass-through (mirrors
 * metrics-windowed.ts): call the RPC, map rows, return [] on error (logged).
 *
 * The RPC is service-role only, so the caller MUST inject the service-role
 * client (getSupabaseAdmin()). `client` is required — a missing admin client is
 * a wiring bug, not "no data", so we don't fall back to the anon read client
 * (which would get permission-denied and silently return []).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CreatorDailyKpiRow {
  /** ISO date (YYYY-MM-DD). */
  day: string;
  followersTotal: number;
  followersGained: number;
  /** No prior-day follower baseline — render the follower delta as "—". */
  followersInsufficient: boolean;
  viewsTotal: number;
  viewsGained: number;
  /** No prior-day view baseline (views may start after followers) — render the
   *  view delta as "—". */
  viewsInsufficient: boolean;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getCreatorDailyKpis(
  creatorId: string,
  days: number,
  opts: { client: SupabaseClient },
): Promise<CreatorDailyKpiRow[]> {
  const { data, error } = await opts.client.rpc('creator_daily_kpis', {
    p_creator_id: creatorId,
    p_days: days,
  });
  if (error) {
    console.error('[metrics-daily] creator_daily_kpis', error);
    return [];
  }
  return (data ?? []).map(
    (r: Record<string, unknown>): CreatorDailyKpiRow => ({
      day: String(r.day),
      followersTotal: toNum(r.followers_total),
      followersGained: toNum(r.followers_gained),
      followersInsufficient: Boolean(r.followers_insufficient),
      viewsTotal: toNum(r.views_total),
      viewsGained: toNum(r.views_gained),
      viewsInsufficient: Boolean(r.views_insufficient),
    }),
  );
}
