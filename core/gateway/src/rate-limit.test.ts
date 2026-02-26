import { describe, expect, it } from "bun:test";
import { RateLimiter } from "./rate-limit.ts";

describe("rate limit", () => {
  it("allows requests under the limit and blocks at the limit", () => {
    const limiter = new RateLimiter();
    const key = `user-under-limit-${Math.random().toString(36).slice(2)}`;
    expect(limiter.allow(key, 2, 60_000)).toBe(true);
    expect(limiter.allow(key, 2, 60_000)).toBe(true);
    expect(limiter.allow(key, 2, 60_000)).toBe(false);
  });

  it("resets after the window expires", async () => {
    const limiter = new RateLimiter();
    const key = `user-window-reset-${Math.random().toString(36).slice(2)}`;
    expect(limiter.allow(key, 1, 100)).toBe(true);
    expect(limiter.allow(key, 1, 100)).toBe(false);

    await Bun.sleep(250);

    expect(limiter.allow(key, 1, 100)).toBe(true);
  });

  it("tracks distinct keys independently", () => {
    const limiter = new RateLimiter();
    const keyA = `user-a-${Math.random().toString(36).slice(2)}`;
    const keyB = `user-b-${Math.random().toString(36).slice(2)}`;

    expect(limiter.allow(keyA, 1, 60_000)).toBe(true);
    expect(limiter.allow(keyA, 1, 60_000)).toBe(false);

    expect(limiter.allow(keyB, 1, 60_000)).toBe(true);
  });
});
