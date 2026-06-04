/**
 * Guardian-LOCAL /oc/* resource-bounds unit tests (design §3.6).
 *
 * Pure-logic tests — import the bounds functions directly and assert. No
 * subprocess / upstream needed (the abort side-effect is wired separately in
 * proxy.ts via setTurnAbortFn; here we test reapStaleTurns returns the breached
 * sessionIds, which is what the proxy hands to the abort fn).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  allowEventReconnect,
  reserveEventStream,
  releaseEventStream,
  beginTurn,
  endTurn,
  endTurnsForSession,
  reapStaleTurns,
  reconnectBucketCount,
  activeStreamPrincipalCount,
  inflightTurnCount,
  OC_EVENT_RECONNECT_LIMIT,
  OC_EVENT_MAX_CONCURRENT_STREAMS,
  OC_MAX_INFLIGHT_TURNS,
  OC_TURN_WALL_CLOCK_MS,
  _resetBoundsForTest,
} from "./oc-bounds";
import type { Principal } from "./ownership";

const A: Principal = { channel: "test", userId: "alice" };
const B: Principal = { channel: "test", userId: "bob" };

beforeEach(() => _resetBoundsForTest());

describe("event reconnect cap (§3.6 F4)", () => {
  it(`allows up to OC_EVENT_RECONNECT_LIMIT (${OC_EVENT_RECONNECT_LIMIT}) then rejects`, () => {
    for (let i = 0; i < OC_EVENT_RECONNECT_LIMIT; i++) {
      expect(allowEventReconnect(A)).toBe(true);
    }
    expect(allowEventReconnect(A)).toBe(false);
  });

  it("is per-principal (bob is unaffected by alice's budget)", () => {
    for (let i = 0; i < OC_EVENT_RECONNECT_LIMIT; i++) allowEventReconnect(A);
    expect(allowEventReconnect(A)).toBe(false);
    expect(allowEventReconnect(B)).toBe(true);
  });
});

describe("concurrent /event stream cap (§3.6)", () => {
  it(`reserves up to OC_EVENT_MAX_CONCURRENT_STREAMS (${OC_EVENT_MAX_CONCURRENT_STREAMS}) then rejects`, () => {
    for (let i = 0; i < OC_EVENT_MAX_CONCURRENT_STREAMS; i++) {
      expect(reserveEventStream(A)).toBe(true);
    }
    // The (cap+1)th open is rejected → caller 429s.
    expect(reserveEventStream(A)).toBe(false);
  });

  it("releasing a slot frees the principal to reconnect", () => {
    expect(reserveEventStream(A)).toBe(true);
    expect(reserveEventStream(A)).toBe(false); // at cap (1)
    releaseEventStream(A);
    expect(reserveEventStream(A)).toBe(true); // slot freed
  });

  it("is per-principal", () => {
    expect(reserveEventStream(A)).toBe(true);
    expect(reserveEventStream(B)).toBe(true);
    expect(activeStreamPrincipalCount()).toBe(2);
  });

  it("releasing the last slot drops the principal from the count", () => {
    reserveEventStream(A);
    expect(activeStreamPrincipalCount()).toBe(1);
    releaseEventStream(A);
    expect(activeStreamPrincipalCount()).toBe(0);
  });
});

describe("in-flight turn cap + wall-clock reap (§3.6)", () => {
  it(`begins up to OC_MAX_INFLIGHT_TURNS (${OC_MAX_INFLIGHT_TURNS}) then returns null`, () => {
    const ids: string[] = [];
    for (let i = 0; i < OC_MAX_INFLIGHT_TURNS; i++) {
      const t = beginTurn(A, `ses_${i}`);
      expect(typeof t).toBe("string");
      ids.push(t as string);
    }
    expect(beginTurn(A, "ses_overflow")).toBeNull(); // (cap+1)th → 429
    // Ending one frees a slot.
    endTurn(ids[0]);
    expect(typeof beginTurn(A, "ses_after_end")).toBe("string");
  });

  it("is per-principal", () => {
    for (let i = 0; i < OC_MAX_INFLIGHT_TURNS; i++) beginTurn(A, `a_${i}`);
    expect(beginTurn(A, "a_over")).toBeNull();
    expect(typeof beginTurn(B, "b_0")).toBe("string");
  });

  it("reapStaleTurns returns sessionIds of turns past the wall-clock cap and ends them", () => {
    const fresh = beginTurn(A, "ses_fresh");
    const stale = beginTurn(A, "ses_stale");
    expect(fresh).not.toBeNull();
    expect(stale).not.toBeNull();
    expect(inflightTurnCount()).toBe(2);

    // Now = far in the future so BOTH would breach — but assert it returns the
    // breached sessionIds (the proxy hands these to the abort fn) and clears them.
    const now = Date.now() + OC_TURN_WALL_CLOCK_MS + 1;
    const aborted = reapStaleTurns(now);
    expect(aborted.sort()).toEqual(["ses_fresh", "ses_stale"]);
    expect(inflightTurnCount()).toBe(0);
    // After reaping, the principal's slots are free again.
    expect(typeof beginTurn(A, "ses_new")).toBe("string");
  });

  it("reapStaleTurns leaves turns within the cap untouched", () => {
    beginTurn(A, "ses_a");
    const aborted = reapStaleTurns(Date.now()); // nothing has aged past the cap
    expect(aborted).toEqual([]);
    expect(inflightTurnCount()).toBe(1);
  });

  it("endTurnsForSession releases the slot at session-idle (async prompt_async path)", () => {
    // Fill the cap, all on one session (the create-per-turn model would differ,
    // but the accounting is by sessionId either way).
    for (let i = 0; i < OC_MAX_INFLIGHT_TURNS; i++) beginTurn(A, "ses_live");
    expect(beginTurn(A, "ses_live")).toBeNull(); // at cap
    // The /event fan-out observes turn-end for the session → release the slots.
    const ended = endTurnsForSession("ses_live");
    expect(ended).toBe(OC_MAX_INFLIGHT_TURNS);
    expect(inflightTurnCount()).toBe(0);
    expect(typeof beginTurn(A, "ses_live")).toBe("string"); // slot freed
  });

  it("endTurnsForSession only ends turns for the named session", () => {
    beginTurn(A, "ses_x");
    beginTurn(B, "ses_y");
    expect(endTurnsForSession("ses_x")).toBe(1);
    expect(inflightTurnCount()).toBe(1); // ses_y survives
    expect(endTurnsForSession("ses_none")).toBe(0); // unknown session → no-op
  });
});

describe("/stats getters", () => {
  it("reconnectBucketCount reflects active buckets", () => {
    expect(reconnectBucketCount()).toBe(0);
    allowEventReconnect(A);
    allowEventReconnect(B);
    expect(reconnectBucketCount()).toBe(2);
  });
});
