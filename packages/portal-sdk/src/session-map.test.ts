/**
 * SessionReuseMap — the client-side session-reuse cache used when
 * PORTAL_SESSION_REUSE=client, which is the default because Guardian has no
 * server-side reuse cache. Explicit server mode leaves this map unconstructed
 * for deployments that provide their own authoritative reuse implementation.
 */
import { describe, expect, test } from 'bun:test';
import { SessionReuseMap } from './session-map.ts';

describe('SessionReuseMap', () => {
  test('returns undefined for an unknown key', () => {
    const map = new SessionReuseMap({ ttlMs: 1000, maxSize: 10 });
    expect(map.get('k')).toBeUndefined();
  });

  test('returns the stored sessionId within the TTL', () => {
    const map = new SessionReuseMap({ ttlMs: 1000, maxSize: 10 });
    map.set('k', 's1');
    expect(map.get('k')).toBe('s1');
  });

  test('expires entries after ttlMs', async () => {
    const map = new SessionReuseMap({ ttlMs: 10, maxSize: 10 });
    map.set('k', 's1');
    await Bun.sleep(25);
    expect(map.get('k')).toBeUndefined();
  });

  test('a hit refreshes the TTL', () => {
    const originalNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const map = new SessionReuseMap({ ttlMs: 40, maxSize: 10 });
      map.set('k', 's1');
      now += 25;
      expect(map.get('k')).toBe('s1'); // hit, refreshes expiry
      now += 25;
      // 50 ms after the original set, but only 25 ms after the refreshed hit —
      // still alive because the hit refreshed the 40 ms TTL.
      expect(map.get('k')).toBe('s1');
    } finally {
      Date.now = originalNow;
    }
  });

  test('evicts the oldest entry beyond maxSize', () => {
    const map = new SessionReuseMap({ ttlMs: 10_000, maxSize: 2 });
    map.set('k1', 's1');
    map.set('k2', 's2');
    map.set('k3', 's3');
    expect(map.get('k1')).toBeUndefined();
    expect(map.get('k2')).toBe('s2');
    expect(map.get('k3')).toBe('s3');
    expect(map.size).toBe(2);
  });

  test('evictBySessionId removes every key mapped to that session', () => {
    const map = new SessionReuseMap({ ttlMs: 10_000, maxSize: 10 });
    map.set('k1', 's1');
    map.set('k2', 's1');
    map.set('k3', 's2');
    map.evictBySessionId('s1');
    expect(map.get('k1')).toBeUndefined();
    expect(map.get('k2')).toBeUndefined();
    expect(map.get('k3')).toBe('s2');
  });
});
