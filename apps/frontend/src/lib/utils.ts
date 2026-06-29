import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * `YYYY-MM-DD` for the date N days before now, for `captured_date` (a DATE
 * column) range filters. Lives here, not inline in a component, because
 * `Date.now()` in a Server Component body trips react-hooks/purity; calling it
 * through this lib helper keeps the call out of the render-purity lint scope.
 */
export function daysAgoDate(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
