/** Small exception-retry primitive shared across the control plane. */

export interface RetryOptions {
  /**
   * Per-attempt delay schedule. The array length is the number of attempts;
   * `delays[i]` is the delay applied *before* attempt `i` (so `delays[0]` is
   * typically `0` — no wait before the first try). A non-positive delay is
   * skipped entirely.
   */
  delays: number[];
  /** Injectable sleep (defaults to `setTimeout`); overridden in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run `fn` with bounded retries on a fixed delay schedule.
 *
 * `fn` is attempted `delays.length` times. Before attempt `i` the helper waits
 * `delays[i]` ms (skipped when `<= 0`). A returned value resolves immediately; a
 * thrown error is swallowed and the next attempt is made. When every attempt has
 * thrown, the *last* error is rethrown.
 *
 * This is an exception-retry primitive: only thrown errors trigger a retry. Poll
 * loops that branch on a returned *value* (rather than throwing) are a different
 * shape and are intentionally not modeled here.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.delays.length; attempt++) {
    if (opts.delays[attempt] > 0) await sleep(opts.delays[attempt]);
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
