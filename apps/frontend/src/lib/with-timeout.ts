/**
 * Bound an un-cancelable async operation by wall-clock time.
 *
 * Resolves/rejects with `promise`, unless it fails to settle within `ms` — in
 * which case the returned promise rejects with {@link TimeoutError}.
 *
 * The snapshot cron uses this to cap each scrape: `runScraper` takes no
 * AbortSignal, so the underlying work cannot truly be canceled. This stops the
 * caller *waiting* on it, so one hung upstream can't consume the whole function
 * budget — treat a TimeoutError as "give up and move on". The abandoned work is
 * frozen when the serverless function returns.
 */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  // Defensively handle a late settlement from the race loser so it can never
  // surface as an unhandledRejection after `timeout` has already won.
  void promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
