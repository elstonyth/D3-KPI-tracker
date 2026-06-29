import { BUILDING_HISTORY, formatWindowedValue } from './format-metric';

const fmt = (n: number) => `#${n}`;

describe('formatWindowedValue', () => {
  it('returns the building-history sentinel when insufficient', () => {
    expect(formatWindowedValue(true, 1234, fmt)).toBe(BUILDING_HISTORY);
  });
  it('formats the value when sufficient', () => {
    expect(formatWindowedValue(false, 1234, fmt)).toBe('#1234');
  });
  it('formats 0 (not building-history) when sufficient', () => {
    expect(formatWindowedValue(false, 0, fmt)).toBe('#0');
  });
  it('treats a null value as building-history even if not flagged', () => {
    expect(formatWindowedValue(false, null, fmt)).toBe(BUILDING_HISTORY);
  });
});
