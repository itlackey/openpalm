/**
 * Rate limiting unit tests.
 *
 * Covers: per-key allow/reject at limit, window reset after expiry,
 * and activeRateLimiters() counting.
 */
import { describe, it, expect } from "bun:test";
import {
  allow,
  activeRateLimiters,
  USER_RATE_LIMIT,
  USER_RATE_WINDOW_MS,
  CHANNEL_RATE_LIMIT,
  CHANNEL_RATE_WINDOW_MS,
} from "./rate-limit";

function uniqueKey(prefix = "user"): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

describe("Rate limiting (allow)", () => {
  it("allows up to `limit` requests and rejects the next", () => {
    const key = uniqueKey();
    const limit = 5;
    const windowMs = 60_000;

    for (let i = 0; i < limit; i++) {
      expect(allow(key, limit, windowMs)).toBe(true);
    }

    // The limit+1 request should be rejected
    expect(allow(key, limit, windowMs)).toBe(false);
  });

  it("resets the window after windowMs elapses", async () => {
    const key = uniqueKey();
    const limit = 2;
    const windowMs = 50; // very short window for testing

    // Exhaust the limit
    expect(allow(key, limit, windowMs)).toBe(true);
    expect(allow(key, limit, windowMs)).toBe(true);
    expect(allow(key, limit, windowMs)).toBe(false);

    // Wait for the window to expire
    await new Promise((resolve) => setTimeout(resolve, windowMs + 10));

    // Should be allowed again after window reset
    expect(allow(key, limit, windowMs)).toBe(true);
  });

  it("exports the expected constants", () => {
    expect(USER_RATE_LIMIT).toBe(120);
    expect(USER_RATE_WINDOW_MS).toBe(60_000);
    expect(CHANNEL_RATE_LIMIT).toBe(200);
    expect(CHANNEL_RATE_WINDOW_MS).toBe(60_000);
  });
});

describe("activeRateLimiters", () => {
  it("counts active user and channel limiters", () => {
    // Insert a user key and a channel key with fresh windows
    const userKey = uniqueKey("user");
    const channelKey = `ch:${crypto.randomUUID()}`;

    const before = activeRateLimiters();

    allow(userKey, USER_RATE_LIMIT, USER_RATE_WINDOW_MS);
    allow(channelKey, CHANNEL_RATE_LIMIT, CHANNEL_RATE_WINDOW_MS);

    const after = activeRateLimiters();

    expect(after.activeUserLimiters).toBe(before.activeUserLimiters + 1);
    expect(after.activeChannelLimiters).toBe(before.activeChannelLimiters + 1);
  });
});
