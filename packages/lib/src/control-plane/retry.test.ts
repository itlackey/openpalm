import { describe, expect, it } from 'bun:test';
import { retry } from './retry.js';

/** A sleep stub that records the delays it was asked to wait, without waiting. */
function fakeSleep() {
  const calls: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { calls, sleep };
}

describe('retry', () => {
  it('returns the result on the first try without sleeping', async () => {
    const { calls, sleep } = fakeSleep();
    let attempts = 0;
    const result = await retry(async () => {
      attempts++;
      return 'ok';
    }, { delays: [0, 10, 10], sleep });

    expect(result).toBe('ok');
    expect(attempts).toBe(1);
    expect(calls).toEqual([]); // delays[0] is 0, and success stops further attempts
  });

  it('retries after a failure and then succeeds', async () => {
    const { calls, sleep } = fakeSleep();
    let attempts = 0;
    const result = await retry(async () => {
      attempts++;
      if (attempts < 3) throw new Error(`fail ${attempts}`);
      return attempts;
    }, { delays: [0, 100, 200], sleep });

    expect(result).toBe(3);
    expect(attempts).toBe(3);
    // Waited before attempt 2 (100) and attempt 3 (200); never before attempt 1.
    expect(calls).toEqual([100, 200]);
  });

  it('rethrows the last error after exhausting all attempts', async () => {
    const { sleep } = fakeSleep();
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts++;
        throw new Error(`fail ${attempts}`);
      }, { delays: [0, 5, 5], sleep }),
    ).rejects.toThrow('fail 3');
    expect(attempts).toBe(3);
  });

  it('respects the delay count (attempts == delays.length)', async () => {
    const { calls, sleep } = fakeSleep();
    let attempts = 0;
    await expect(
      retry(async () => {
        attempts++;
        throw new Error('nope');
      }, { delays: [0, 1, 2, 3], sleep }),
    ).rejects.toThrow('nope');

    expect(attempts).toBe(4);
    // A positive delay is applied before every attempt except the first (0).
    expect(calls).toEqual([1, 2, 3]);
  });
});
