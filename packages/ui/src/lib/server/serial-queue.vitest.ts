/**
 * Tests for withSerialQueue — per-process per-key serial execution helper.
 *
 * Verifies:
 *  1. Same-key calls run sequentially (the second starts only after the first finishes).
 *  2. Different-key calls run concurrently (do not block each other).
 *  3. A failing run does NOT poison the chain — subsequent callers resolve on their own merits.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { _resetSerialQueues, withSerialQueue } from './serial-queue.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  _resetSerialQueues();
});

describe('withSerialQueue', () => {
  test('same-key calls run sequentially', async () => {
    const events: string[] = [];

    const first = withSerialQueue('same', async () => {
      events.push('1-start');
      await sleep(50);
      events.push('1-end');
      return 'first';
    });

    // Kick off the second immediately (no await) so both are pending at once.
    const second = withSerialQueue('same', async () => {
      events.push('2-start');
      await sleep(10);
      events.push('2-end');
      return 'second';
    });

    const [r1, r2] = await Promise.all([first, second]);

    expect(r1).toBe('first');
    expect(r2).toBe('second');
    // If serialized, the second must not start until the first ends.
    expect(events).toEqual(['1-start', '1-end', '2-start', '2-end']);
  });

  test('different-key calls run concurrently', async () => {
    const events: string[] = [];

    const a = withSerialQueue('key-a', async () => {
      events.push('a-start');
      await sleep(50);
      events.push('a-end');
      return 'a';
    });

    const b = withSerialQueue('key-b', async () => {
      events.push('b-start');
      await sleep(50);
      events.push('b-end');
      return 'b';
    });

    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toBe('a');
    expect(rb).toBe('b');
    // Concurrent: both should start before either ends.
    expect(events.slice(0, 2).sort()).toEqual(['a-start', 'b-start']);
    expect(events.slice(2).sort()).toEqual(['a-end', 'b-end']);
  });

  test('a failing run does not poison the queue', async () => {
    const failing = withSerialQueue('poison', async () => {
      throw new Error('boom');
    });

    await expect(failing).rejects.toThrow('boom');

    // The next caller with the same key should still get its own result.
    const result = await withSerialQueue('poison', async () => 42);
    expect(result).toBe(42);

    // And a third one queued on top works too.
    const result2 = await withSerialQueue('poison', async () => 'ok');
    expect(result2).toBe('ok');
  });

  test('failure mid-chain does not affect a queued successor', async () => {
    const failing = withSerialQueue('chain', async () => {
      await sleep(10);
      throw new Error('first failed');
    });

    // Queue the successor BEFORE the first rejects.
    const successor = withSerialQueue('chain', async () => 'survived');

    await expect(failing).rejects.toThrow('first failed');
    await expect(successor).resolves.toBe('survived');
  });
});
