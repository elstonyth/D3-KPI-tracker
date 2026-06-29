import type { ErrorEvent } from '@sentry/nextjs';

import { scrubEvent } from './sentry-scrub';

function fakeEvent(): ErrorEvent {
  return {
    request: {
      headers: {
        Cookie: 'sb-access-token=secret-session; other=1',
        Authorization: 'Bearer eyJ-super-secret',
        'set-cookie': 'sb-refresh-token=refresh-secret',
        'user-agent': 'jest',
      },
      cookies: { 'sb-access-token': 'secret-session' },
    },
    exception: {
      values: [
        {
          stacktrace: {
            frames: [
              {
                vars: {
                  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-value',
                  CRON_SECRET: 'cron-secret-value',
                  password: 'hunter2',
                  safeVar: 'keep-me',
                },
              },
            ],
          },
        },
      ],
    },
  } as unknown as ErrorEvent;
}

describe('scrubEvent', () => {
  it('redacts sensitive request headers', () => {
    const out = scrubEvent(fakeEvent());
    const headers = out.request?.headers ?? {};
    expect(headers['Cookie']).toBe('[Redacted]');
    expect(headers['Authorization']).toBe('[Redacted]');
    expect(headers['set-cookie']).toBe('[Redacted]');
    // non-sensitive headers are preserved
    expect(headers['user-agent']).toBe('jest');
  });

  it('drops request cookies', () => {
    const out = scrubEvent(fakeEvent());
    expect(out.request?.cookies).toBeUndefined();
  });

  it('redacts secret-named frame-local variables', () => {
    const out = scrubEvent(fakeEvent());
    const vars = out.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars ?? {};
    expect(vars['SUPABASE_SERVICE_ROLE_KEY']).toBe('[Redacted]');
    expect(vars['CRON_SECRET']).toBe('[Redacted]');
    expect(vars['password']).toBe('[Redacted]');
    // non-secret locals are preserved
    expect(vars['safeVar']).toBe('keep-me');
  });
});
