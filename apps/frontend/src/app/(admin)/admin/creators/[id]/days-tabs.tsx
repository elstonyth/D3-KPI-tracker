import Link from 'next/link';
import {
  DAYS_VALUES,
  DAYS_LABEL,
  type DaysOption,
} from '@gitroom/frontend/lib/daily-window';

export function DaysTabs({
  creatorId,
  current,
}: {
  creatorId: string;
  current: DaysOption;
}) {
  return (
    <nav className="flex flex-wrap items-center gap-2" aria-label="KPI range">
      {DAYS_VALUES.map((d) => {
        const active = d === current;
        return (
          <Link
            key={d}
            href={`/admin/creators/${creatorId}?days=${d}`}
            scroll={false}
            aria-current={active ? 'page' : undefined}
            className={`text-caption px-3 py-1.5 rounded-full border transition-colors ${
              active
                ? 'bg-brand/10 text-fg border-brand/20'
                : 'bg-white/[0.04] text-fgMuted border-white/10 hover:text-fg'
            }`}
          >
            {DAYS_LABEL[d]}
          </Link>
        );
      })}
    </nav>
  );
}
