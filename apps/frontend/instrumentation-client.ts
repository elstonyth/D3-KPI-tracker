// Sentry initialization for the browser/client runtime.
// Loaded automatically by Next.js for the client bundle.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';

import { scrubEvent } from './src/lib/sentry-scrub';

// Authenticated routes whose sessions must never be recorded by Session Replay
// (private creator/admin dashboards). See ARCHITECTURE_REVIEW.md finding C1.
const AUTHED_ROUTE = /^\/(me|admin)(\/|$)/;
const isAuthedRoute = (path: string) => AUTHED_ROUTE.test(path);

const authedAtLoad =
  typeof window !== 'undefined' && isAuthedRoute(window.location.pathname);

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Replay is omitted entirely when the page first loads on an authed route.
  integrations: authedAtLoad ? [] : [Sentry.replayIntegration()],

  // 100% of traces in development, 10% in production.
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,

  // Session Replay: 10% of all sessions, 100% of sessions with an error —
  // but 0% on authenticated routes.
  replaysSessionSampleRate: authedAtLoad ? 0 : 0.1,
  replaysOnErrorSampleRate: authedAtLoad ? 0 : 1.0,

  enableLogs: true,

  // Do not auto-attach IP / request headers (cookies, auth) to events.
  sendDefaultPii: false,

  // Redact any secrets/PII that still reach an event before it is sent.
  beforeSend: scrubEvent,
});

// Instruments App Router client-side navigation transitions, and stops Session
// Replay when navigating into an authenticated route (the load-time guard above
// cannot catch client-side SPA navigation).
export function onRouterTransitionStart(
  ...args: Parameters<typeof Sentry.captureRouterTransitionStart>
): ReturnType<typeof Sentry.captureRouterTransitionStart> {
  const href = args[0];
  try {
    const path = new URL(href, window.location.origin).pathname;
    if (isAuthedRoute(path)) {
      Sentry.getReplay()?.stop();
    }
  } catch {
    // Ignore malformed hrefs — never block navigation instrumentation.
  }
  return Sentry.captureRouterTransitionStart(...args);
}
