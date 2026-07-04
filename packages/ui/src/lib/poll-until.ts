/**
 * Shared polling helper. Repeatedly calls `fetchFn` on a fixed interval
 * until `predicate` accepts a fetched value or the deadline elapses.
 *
 * Timing is injectable (`now` / `sleep`) so the loop is deterministic in
 * tests — pass a fake clock instead of relying on real timers. Consolidates
 * the hand-rolled `while (Date.now() < deadline)` loops that previously lived
 * in VoiceTab, the admin container status page, and the setup deploy flow.
 *
 * The loop sleeps `intervalMs` BEFORE each poll (it never fetches at t=0),
 * matching the original voice-job behaviour where the initial state is already
 * known from the triggering response.
 */
export interface PollUntilOptions {
  /** Delay between polls, in ms. Applied before every fetch. */
  intervalMs: number;
  /** Give up this many ms after polling starts. */
  deadlineMs: number;
  /** Clock source; defaults to `Date.now`. Inject for tests. */
  now?: () => number;
  /** Sleep implementation; defaults to `setTimeout`. Inject for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type PollUntilResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true; value: undefined };

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function pollUntil<T>(
  fetchFn: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: PollUntilOptions,
): Promise<PollUntilResult<T>> {
  const { intervalMs, deadlineMs } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + deadlineMs;
  while (now() < deadline) {
    await sleep(intervalMs);
    const value = await fetchFn();
    if (predicate(value)) return { timedOut: false, value };
  }
  return { timedOut: true, value: undefined };
}
