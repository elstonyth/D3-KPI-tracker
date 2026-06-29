import { normalizeProvisionUrls } from './provision-plan';

describe('normalizeProvisionUrls', () => {
  it('trims entries and drops blanks/whitespace-only', () => {
    expect(normalizeProvisionUrls(['  https://a.com  ', '', '   '])).toEqual(['https://a.com']);
  });
  it('de-duplicates case-insensitively, preserving first-seen order', () => {
    expect(
      normalizeProvisionUrls(['https://A.com', 'https://b.com', 'https://a.com']),
    ).toEqual(['https://A.com', 'https://b.com']);
  });
  it('returns an empty array for empty input', () => {
    expect(normalizeProvisionUrls([])).toEqual([]);
  });
});
