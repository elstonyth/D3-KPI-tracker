// Sentry initialization for the Node.js server runtime.
// Loaded by instrumentation.ts when NEXT_RUNTIME === "nodejs".
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';

import { scrubEvent } from './src/lib/sentry-scrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,

  // 100% of traces in development, 10% in production.
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,

  // Attach local variable values to stack frames in development only. In
  // production these frames can contain secrets (service-role key, CRON_SECRET),
  // so they are not collected. See ARCHITECTURE_REVIEW.md finding C1.
  includeLocalVariables: process.env.NODE_ENV === 'development',

  enableLogs: true,

  // Do not auto-attach IP / request headers (cookies, auth) to events.
  sendDefaultPii: false,

  // Redact any secrets/PII that still reach an event before it is sent.
  beforeSend: scrubEvent,
});
