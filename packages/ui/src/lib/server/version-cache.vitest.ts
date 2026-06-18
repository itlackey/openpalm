/**
 * Tests for the server-side version cache (version-cache.ts).
 *
 * Verifies get/set/invalidate, TTL expiry, stale-on-error fallback, and that
 * null is a valid cached value (not a cache miss).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCached,
  getStaleCached,
  setCached,
  invalidateVersionCache,
  withCache,
  _resetVersionCache,
  CACHE_TTL_MS,
} from './version-cache.js';

beforeEach(() => {
  _resetVersionCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('version-cache — get/set/invalidate', () => {
  it('returns undefined for a missing key', () => {
    expect(getCached('missing')).toBeUndefined();
  });

  it('stores and returns cached data', () => {
    setCached('key', { value: 42 });
    expect(getCached<{ value: number }>('key')).toEqual({ value: 42 });
  });

  it('caches null as a valid value (not a miss)', () => {
    setCached<string | null>('nullable', null);
    expect(getCached<string | null>('nullable')).toBeNull();
  });

  it('caches empty array as a valid value', () => {
    setCached('empty', [] as string[]);
    expect(getCached<string[]>('empty')).toEqual([]);
  });

  it('invalidateVersionCache clears all entries', () => {
    setCached('a', 1);
    setCached('b', 2);
    invalidateVersionCache();
    expect(getCached('a')).toBeUndefined();
    expect(getCached('b')).toBeUndefined();
  });
});

describe('version-cache — TTL expiry', () => {
  it('returns undefined after TTL expires', () => {
    vi.useFakeTimers();
    setCached('key', 'data');
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    expect(getCached('key')).toBeUndefined();
  });

  it('returns data before TTL expires', () => {
    vi.useFakeTimers();
    setCached('key', 'data');
    vi.advanceTimersByTime(CACHE_TTL_MS - 1);
    expect(getCached('key')).toBe('data');
  });

  it('getStaleCached returns data even after TTL expires', () => {
    vi.useFakeTimers();
    setCached('key', 'data');
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    expect(getStaleCached('key')).toBe('data');
  });

  it('getStaleCached returns undefined when no entry exists', () => {
    expect(getStaleCached('never-set')).toBeUndefined();
  });
});

describe('version-cache — withCache', () => {
  it('returns cached data without calling fetcher', async () => {
    setCached('key', 'cached');
    const fetcher = vi.fn().mockResolvedValue('fresh');
    const result = await withCache('key', fetcher);
    expect(result).toBe('cached');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('calls fetcher on cache miss and caches the result', async () => {
    const fetcher = vi.fn().mockResolvedValue('fresh');
    const result = await withCache('key', fetcher);
    expect(result).toBe('fresh');
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second call should use cache — fetcher not called again.
    const result2 = await withCache('key', fetcher);
    expect(result2).toBe('fresh');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serves stale data when the fetcher throws (graceful degradation)', async () => {
    setCached('key', 'stale-good');
    // Expire the fresh cache so withCache tries to re-fetch.
    vi.useFakeTimers();
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    vi.useRealTimers();

    const fetcher = vi.fn().mockRejectedValue(new Error('upstream down'));
    const result = await withCache('key', fetcher);
    expect(result).toBe('stale-good');
  });

  it('returns undefined when fetcher throws and no stale cache exists', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('upstream down'));
    const result = await withCache('key', fetcher);
    expect(result).toBeUndefined();
  });

  it('caches null from a successful fetch (no re-fetch within TTL)', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    await withCache<string | null>('key', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second call returns cached null — fetcher not called.
    const result = await withCache<string | null>('key', fetcher);
    expect(result).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
