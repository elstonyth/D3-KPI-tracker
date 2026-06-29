import { parseWindowParam, WINDOW_LABEL } from './me-window';

describe('parseWindowParam', () => {
  it('passes through each valid window', () => {
    expect(parseWindowParam({ window: '7d' })).toBe('7d');
    expect(parseWindowParam({ window: '30d' })).toBe('30d');
    expect(parseWindowParam({ window: '90d' })).toBe('90d');
    expect(parseWindowParam({ window: 'lifetime' })).toBe('lifetime');
  });
  it('defaults to 30d when missing', () => {
    expect(parseWindowParam({})).toBe('30d');
  });
  it('defaults to 30d for junk or empty', () => {
    expect(parseWindowParam({ window: 'yesterday' })).toBe('30d');
    expect(parseWindowParam({ window: '' })).toBe('30d');
  });
});

describe('WINDOW_LABEL', () => {
  it('labels every window', () => {
    expect(WINDOW_LABEL['7d']).toBe('7D');
    expect(WINDOW_LABEL['30d']).toBe('30D');
    expect(WINDOW_LABEL['90d']).toBe('90D');
    expect(WINDOW_LABEL.lifetime).toBe('Lifetime');
  });
});
