import { withTimeout, TimeoutError } from './with-timeout';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withTimeout', () => {
  it('resolves with the value when the promise settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });

  it('rejects with TimeoutError when the promise is slower than the timeout', async () => {
    const slow = delay(50).then(() => 'late');
    await expect(withTimeout(slow, 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('propagates the original rejection when the promise rejects before the timeout', async () => {
    // The real scrape error must survive so the caller can map it to the right
    // ScrapeError status, not have it masked by a TimeoutError.
    const boom = Promise.reject(new Error('scrape failed'));
    await expect(withTimeout(boom, 50)).rejects.toThrow('scrape failed');
  });

  it('does not emit an unhandledRejection when the loser rejects after the timeout', async () => {
    const handler = jest.fn();
    process.on('unhandledRejection', handler);
    try {
      const slowReject = new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('late upstream error')), 20),
      );
      await expect(withTimeout(slowReject, 5)).rejects.toBeInstanceOf(TimeoutError);
      await delay(40); // let `slowReject` reject well after the race already settled
      expect(handler).not.toHaveBeenCalled();
    } finally {
      // Always remove the listener, even if an assertion above throws, so it
      // can't leak into later tests.
      process.off('unhandledRejection', handler);
    }
  });
});
