/**
 * Per-process serial queues, keyed by caller-chosen string.
 *
 * Two concurrent calls with the same key run sequentially (the second
 * awaits the first). Different keys are independent. Failures don't
 * poison the chain — the next caller gets a fresh promise.
 *
 * Use for admin routes that run docker compose work (compose up / pull /
 * restart). Concurrent --force-recreate invocations against the same
 * project kill each other's containers mid-healthcheck; the queue
 * prevents that.
 */
const queues = new Map<string, Promise<unknown>>();

export function withSerialQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  // Don't leak prior rejections into the chain.
  queues.set(key, next.catch(() => undefined));
  return next;
}

/** For tests only — clear the queue table. */
export function _resetSerialQueues(): void {
  queues.clear();
}
