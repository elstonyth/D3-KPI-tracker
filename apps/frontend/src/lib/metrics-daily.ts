/**
 * Typed access to the creator_daily_kpis RPC. Thin pass-through (mirrors
 * metrics-windowed.ts): call the RPC, map rows, return [] on error (logged).
 *
 * The RPC is service-role only, so the admin caller MUST inject the service-role
 * client (getSupabaseAdmin()). The anon read client would get permission denied
 * and fall back to [].
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseRead } from './supabase-server';

export interface CreatorDailyKpiRow {
  /** ISO date (YYYY-MM-DD). */
  day: string;
  followersTotal: number;
  followersGained: number;
  viewsTotal: number;
  viewsGained: number;
  /** No prior-day baseline yet — render deltas as "—", not a spike. */
  insufficient: boolean;
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
  opts: { client?: SupabaseClient } = {},
): Promise<CreatorDailyKpiRow[]> {
  const sb = opts.client ?? getSupabaseRead();
  const { data, error } = await sb.rpc('creator_daily_kpis', {
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
      viewsTotal: toNum(r.views_total),
      viewsGained: toNum(r.views_gained),
      insufficient: Boolean(r.insufficient),
    }),
  );
}
