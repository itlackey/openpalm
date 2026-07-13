/**
 * PR #564 retest P2-8 — unit tests for the AGGREGATE relay-queue budget.
 *
 * The per-connection cap alone leaves N slow peers able to buffer N × 8 MiB.
 * `queueAndTryWrite`/`releaseQueue` maintain a shared `RelayBudget.queued` sum
 * and shed the connection that would push the aggregate over its ceiling. These
 * tests drive that accounting directly with a fake socket (no TLS/binding), so
 * the shed decision and the release-on-close arithmetic are deterministic.
 */
import { describe, it, expect } from "bun:test";
import {
  queueAndTryWrite,
  releaseQueue,
  type RelayBudget,
} from "./tls-passthrough.ts";

/** A socket whose write() accepts nothing, so every byte stays queued. */
function blockedSocket() {
  return { write: () => 0 } as unknown as Parameters<typeof queueAndTryWrite>[0];
}
/** A socket whose write() accepts everything, so the queue always drains. */
function drainingSocket() {
  return { write: (b: Uint8Array) => b.byteLength } as unknown as Parameters<typeof queueAndTryWrite>[0];
}
const bytes = (n: number) => new Uint8Array(n);

describe("aggregate relay budget (P2-8)", () => {
  it("accumulates queued bytes across independent connections and sheds the one that crosses the ceiling", () => {
    const budget: RelayBudget = { queued: 0, maxAggregate: 100 };
    const qA: Uint8Array[] = [];
    const qB: Uint8Array[] = [];

    // Connection A buffers 60 bytes (blocked reader) — under both caps.
    expect(queueAndTryWrite(blockedSocket(), qA, bytes(60), budget)).toBe(true);
    expect(budget.queued).toBe(60);

    // Connection B buffers 30 more → aggregate 90, still under 100.
    expect(queueAndTryWrite(blockedSocket(), qB, bytes(30), budget)).toBe(true);
    expect(budget.queued).toBe(90);

    // Connection B pushes 20 more → aggregate 110 > 100 → shed B (returns false)
    // even though B's own 50 bytes are well under the 8 MiB per-connection cap.
    expect(queueAndTryWrite(blockedSocket(), qB, bytes(20), budget)).toBe(false);
    expect(budget.queued).toBe(110);
  });

  it("releases a connection's bytes back to the aggregate on close", () => {
    const budget: RelayBudget = { queued: 0, maxAggregate: 100 };
    const qA: Uint8Array[] = [];
    const qB: Uint8Array[] = [];
    queueAndTryWrite(blockedSocket(), qA, bytes(70), budget);
    queueAndTryWrite(blockedSocket(), qB, bytes(20), budget);
    expect(budget.queued).toBe(90);

    // A closes → its 70 bytes leave the aggregate, freeing headroom for B.
    releaseQueue(qA, budget);
    expect(budget.queued).toBe(20);
    expect(qA.length).toBe(0);

    // B can now buffer up to the ceiling again.
    expect(queueAndTryWrite(blockedSocket(), qB, bytes(70), budget)).toBe(true);
    expect(budget.queued).toBe(90);
  });

  it("decrements the aggregate as a queue drains to its target", () => {
    const budget: RelayBudget = { queued: 0, maxAggregate: 1000 };
    const q: Uint8Array[] = [];
    // Blocked first: 40 bytes stay queued.
    queueAndTryWrite(blockedSocket(), q, bytes(40), budget);
    expect(budget.queued).toBe(40);
    // A draining write clears the backlog AND the new chunk → aggregate back to 0.
    expect(queueAndTryWrite(drainingSocket(), q, bytes(10), budget)).toBe(true);
    expect(budget.queued).toBe(0);
    expect(q.length).toBe(0);
  });

  it("never lets a double-release drive the aggregate negative", () => {
    const budget: RelayBudget = { queued: 0, maxAggregate: 100 };
    const q: Uint8Array[] = [];
    queueAndTryWrite(blockedSocket(), q, bytes(50), budget);
    releaseQueue(q, budget);
    expect(budget.queued).toBe(0);
    releaseQueue(q, budget); // already-empty queue — must not go negative
    expect(budget.queued).toBe(0);
  });
});
