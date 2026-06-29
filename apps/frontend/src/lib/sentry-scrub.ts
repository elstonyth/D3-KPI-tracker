import type { ErrorEvent } from '@sentry/nextjs';

// Runtime-agnostic (browser / node / edge safe — no Node APIs) scrubber for
// Sentry events. Used as `beforeSend` so secrets and PII never leave the app:
// the service-role key, CRON_SECRET, session cookies and auth headers must not
// be transmitted to Sentry. See ARCHITECTURE_REVIEW.md finding C1.

const REDACTED = '[Redacted]';

// Request headers stripped wholesale.
const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$/i;

// Any object key whose name matches is redacted, anywhere in the event
// (notably stack-frame local variables when includeLocalVariables is on).
const SECRET_KEY = /(SERVICE_ROLE|SECRET|KEY|TOKEN|PASSWORD|COOKIE|AUTH)/i;

function redactByKeyName(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (const item of value) redactByKeyName(item, seen);
    return;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SECRET_KEY.test(key)) {
      obj[key] = REDACTED;
    } else {
      redactByKeyName(obj[key], seen);
    }
  }
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const request = event.request;
  if (request) {
    if (request.headers) {
      const headers = request.headers as Record<string, string>;
      for (const key of Object.keys(headers)) {
        if (SENSITIVE_HEADER.test(key)) headers[key] = REDACTED;
      }
    }
    // Drop parsed cookies entirely — they carry session tokens.
    if ('cookies' in request) {
      delete (request as { cookies?: unknown }).cookies;
    }
  }

  // Redact secret-named values wherever they appear (frame vars, extra, contexts).
  redactByKeyName(event, new WeakSet());

  return event;
}
