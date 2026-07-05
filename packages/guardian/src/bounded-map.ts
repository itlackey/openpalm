/**
 * Shared bounded runtime-state helpers for the guardian.
 *
 * The guardian keeps several module-scoped Maps of ephemeral state (rate-limit
 * buckets, session/permission ownership, /oc reconnect buckets, reused-session
 * cache). They all reimplemented the same discipline: a keyed Map, a per-entry
 * timestamp (lastUsed / window start), a hard size cap with oldest-first
 * eviction, and an `.unref()`'d prune timer so the state never grows unbounded
 * and never holds the event loop open. This module factors that out into two
 * small, behaviour-preserving primitives:
 *
 *   - BoundedTtlMap<K,V>   — a Map with per-entry TTL, max-size oldest-first
 *                            eviction, and an optional unref'd prune interval.
 *   - FixedWindowLimiter   — fixed-window admission ("≤ limit per window per
 *                            key") with the same size cap + prune discipline.
 *
 * These are guardian-local runtime state helpers on purpose — NOT @openpalm/lib.
 */

type Timer = ReturnType<typeof setInterval>;

interface TtlEntry<V> {
  value: V;
  /** Wall-clock ms of the last write or touch; drives TTL + eviction order. */
  ts: number;
}

/**
 * A Map with per-entry TTL and a hard size cap.
 *
 * - `set` stamps the entry with the current time and enforces the size cap
 *   (oldest-first eviction) immediately.
 * - `get` lazily drops an entry that has outlived its TTL (returns undefined),
 *   and can optionally refresh the entry's timestamp on a live hit.
 * - `prune` drops all expired entries, then hard-caps oldest-first.
 * - An optional `pruneIntervalMs` installs an `.unref()`'d timer that calls
 *   `prune` periodically so idle state is reclaimed even without access.
 */
export class BoundedTtlMap<K, V> {
  private readonly store = new Map<K, TtlEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly timer?: Timer;

  constructor(opts: { ttlMs: number; maxSize: number; pruneIntervalMs?: number }) {
    this.ttlMs = opts.ttlMs;
    this.maxSize = opts.maxSize;
    if (opts.pruneIntervalMs && opts.pruneIntervalMs > 0) {
      this.timer = setInterval(() => this.prune(), opts.pruneIntervalMs);
      // unref() so the timer never holds the event loop open (cleaner test exit
      // + shutdown).
      this.timer.unref();
    }
  }

  private expired(entry: TtlEntry<V>, now: number): boolean {
    return now - entry.ts > this.ttlMs;
  }

  /** Insert/replace `key`, stamping it now, then enforce the size cap. */
  set(key: K, value: V): void {
    this.store.set(key, { value, ts: Date.now() });
    if (this.store.size > this.maxSize) this.prune();
  }

  /**
   * Return the value for `key`, or undefined if absent or expired (an expired
   * entry is deleted on access). When `touch` is true a live hit refreshes the
   * entry's timestamp so active keys are not pruned mid-use.
   */
  get(key: K, touch = false): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.expired(entry, Date.now())) {
      this.store.delete(key);
      return undefined;
    }
    if (touch) entry.ts = Date.now();
    return entry.value;
  }

  /** Refresh a live entry's timestamp (no-op if absent). */
  touch(key: K): void {
    const entry = this.store.get(key);
    if (entry) entry.ts = Date.now();
  }

  /** Delete a key unconditionally. */
  delete(key: K): void {
    this.store.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Raw entry count (includes not-yet-pruned expired entries, like a Map). */
  get size(): number {
    return this.store.size;
  }

  /** Iterate live (non-expired) `[key, value]` pairs. */
  *entries(): IterableIterator<[K, V]> {
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (!this.expired(entry, now)) yield [k, entry.value];
    }
  }

  /** Drop expired entries, then hard-cap oldest-first. */
  prune(): void {
    const now = Date.now();
    for (const [k, entry] of this.store) {
      if (this.expired(entry, now)) this.store.delete(k);
    }
    if (this.store.size > this.maxSize) {
      const sorted = [...this.store.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [k] of sorted.slice(0, sorted.length - this.maxSize)) this.store.delete(k);
    }
  }
}

interface WindowBucket {
  count: number;
  /** Wall-clock ms the current window opened. */
  start: number;
}

/**
 * Fixed-window admission control: at most `limit` calls per `windowMs` per key.
 *
 * NOTE: fixed-window (not sliding) — a caller can burst up to 2x across a window
 * boundary. Acceptable for the guardian's LAN-first use, secondary to HTTP
 * Basic + sha256 auth.
 *
 * Shares the same bounded discipline as BoundedTtlMap: a hard key cap with
 * oldest-first eviction and an optional `.unref()`'d prune timer. Buckets older
 * than the configured `windowMs` are treated as expired by `prune`.
 */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, WindowBucket>();
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly timer?: Timer;

  constructor(opts: { windowMs: number; maxKeys: number; pruneIntervalMs?: number }) {
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys;
    if (opts.pruneIntervalMs && opts.pruneIntervalMs > 0) {
      this.timer = setInterval(() => this.prune(), opts.pruneIntervalMs);
      this.timer.unref();
    }
  }

  /**
   * Admit or reject a call for `key`. Returns true while the key is within
   * `limit` for the current window. `windowMs` defaults to the configured
   * window but may be overridden per call (one limiter can serve several window
   * sizes — e.g. per-user vs per-portal buckets keyed apart).
   */
  allow(key: string, limit: number, windowMs: number = this.windowMs): boolean {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || now - b.start > windowMs) {
      this.buckets.set(key, { count: 1, start: now });
      if (this.buckets.size > this.maxKeys) this.prune();
      return true;
    }
    if (b.count >= limit) return false;
    b.count++;
    return true;
  }

  /** Raw bucket count. */
  get size(): number {
    return this.buckets.size;
  }

  /** Remove all buckets. */
  clear(): void {
    this.buckets.clear();
  }

  /**
   * Iterate every `[key, bucket]` pair (unfiltered — callers that classify by
   * per-key window do their own expiry check, mirroring the original code).
   */
  *entries(): IterableIterator<[string, WindowBucket]> {
    yield* this.buckets;
  }

  /** Drop buckets older than the configured window, then hard-cap oldest-first. */
  prune(): void {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      if (now - b.start > this.windowMs) this.buckets.delete(k);
    }
    if (this.buckets.size > this.maxKeys) {
      const sorted = [...this.buckets.entries()].sort((a, b) => a[1].start - b[1].start);
      for (const [k] of sorted.slice(0, sorted.length - this.maxKeys)) this.buckets.delete(k);
    }
  }
}
