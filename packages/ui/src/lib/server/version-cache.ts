/**
 * Server-side TTL cache for version lookups (Docker Hub, npm, GitHub releases).
 *
 * The admin UI server is a long-running host process, so a module-level
 * in-memory cache is the right granularity — it survives across requests but
 * never hits disk. The cache refreshes on app load (first request after server
 * start, when the cache is cold) and when the user clicks "Check for updates"
 * (which calls {@link invalidateVersionCache} before re-fetching). Between
 * refreshes, endpoints serve cached data so tab switches and polls do NOT hit
 * GitHub/npm/Docker Hub.
 *
 * Graceful degradation: when a fresh fetch fails, {@link withCache} serves the
 * stale cached value (if any) rather than blanking the response.
 */

/** Cache TTL — 5 minutes. The key behavior is cache-first, not a tight TTL. */
export const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { data: unknown; fetchedAt: number };

const cache = new Map<string, CacheEntry>();

/**
 * Return cached data if fresh (within TTL), or `undefined` if stale/missing.
 * `undefined` is the cache-miss sentinel — we never store `undefined` as a value
 * (cached null/empty-list are valid results from a successful-but-empty lookup).
 */
export function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return undefined;
  return entry.data as T;
}

/** Return cached data regardless of TTL (stale fallback for failed fetches). */
export function getStaleCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  return entry ? (entry.data as T) : undefined;
}

/** Store data with `fetchedAt = Date.now()`. */
export function setCached<T>(key: string, data: T): void {
  cache.set(key, { data, fetchedAt: Date.now() });
}

/** Clear ALL cache entries — called by the "Check for updates" refresh trigger. */
export function invalidateVersionCache(): void {
  cache.clear();
}

/**
 * Cache-first lookup with stale-on-error fallback.
 *
 * 1. If a fresh cache entry exists, return it (no upstream call).
 * 2. Otherwise, call `fetcher`. On success, cache + return the result.
 * 3. On failure, return the stale cached value if one exists, else `undefined`
 *    (the caller applies its own default — `null` / `[]` — for the no-data case).
 *
 * The fetcher SHOULD throw on failure so the stale fallback can engage; a
 * successful-but-empty result (null, `[]`) is cached as-is so a consistently
 * empty lookup is not re-fetched every call.
 */
export async function withCache<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<T | undefined> {
  const fresh = getCached<T>(key);
  if (fresh !== undefined) return fresh;
  try {
    const data = await fetcher();
    setCached(key, data);
    return data;
  } catch {
    return getStaleCached<T>(key);
  }
}

/** Exposed for tests — resets the module-level cache. */
export function _resetVersionCache(): void {
  cache.clear();
}
