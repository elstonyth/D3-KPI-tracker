/**
 * /me time-window query-param helpers. `import type` only — no runtime import
 * of metrics-windowed (which pulls supabase-server) so this stays unit-testable.
 */
import type { MetricWindow } from './metrics-windowed';

const WINDOWS: readonly MetricWindow[] = ['7d', '30d', '90d', 'lifetime'];

export const WINDOW_LABEL: Record<MetricWindow, string> = {
  '7d': '7D',
  '30d': '30D',
  '90d': '90D',
  lifetime: 'Lifetime',
};

/** Read + validate the ?window= query param. Unknown/missing → '30d'. */
export function parseWindowParam(params: { window?: string }): MetricWindow {
  const w = params.window ?? '';
  return (WINDOWS as readonly string[]).includes(w) ? (w as MetricWindow) : '30d';
}
