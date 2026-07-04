/**
 * Standalone unit tests for the shared BoundedTtlMap + FixedWindowLimiter
 * helpers (imported directly — no guardian subprocess spawn).
 *
 * Covers the three behaviours the four map sites / two limiter sites rely on:
 *   - BoundedTtlMap: max-size oldest-first eviction at the cap
 *   - BoundedTtlMap: per-entry TTL expiry (lazy on get + explicit prune)
 *   - FixedWindowLimiter: fixed-window counting + reset after the window
 */
import { describe, it, expect } from "bun:test";
import { BoundedTtlMap, FixedWindowLimiter } from "./bounded-map";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("BoundedTtlMap", () => {
  it("evicts oldest-first once the size cap is exceeded", async () => {
    const m = new BoundedTtlMap<string, number>({ ttlMs: 60_000, maxSize: 2 });

    m.set("a", 1);
    await sleep(2);
    m.set("b", 2);
    await sleep(2);
    m.set("c", 3); // exceeds cap of 2 → oldest ("a") evicted

    expect(m.size).toBe(2);
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toBe(2);
    expect(m.get("c")).toBe(3);
  });

  it("touch refreshes an entry so it is not the oldest-first eviction victim", async () => {
    const m = new BoundedTtlMap<string, number>({ ttlMs: 60_000, maxSize: 2 });

    m.set("a", 1);
    await sleep(2);
    m.set("b", 2);
    await sleep(2);
    m.touch("a"); // "a" is now newer than "b"
    await sleep(2);
    m.set("c", 3); // eviction should drop "b" (now oldest), not "a"

    expect(m.size).toBe(2);
    expect(m.get("a")).toBe(1);
    expect(m.get("b")).toBeUndefined();
    expect(m.get("c")).toBe(3);
  });

  it("expires entries after their TTL (lazy on get)", async () => {
    const m = new BoundedTtlMap<string, number>({ ttlMs: 20, maxSize: 100 });
    m.set("k", 42);
    expect(m.get("k")).toBe(42);

    await sleep(35);
    expect(m.get("k")).toBeUndefined(); // expired → lazily removed on access
    expect(m.size).toBe(0);
  });

  it("get(key, true) refreshes the TTL on a live hit", async () => {
    const m = new BoundedTtlMap<string, number>({ ttlMs: 40, maxSize: 100 });
    m.set("k", 1);
    await sleep(25);
    expect(m.get("k", true)).toBe(1); // refresh
    await sleep(25); // 50ms since set, but only 25ms since refresh
    expect(m.get("k")).toBe(1);
  });

  it("prune() drops expired entries and hard-caps oldest-first", async () => {
    const m = new BoundedTtlMap<string, number>({ ttlMs: 20, maxSize: 100 });
    m.set("old", 1);
    await sleep(35);
    m.set("new", 2);
    m.prune();
    expect(m.get("old")).toBeUndefined();
    expect(m.get("new")).toBe(2);
  });

  it("entries() yields only live [key, value] pairs", async () => {
    const m = new BoundedTtlMap<string, number>({ ttlMs: 25, maxSize: 100 });
    m.set("a", 1);
    await sleep(35);
    m.set("b", 2);
    const live = [...m.entries()];
    expect(live).toEqual([["b", 2]]);
  });

  it("delete and clear behave like a Map", () => {
    const m = new BoundedTtlMap<string, number>({ ttlMs: 60_000, maxSize: 100 });
    m.set("a", 1);
    m.set("b", 2);
    m.delete("a");
    expect(m.get("a")).toBeUndefined();
    expect(m.size).toBe(1);
    m.clear();
    expect(m.size).toBe(0);
  });
});

describe("FixedWindowLimiter", () => {
  it("allows up to `limit` per key then rejects within the window", () => {
    const lim = new FixedWindowLimiter({ windowMs: 60_000, maxKeys: 10_000 });
    const limit = 3;
    expect(lim.allow("k", limit, 60_000)).toBe(true);
    expect(lim.allow("k", limit, 60_000)).toBe(true);
    expect(lim.allow("k", limit, 60_000)).toBe(true);
    expect(lim.allow("k", limit, 60_000)).toBe(false);
  });

  it("resets the count after the window elapses", async () => {
    const lim = new FixedWindowLimiter({ windowMs: 50, maxKeys: 10_000 });
    expect(lim.allow("k", 2, 50)).toBe(true);
    expect(lim.allow("k", 2, 50)).toBe(true);
    expect(lim.allow("k", 2, 50)).toBe(false);
    await sleep(60);
    expect(lim.allow("k", 2, 50)).toBe(true); // window reset
  });

  it("counts each key independently", () => {
    const lim = new FixedWindowLimiter({ windowMs: 60_000, maxKeys: 10_000 });
    expect(lim.allow("a", 1, 60_000)).toBe(true);
    expect(lim.allow("a", 1, 60_000)).toBe(false);
    expect(lim.allow("b", 1, 60_000)).toBe(true); // separate bucket
  });

  it("uses the configured window when allow() omits an override", () => {
    const lim = new FixedWindowLimiter({ windowMs: 60_000, maxKeys: 10_000 });
    expect(lim.allow("k", 1)).toBe(true);
    expect(lim.allow("k", 1)).toBe(false);
  });

  it("size reflects the number of live buckets", () => {
    const lim = new FixedWindowLimiter({ windowMs: 60_000, maxKeys: 10_000 });
    lim.allow("a", 5, 60_000);
    lim.allow("b", 5, 60_000);
    expect(lim.size).toBe(2);
  });
});
