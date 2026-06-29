/**
 * Shared 7D/30D/90D/Lifetime selector for /me. Pure server component:
 * URL-as-state via <Link href="/me?window=…"> tabs, no client JS. Active tab
 * carries the brand tint; the page server-renders for the chosen window.
 */
import Link from 'next/link';

import type { MetricWindow } from '@gitroom/frontend/lib/metrics-windowed';
import { WINDOW_LABEL } from '@gitroom/frontend/lib/me-window';

const WINDOWS: MetricWindow[] = ['7d', '30d', '90d', 'lifetime'];

export function WindowTabs({ current }: { current: MetricWindow }) {
  return (
    <nav className="flex flex-wrap items-center gap-2" aria-label="Time window">
      {WINDOWS.map((w) => {
        const active = w === current;
        return (
          <Link
            key={w}
            href={`/me?window=${w}`}
            scroll={false}
            aria-current={active ? 'page' : undefined}
            className={`text-caption px-3 py-1.5 rounded-full border transition-colors ${
              active
                ? 'bg-brand/10 text-fg border-brand/20'
                : 'bg-white/[0.04] text-fgMuted border-white/10 hover:text-fg'
            }`}
          >
            {WINDOW_LABEL[w]}
          </Link>
        );
      })}
    </nav>
  );
}
