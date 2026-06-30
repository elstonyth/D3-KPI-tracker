/**
 * 7/30/90-day range selector for the admin creator KPI section. `?days=` URL
 * param; unknown/missing → 30. No runtime imports so it stays unit-testable.
 */
export type DaysOption = 7 | 30 | 90;

export const DAYS_VALUES: readonly DaysOption[] = [7, 30, 90];

export const DAYS_LABEL: Record<DaysOption, string> = {
  7: '7D',
  30: '30D',
  90: '90D',
};

/** Read + validate the ?days= query param. Unknown/missing → 30. */
export function parseDaysParam(params: { days?: string }): DaysOption {
  const n = Number(params.days);
  return (DAYS_VALUES as readonly number[]).includes(n)
    ? (n as DaysOption)
    : 30;
}
