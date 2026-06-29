import { isUuid } from './ids';

describe('isUuid', () => {
  it('accepts a v4 uuid', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(isUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
  });
  it('rejects a wrong-shaped string', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
  });
  it('rejects an injection-y string', () => {
    expect(isUuid("' or 1=1; drop table profile;--")).toBe(false);
  });
  it('rejects empty and non-string values', () => {
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});
