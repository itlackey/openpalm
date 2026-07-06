/**
 * Rate limiting unit tests.
 *
 * Covers: per-key allow/reject at limit, window reset after expiry,
 * and activeRateLimiters() counting.
 */
import { describe, it, expect } from "bun:test";
import {
  allow,
  allowPreAuth,
  activeRateLimiters,
  USER_RATE_LIMIT,
  USER_RATE_WINDOW_MS,
  PORTAL_RATE_LIMIT,
  PORTAL_RATE_WINDOW_MS,
  PREAUTH_RATE_LIMIT,
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
    expect(PORTAL_RATE_LIMIT).toBe(200);
    expect(PORTAL_RATE_WINDOW_MS).toBe(60_000);
  });
});

describe("allowPreAuth (coarse per-IP pre-auth budget, rev3-F3)", () => {
  it("allows up to PREAUTH_RATE_LIMIT from one IP, then rejects", () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 250) + 1}-${crypto.randomUUID()}`;
    for (let i = 0; i < PREAUTH_RATE_LIMIT; i++) {
      expect(allowPreAuth(ip)).toBe(true);
    }
    expect(allowPreAuth(ip)).toBe(false);
  });

  it("meters each source IP independently", () => {
    const ipA = `a-${crypto.randomUUID()}`;
    const ipB = `b-${crypto.randomUUID()}`;
    for (let i = 0; i < PREAUTH_RATE_LIMIT; i++) allowPreAuth(ipA);
    expect(allowPreAuth(ipA)).toBe(false);
    // A different source is unaffected by A exhausting its budget.
    expect(allowPreAuth(ipB)).toBe(true);
  });

  it("never limits when the source IP is unavailable (empty string)", () => {
    for (let i = 0; i < PREAUTH_RATE_LIMIT + 10; i++) {
      expect(allowPreAuth("")).toBe(true);
    }
  });

  it("pre-auth buckets do not pollute the user/portal limiter counts", () => {
    const before = activeRateLimiters();
    allowPreAuth(`iso-${crypto.randomUUID()}`);
    const after = activeRateLimiters();
    expect(after.activeUserLimiters).toBe(before.activeUserLimiters);
    expect(after.activePortalLimiters).toBe(before.activePortalLimiters);
  });
});

describe("activeRateLimiters", () => {
  it("classifies explicit user/portal prefixes without relying on colon counts", () => {
    const id = crypto.randomUUID();
    const userId = `discord:${crypto.randomUUID()}`;
    const userKey = `user:oc:portal:${id}:${userId}`;
    const portalKey = `portal:oc:portal:${id}`;

    const before = activeRateLimiters();

    allow(userKey, USER_RATE_LIMIT, USER_RATE_WINDOW_MS);
    allow(portalKey, PORTAL_RATE_LIMIT, PORTAL_RATE_WINDOW_MS);

    const after = activeRateLimiters();

    expect(after.activeUserLimiters).toBe(before.activeUserLimiters + 1);
    expect(after.activePortalLimiters).toBe(before.activePortalLimiters + 1);
  });

  it("keeps the legacy oc: key behavior for existing buckets", () => {
    const id = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const userKey = `oc:portal:${id}:${userId}`;
    const portalKey = `oc:portal:${id}`;

    const before = activeRateLimiters();

    allow(userKey, USER_RATE_LIMIT, USER_RATE_WINDOW_MS);
    allow(portalKey, PORTAL_RATE_LIMIT, PORTAL_RATE_WINDOW_MS);

    const after = activeRateLimiters();

    expect(after.activeUserLimiters).toBe(before.activeUserLimiters + 1);
    expect(after.activePortalLimiters).toBe(before.activePortalLimiters + 1);
  });
});
