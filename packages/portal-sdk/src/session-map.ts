/**
 * SessionReuseMap — the client-side session-reuse cache, constructed
 * whenever `sessionReuse` resolves to `'client'` — which is now the DEFAULT
 * (S4, #581 finding #6). Originally written for standalone use against a
 * plain OpenCode server that ignores the `x-openpalm-session-key` guardian
 * hint header, so a fresh `createSession` per turn would break multi-turn
 * conversations; it is now the default everywhere because no server-side
 * reuse cache exists on the guardian to be authoritative instead. (A prior
 * revision of this comment pointed at a `packages/guardian/src/session-target.ts`
 * as that cache; that module was never built — the guardian only ever
 * forwarded `POST /session` untouched, see `proxy.ts`'s `forwardSessionCreate`
 * — so every portal turn minted a brand-new session no matter this map's
 * state.)
 *
 * Authoritative-side rule (D2, #491): exactly one side owns session reuse per
 * deployment. This map is constructed ONLY in `'client'` mode; `'server'`
 * mode (opt-in via `PORTAL_SESSION_REUSE=server`) leaves this map
 * uninstantiated, for a deployment that has its OWN server-side reuse cache,
 * so the two can never run concurrently or disagree. Do not extend this map
 * to also apply in `server` mode — that would reintroduce the dual-authority
 * risk #433 resolved against.
 *
 * Plain `Map` with insertion-order (Map iteration order) oldest-first
 * eviction past `maxSize`; expiry is checked lazily on `get` (no timers —
 * the map is bounded by `maxSize`, so an unbounded background sweep isn't
 * needed).
 */
export type SessionReuseMapOptions = {
  ttlMs: number;
  maxSize: number;
};

type Entry = {
  sessionId: string;
  expiresAt: number;
};

export class SessionReuseMap {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: SessionReuseMapOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxSize = opts.maxSize;
  }

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    // A hit refreshes the TTL: delete + re-insert so the key also moves to
    // the most-recently-used end of Map iteration order (used by the
    // oldest-first eviction below).
    this.entries.delete(key);
    entry.expiresAt = Date.now() + this.ttlMs;
    this.entries.set(key, entry);
    return entry.sessionId;
  }

  set(key: string, sessionId: string): void {
    this.entries.delete(key);
    this.entries.set(key, { sessionId, expiresAt: Date.now() + this.ttlMs });
    while (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  evictBySessionId(sessionId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.sessionId === sessionId) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
