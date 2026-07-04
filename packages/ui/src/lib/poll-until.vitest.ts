import { describe, expect, test } from 'vitest';
import { pollUntil } from './poll-until.js';

/** Deterministic clock: `sleep` advances the virtual time `now` reads. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('pollUntil', () => {
  test('resolves with the first value satisfying the predicate', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await pollUntil(
      async () => ++calls,
      (n) => n >= 3,
      { intervalMs: 100, deadlineMs: 10_000, now: clock.now, sleep: clock.sleep },
    );
    expect(result.timedOut).toBe(false);
    expect(result.value).toBe(3);
    expect(calls).toBe(3);
  });

  test('sleeps intervalMs before each poll', async () => {
    const clock = fakeClock();
    const observed: number[] = [];
    await pollUntil(
      async () => {
        observed.push(clock.now());
        return true;
      },
      (v) => v === true,
      { intervalMs: 250, deadlineMs: 10_000, now: clock.now, sleep: clock.sleep },
    );
    // First fetch happens after one interval, not at t=0.
    expect(observed).toEqual([250]);
  });

  test('returns timedOut once the deadline passes', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await pollUntil(
      async () => ++calls,
      () => false,
      { intervalMs: 100, deadlineMs: 250, now: clock.now, sleep: clock.sleep },
    );
    expect(result.timedOut).toBe(true);
    expect(result.value).toBeUndefined();
    // now: 0<250 poll(100), 100<250 poll(200), 200<250 poll(300), 300<250 stop.
    expect(calls).toBe(3);
  });

  test('does not poll at all when the deadline is already zero', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await pollUntil(
      async () => ++calls,
      () => true,
      { intervalMs: 100, deadlineMs: 0, now: clock.now, sleep: clock.sleep },
    );
    expect(result.timedOut).toBe(true);
    expect(calls).toBe(0);
  });
});
