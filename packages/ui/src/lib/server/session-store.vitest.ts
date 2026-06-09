/**
 * Tests for session-store.ts — stateless HMAC-signed tokens.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSession,
  validateSession,
  touchSession,
  invalidateSession,
  _seedSession,
  _clearSessions,
  SESSION_TTL_MS,
} from "./session-store.js";

beforeEach(() => {
  process.env.OP_UI_LOGIN_PASSWORD = "test-secret";
  _clearSessions();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OP_UI_LOGIN_PASSWORD;
});

describe("createSession / validateSession", () => {
  test("a freshly minted token is valid", () => {
    const token = createSession();
    expect(validateSession(token)).toBe(true);
  });

  test("an unknown string is not valid", () => {
    expect(validateSession("not-a-real-token")).toBe(false);
  });

  test("an empty token is not valid", () => {
    expect(validateSession("")).toBe(false);
  });

  test("a token signed with a different secret is rejected", () => {
    const token = createSession();
    process.env.OP_UI_LOGIN_PASSWORD = "different-secret";
    expect(validateSession(token)).toBe(false);
  });

  test("an expired token is rejected", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const token = createSession();
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);
    expect(validateSession(token)).toBe(false);
  });
});

describe("touchSession (sliding renewal)", () => {
  test("returns a new token for a valid session", () => {
    const token = createSession();
    const newToken = touchSession(token);
    expect(typeof newToken).toBe("string");
    expect(newToken).not.toBe(false);
    expect(validateSession(newToken as string)).toBe(true);
  });

  test("the new token has a fresh TTL past the original expiry", () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const token = createSession();

    // Advance close to the original expiry, then touch.
    vi.setSystemTime(now + SESSION_TTL_MS - 1000);
    const newToken = touchSession(token) as string;
    expect(newToken).toBeTruthy();

    // Past the original expiry — old token expires, new token is still valid.
    vi.setSystemTime(now + SESSION_TTL_MS + 1000);
    expect(validateSession(token)).toBe(false);
    expect(validateSession(newToken)).toBe(true);
  });

  test("returns false for an unknown token", () => {
    expect(touchSession("nope")).toBe(false);
  });

  test("returns false for an expired token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());
    const token = createSession();
    vi.setSystemTime(Date.now() + SESSION_TTL_MS + 1000);
    expect(touchSession(token)).toBe(false);
  });

  test("returns false for an empty token", () => {
    expect(touchSession("")).toBe(false);
  });
});

describe("invalidateSession (logout)", () => {
  test("a revoked token no longer validates", () => {
    const token = createSession();
    expect(validateSession(token)).toBe(true);
    invalidateSession(token);
    expect(validateSession(token)).toBe(false);
  });
});

describe("_seedSession (test helper)", () => {
  test("a seeded token validates", () => {
    _seedSession("test-admin-token");
    expect(validateSession("test-admin-token")).toBe(true);
  });

  test("a token seeded with negative TTL is rejected (intentionally expired)", () => {
    _seedSession("stale", -1);
    expect(validateSession("stale")).toBe(false);
  });
});
