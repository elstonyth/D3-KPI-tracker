import {
  validateEmail,
  validatePassword,
  validateDisplayName,
  PASSWORD_MAX_BYTES,
} from './account-validation';

describe('validateEmail', () => {
  it('lowercases and trims', () => {
    expect(validateEmail('  A@B.Co ')).toEqual({ ok: true, value: 'a@b.co' });
  });
  it('rejects a missing @', () => {
    expect(validateEmail('nope').ok).toBe(false);
  });
  it('rejects an over-long address', () => {
    expect(validateEmail('a'.repeat(250) + '@b.co').ok).toBe(false);
  });
});

describe('validatePassword', () => {
  it('rejects fewer than 8 chars', () => {
    expect(validatePassword('short').ok).toBe(false);
  });
  it('rejects more than 72 bytes', () => {
    expect(validatePassword('x'.repeat(PASSWORD_MAX_BYTES + 1)).ok).toBe(false);
  });
  it('keeps intentional internal/edge spaces', () => {
    expect(validatePassword(' pass word ')).toEqual({ ok: true, value: ' pass word ' });
  });
});

describe('validateDisplayName', () => {
  const RLO = String.fromCharCode(0x202e); // right-to-left override (bidi spoof)
  const ZWSP = String.fromCharCode(0x200b); // zero-width space
  it('strips bidi-override and zero-width chars', () => {
    expect(validateDisplayName(`a${RLO}${ZWSP}b`)).toEqual({ ok: true, value: 'ab' });
  });
  it('collapses internal whitespace', () => {
    expect(validateDisplayName('  a   b  ')).toEqual({ ok: true, value: 'a b' });
  });
  it('rejects names longer than 80', () => {
    expect(validateDisplayName('n'.repeat(81)).ok).toBe(false);
  });
  it('rejects whitespace-only', () => {
    expect(validateDisplayName('   ').ok).toBe(false);
  });
});
