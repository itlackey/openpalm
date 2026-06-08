/**
 * Tests for session-store.ts — opaque session tokens with sliding renewal.
 *
 * Verifies (issue #437):
 *  - a freshly minted token validates as a session
 *  - an expired token is rejected and pruned
 *  - touchSession renews a valid session's expiry (sliding window) and no-ops
 *    for unknown/expired tokens
 *  - invalidateSession (logout) drops the session so it re-prompts
 */
import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
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
  _clearSessions();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSession / validateSession", () => {
  test("a freshly minted token is a valid session", () => {
    const token = createSession();
    expect(validateSession(token)).toBe(true);
  });

  test("an unknown token is not valid", () => {
    createSession();
    expect(validateSession("not-a-real-token")).toBe(false);
  });

  test("an empty token is not valid", () => {
    expect(validateSession("")).toBe(false);
  });

  test("an expired token is rejected and pruned", () => {
    _seedSession("stale", -1); // already expired
    expect(validateSession("stale")).toBe(false);
    // pruned: a second call is still false (and the map no longer holds it)
    expect(validateSession("stale")).toBe(false);
  });
});

describe("touchSession (sliding renewal)", () => {
  test("renews a valid session's expiry by a full TTL", () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const token = createSession();

    // Advance most of the way through the TTL — still valid.
    vi.setSystemTime(now + SESSION_TTL_MS - 1000);
    expect(validateSession(token)).toBe(true);
    expect(touchSession(token)).toBe(true);

    // Past the ORIGINAL expiry it would have lapsed, but the touch pushed it out.
    vi.setSystemTime(now + SESSION_TTL_MS + 1000);
    expect(validateSession(token)).toBe(true);
  });

  test("returns false (no-op) for an unknown token", () => {
    expect(touchSession("nope")).toBe(false);
  });

  test("returns false and prunes an expired token", () => {
    _seedSession("old", -1);
    expect(touchSession("old")).toBe(false);
    expect(validateSession("old")).toBe(false);
  });

  test("returns false for an empty token", () => {
    expect(touchSession("")).toBe(false);
  });
});

describe("invalidateSession (logout)", () => {
  test("a logged-out token no longer validates → re-prompt", () => {
    const token = createSession();
    expect(validateSession(token)).toBe(true);
    invalidateSession(token);
    expect(validateSession(token)).toBe(false);
  });
});
