/**
 * Guardian-LOCAL resource bounds for the /oc/* proxy (design §3.6).
 *
 * The allowlist and ownership gates stop forbidden calls, but the proxy adds new
 * held-open surfaces (the multiplexed /event stream) and new unbounded pressure
 * (reconnect loops and in-flight turns). This module bounds them. It is
 * guardian-local runtime state on purpose — mirroring rate-limit.ts /
 * ownership.ts (module-scoped Maps, an .unref()'d prune timer, hard size caps,
 * size getters for /stats) — NOT @openpalm/lib.
 *
 * Bounds implemented (each a NAMED constant with rationale):
 *   1. /event reconnect cap (§3.6 F4): ≤ OC_EVENT_RECONNECT_LIMIT opens per
 *      window per principal. A reconnect loop (mobile, gateway flaps) or an
 *      adversary must not be able to churn reconnections without bound.
 *   2. Concurrent /event streams per principal (§3.6): at most
 *      OC_EVENT_MAX_CONCURRENT_STREAMS open at once; a second open is rejected
 *      429 — the channel must close the first. Prevents unbounded held-open
 *      streams from one principal.
 *   3. In-flight turns per principal (§3.6): at most OC_MAX_INFLIGHT_TURNS
 *      concurrent prompt turns; the (OC_MAX_INFLIGHT_TURNS + 1)th is rejected
 *      429. Each turn carries a per-turn wall-clock cap (OC_TURN_WALL_CLOCK_MS);
 *      a sweep aborts (POST /session/{id}/abort) any turn that breaches it.
 *
 * The discrete per-user / per-channel CALL rate limits (≈120/min, ≈200/min) are
 * applied on the proxy path by reusing the existing rate-limit.ts `allow()` —
 * see proxy.ts. This module owns only the proxy-SPECIFIC bounds above.
 */

import { type Principal, principalKey } from "./ownership";

// ── Named constants (with rationale) ───────────────────────────────────────

/**
 * Max /event opens per principal per window. Loose by default: a healthy channel
 * holds ONE shared subscription (OcEventHub), but reconnects (gateway flaps,
 * idle-close/reopen between turns, multiple channel processes) legitimately
 * reopen, and we do NOT want stream opens 429'd in normal use. The nonce store
 * keeps its own hard cap, so this is the only thing this bounds. Set to 0 to
 * disable the reconnect cap entirely.
 */
export const OC_EVENT_RECONNECT_LIMIT = Number(Bun.env.GUARDIAN_OC_EVENT_RECONNECT_LIMIT ?? 600);
export const OC_EVENT_RECONNECT_WINDOW_MS = Number(
  Bun.env.GUARDIAN_OC_EVENT_RECONNECT_WINDOW_MS ?? 60_000,
);

/**
 * Max concurrently-open /event streams per principal. The /event stream is
 * principal-scoped (it already carries every owned session), so a well-behaved
 * channel needs only ONE — but a principal can legitimately be served by several
 * concurrent streams (multiple channel processes, a brief open/close overlap
 * between turns, a user active across channels). We keep this LOOSE so streaming
 * is never rejected in normal use; it exists only to bound a true runaway leak.
 * Set to 0 to disable the concurrent-stream cap entirely.
 */
export const OC_EVENT_MAX_CONCURRENT_STREAMS = Number(
  Bun.env.GUARDIAN_OC_EVENT_MAX_CONCURRENT_STREAMS ?? 64,
);

/**
 * Max concurrent in-flight prompt turns per principal. A turn is a
 * prompt_async/message POST that has not yet completed (the channel resolves it
 * at session-idle). Bounds how much assistant compute one principal can hold.
 */
export const OC_MAX_INFLIGHT_TURNS = Number(Bun.env.GUARDIAN_OC_MAX_INFLIGHT_TURNS ?? 4);

/**
 * Per-turn wall-clock cap. A turn open longer than this is force-aborted
 * (POST /session/{id}/abort) by the sweep so a stuck/runaway turn cannot hold a
 * slot indefinitely. 10 min is well beyond a normal turn yet bounds the leak.
 */
export const OC_TURN_WALL_CLOCK_MS = Number(Bun.env.GUARDIAN_OC_TURN_WALL_CLOCK_MS ?? 10 * 60_000);

/** Hard size caps — same discipline as replay.ts/rate-limit.ts/ownership.ts. */
const RECONNECT_BUCKETS_MAX = 10_000;
const PRINCIPAL_STREAMS_MAX = 10_000;
const PRINCIPAL_TURNS_MAX = 10_000;

// ── 1. /event reconnect rate (fixed window per principal) ──────────────────

const reconnectBuckets = new Map<string, { count: number; start: number }>();

/**
 * Record a /event open attempt and return true if it is within the reconnect
 * budget for the principal. Fixed-window, mirroring rate-limit.ts.
 */
export function allowEventReconnect(principal: Principal): boolean {
  if (OC_EVENT_RECONNECT_LIMIT <= 0) return true; // cap disabled
  const key = principalKey(principal);
  const now = Date.now();
  const b = reconnectBuckets.get(key);
  if (!b || now - b.start > OC_EVENT_RECONNECT_WINDOW_MS) {
    reconnectBuckets.set(key, { count: 1, start: now });
    if (reconnectBuckets.size > RECONNECT_BUCKETS_MAX) pruneReconnect();
    return true;
  }
  if (b.count >= OC_EVENT_RECONNECT_LIMIT) return false;
  b.count++;
  return true;
}

function pruneReconnect(): void {
  const now = Date.now();
  for (const [k, b] of reconnectBuckets) {
    if (now - b.start > OC_EVENT_RECONNECT_WINDOW_MS) reconnectBuckets.delete(k);
  }
  if (reconnectBuckets.size > RECONNECT_BUCKETS_MAX) {
    const sorted = [...reconnectBuckets.entries()].sort((a, b) => a[1].start - b[1].start);
    for (const [k] of sorted.slice(0, sorted.length - RECONNECT_BUCKETS_MAX)) reconnectBuckets.delete(k);
  }
}

// ── 2. Concurrent /event streams per principal ─────────────────────────────

const streamCounts = new Map<string, number>();

/**
 * Try to reserve a concurrent-stream slot for the principal. Returns true if a
 * slot was reserved (caller MUST call releaseEventStream on close), false if the
 * principal is already at OC_EVENT_MAX_CONCURRENT_STREAMS (caller → 429).
 */
export function reserveEventStream(principal: Principal): boolean {
  const key = principalKey(principal);
  const current = streamCounts.get(key) ?? 0;
  if (OC_EVENT_MAX_CONCURRENT_STREAMS > 0 && current >= OC_EVENT_MAX_CONCURRENT_STREAMS) return false;
  streamCounts.set(key, current + 1);
  if (streamCounts.size > PRINCIPAL_STREAMS_MAX) pruneZeroStreams();
  return true;
}

/** Release a previously-reserved concurrent-stream slot (on stream close). */
export function releaseEventStream(principal: Principal): void {
  const key = principalKey(principal);
  const current = streamCounts.get(key) ?? 0;
  if (current <= 1) streamCounts.delete(key);
  else streamCounts.set(key, current - 1);
}

function pruneZeroStreams(): void {
  for (const [k, v] of streamCounts) {
    if (v <= 0) streamCounts.delete(k);
  }
}

// ── 3. In-flight turns per principal + per-turn wall-clock cap ──────────────

interface InflightTurn {
  principalKey: string;
  sessionId: string;
  startedAt: number;
}

// turnId (a guardian-minted opaque token) → turn record. We mint our own id so
// we never depend on the OpenCode messageID schema here.
const inflightTurns = new Map<string, InflightTurn>();
const turnCountByPrincipal = new Map<string, number>();

/**
 * Try to begin an in-flight turn for `principal` on `sessionId`. Returns a
 * turnId to pass to endTurn on completion, or null if the principal is already
 * at OC_MAX_INFLIGHT_TURNS (caller → 429).
 */
export function beginTurn(principal: Principal, sessionId: string): string | null {
  const key = principalKey(principal);
  const current = turnCountByPrincipal.get(key) ?? 0;
  if (current >= OC_MAX_INFLIGHT_TURNS) return null;
  const turnId = crypto.randomUUID();
  inflightTurns.set(turnId, { principalKey: key, sessionId, startedAt: Date.now() });
  turnCountByPrincipal.set(key, current + 1);
  if (inflightTurns.size > PRINCIPAL_TURNS_MAX) pruneOldestTurns();
  return turnId;
}

/** End an in-flight turn (on turn completion or failure). Idempotent. */
export function endTurn(turnId: string): void {
  const turn = inflightTurns.get(turnId);
  if (!turn) return;
  inflightTurns.delete(turnId);
  const current = turnCountByPrincipal.get(turn.principalKey) ?? 0;
  if (current <= 1) turnCountByPrincipal.delete(turn.principalKey);
  else turnCountByPrincipal.set(turn.principalKey, current - 1);
}

/**
 * End every in-flight turn for `sessionId` and return how many were ended. The
 * /event fan-out calls this when it observes the session's turn-end signal
 * (session.idle / an explicit idle session.status — isTurnEnd from the portal runtime). An
 * async prompt_async turn returns 204 immediately while the model keeps working,
 * so its slot must be released at SESSION-IDLE, not at HTTP return — otherwise
 * the in-flight cap and the wall-clock sweep are both dead. Idempotent.
 */
export function endTurnsForSession(sessionId: string): number {
  let ended = 0;
  for (const [turnId, turn] of inflightTurns) {
    if (turn.sessionId === sessionId) {
      endTurn(turnId);
      ended++;
    }
  }
  return ended;
}

/**
 * Find every in-flight turn that has breached OC_TURN_WALL_CLOCK_MS, end its
 * accounting, and return the sessionIds to abort. The caller issues the actual
 * POST /session/{id}/abort (kept out of this module so the bounds stay pure of
 * the upstream fetch — testable without a live assistant).
 */
export function reapStaleTurns(now: number = Date.now()): string[] {
  const toAbort: string[] = [];
  for (const [turnId, turn] of inflightTurns) {
    if (now - turn.startedAt > OC_TURN_WALL_CLOCK_MS) {
      toAbort.push(turn.sessionId);
      endTurn(turnId);
    }
  }
  return toAbort;
}

function pruneOldestTurns(): void {
  const sorted = [...inflightTurns.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt);
  for (const [turnId] of sorted.slice(0, sorted.length - PRINCIPAL_TURNS_MAX)) endTurn(turnId);
}

// ── Stale-turn sweep timer (unref'd) ───────────────────────────────────────

// The reaper needs a side-effect (POST /session/{id}/abort) it cannot perform
// itself without coupling to the upstream fetch. The owner of that side-effect
// registers a callback here; the timer invokes it with the breached sessionIds.
let abortFn: ((sessionId: string) => void) | null = null;

/** Register the abort side-effect (proxy.ts wires the upstream abort fetch). */
export function setTurnAbortFn(fn: (sessionId: string) => void): void {
  abortFn = fn;
}

const sweepTimer = setInterval(() => {
  const stale = reapStaleTurns();
  if (abortFn) for (const sessionId of stale) abortFn(sessionId);
  pruneReconnect();
}, 60_000);
sweepTimer.unref();

// ── /stats + test helpers ──────────────────────────────────────────────────

/** Active /event reconnect buckets (for /stats). */
export function reconnectBucketCount(): number {
  return reconnectBuckets.size;
}

/** Number of principals with at least one open /event stream (for /stats). */
export function activeStreamPrincipalCount(): number {
  return streamCounts.size;
}

/** Total in-flight turns across all principals (for /stats). */
export function inflightTurnCount(): number {
  return inflightTurns.size;
}

/** Test-only: clear all bounds state between cases. */
export function _resetBoundsForTest(): void {
  reconnectBuckets.clear();
  streamCounts.clear();
  inflightTurns.clear();
  turnCountByPrincipal.clear();
}
