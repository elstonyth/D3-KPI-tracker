'use client';

/**
 * Minimal SVG bar chart for daily-gained series. Zero baseline; negative values
 * (e.g. followers lost) draw below it in a muted tone. Brand-yellow positives.
 * Same visual language as Sparkline (fills width via preserveAspectRatio=none).
 */
import { useMemo } from 'react';
import clsx from 'clsx';

interface DailyBarsProps {
  values: number[];
  width?: number;
  height?: number;
  ariaLabel?: string;
  className?: string;
}

export function DailyBars({
  values,
  width = 800,
  height = 200,
  ariaLabel,
  className,
}: DailyBarsProps) {
  const geo = useMemo(() => {
    if (!values.length) return null;
    const max = Math.max(0, ...values);
    const min = Math.min(0, ...values);
    const range = max - min || 1;
    const padX = 8;
    const padTop = 12;
    const padBottom = 12;
    const w = width - padX * 2;
    const h = height - padTop - padBottom;
    const zeroY = padTop + (max / range) * h;
    const slot = w / values.length;
    const barW = Math.max(1, slot * 0.62);
    const bars = values.map((v, i) => {
      const x = padX + i * slot + (slot - barW) / 2;
      const vy = padTop + ((max - v) / range) * h;
      const positive = v >= 0;
      const y = positive ? vy : zeroY;
      // Zero days render as no bar (height 0) so "no change" doesn't look like
      // activity; non-zero values keep a 1px floor so small gains stay visible.
      const barH = v === 0 ? 0 : Math.max(1, Math.abs(vy - zeroY));
      return { x, y, barW, barH, positive };
    });
    return { bars, zeroY };
  }, [values, width, height]);

  if (!geo) return null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={clsx('w-full h-full block', className)}
      role="img"
      aria-label={ariaLabel}
    >
      <line
        x1="8"
        y1={geo.zeroY}
        x2={width - 8}
        y2={geo.zeroY}
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      {geo.bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width={b.barW}
          height={b.barH}
          fill={b.positive ? '#F2E600' : 'rgba(255,255,255,0.28)'}
        />
      ))}
    </svg>
  );
}
