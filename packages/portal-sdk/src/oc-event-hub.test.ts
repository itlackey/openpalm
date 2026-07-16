/**
 * OcEventHub — one shared /event stream per principal, fanned out to turns.
 *
 * The bug this guards: concurrent portal threads from one user each opened a
 * redundant principal-scoped /event stream (each a full duplicate of the same
 * fan-out). The hub guarantees exactly ONE upstream stream per principal
 * regardless of concurrent turns, delivers every frame to every subscriber
 * (each filters by its own sessionId), and — critically — an upstream
 * close/error ends all subscribers (so buffered turns finalize) and evicts the
 * dead stream so the next subscribe reopens a fresh one. Without the eviction,
 * a guardian restart would leave every turn for a cached principal hanging
 * forever.
 *
 * (Adopted from the deleted portals/discord twin so the coverage lives beside
 * the class itself.) OcClient.events is stubbed with a controllable async
 * generator; no live guardian needed.
 */
import { describe, test, expect } from "bun:test";
import { OcEventHub } from "./oc-event-hub.ts";

/** A fake OcClient whose events() yields from a manually-fed queue per call. */
function fakeClient() {
  let opens = 0;
  const feeders: Array<(frame: unknown) => void> = [];
  const closers: Array<() => void> = [];
  const client = {
    events(_userId: string, signal: AbortSignal) {
      opens++;
      const queue: unknown[] = [];
      let waiting: ((r: IteratorResult<unknown>) => void) | null = null;
      let done = false;
      const push = (frame: unknown) => {
        if (waiting) { const w = waiting; waiting = null; w({ value: frame, done: false }); }
        else queue.push(frame);
      };
      const finish = () => { done = true; if (waiting) { const w = waiting; waiting = null; w({ value: undefined, done: true }); } };
      feeders.push(push);
      closers.push(finish);
      signal.addEventListener("abort", finish, { once: true });
      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<unknown>> {
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
              if (done) return Promise.resolve({ value: undefined, done: true });
              return new Promise((res) => { waiting = res; });
            },
          };
        },
      };
    },
  };
  return { client, get opens() { return opens; }, feed: (i: number, f: unknown) => feeders[i]?.(f), closeUpstream: (i: number) => closers[i]?.() };
}

async function take(iter: AsyncIterable<unknown>, n: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of iter) { out.push(ev); if (out.length >= n) break; }
  return out;
}

describe("OcEventHub", () => {
  test("two concurrent subscribers for one principal share ONE upstream stream", async () => {
    const f = fakeClient();
    const hub = new OcEventHub(f.client as never);

    const subA = hub.subscribe("portal:u1");
    const subB = hub.subscribe("portal:u1");
    expect(f.opens).toBe(1);            // a single upstream open
    expect(hub.openStreamCount).toBe(1);

    // One upstream frame reaches BOTH subscribers (each filters by sessionId itself).
    const gotA = take(subA, 1);
    const gotB = take(subB, 1);
    f.feed(0, { type: "message.part.delta", properties: { sessionID: "s1", delta: "hi" } });
    expect(await gotA).toEqual([{ type: "message.part.delta", properties: { sessionID: "s1", delta: "hi" } }]);
    expect(await gotB).toEqual([{ type: "message.part.delta", properties: { sessionID: "s1", delta: "hi" } }]);

    subA.close();
    subB.close();
  });

  test("separate principals get separate upstream streams", () => {
    const f = fakeClient();
    const hub = new OcEventHub(f.client as never);
    hub.subscribe("portal:u1");
    hub.subscribe("portal:u2");
    expect(f.opens).toBe(2);
    expect(hub.openStreamCount).toBe(2);
  });

  test("an upstream close/error ends all subscribers so their turns finalize", async () => {
    const f = fakeClient();
    const hub = new OcEventHub(f.client as never);
    const sub = hub.subscribe("portal:u1");

    // Drain to completion: when the upstream finishes, the subscriber iterator ends.
    const drained = (async () => { for await (const _ of sub) { /* ignore */ } return "ended"; })();
    f.closeUpstream(0);
    expect(await drained).toBe("ended");
    // Stream is forgotten → a new subscribe reopens a fresh upstream.
    hub.subscribe("portal:u1");
    expect(f.opens).toBe(2);
  });
});
