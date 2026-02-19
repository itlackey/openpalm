import { describe, expect, it } from "bun:test";
import { allowRequest } from "./rate-limit.ts";

describe("rate limit", () => {
  it("allows requests under the limit and blocks at the limit", () => {
    const key = `user-under-limit-${Math.random().toString(36).slice(2)}`;
    expect(allowRequest(key, 2, 60_000)).toBe(true);
    expect(allowRequest(key, 2, 60_000)).toBe(true);
    expect(allowRequest(key, 2, 60_000)).toBe(false);
  });

  it("resets after the window expires", async () => {
    const key = `user-window-reset-${Math.random().toString(36).slice(2)}`;
    expect(allowRequest(key, 1, 10)).toBe(true);
    expect(allowRequest(key, 1, 10)).toBe(false);

    await Bun.sleep(15);

    expect(allowRequest(key, 1, 10)).toBe(true);
  });

  it("tracks distinct keys independently", () => {
    const keyA = `user-a-${Math.random().toString(36).slice(2)}`;
    const keyB = `user-b-${Math.random().toString(36).slice(2)}`;

    expect(allowRequest(keyA, 1, 60_000)).toBe(true);
    expect(allowRequest(keyA, 1, 60_000)).toBe(false);

    expect(allowRequest(keyB, 1, 60_000)).toBe(true);
  });
});
