import { describe, expect, test } from "bun:test";
import { isLoopback, isRemoteSetupAllowed, isTrustedProxyEnabled } from "./bind-warning.js";

describe("isLoopback", () => {
  test("recognises every loopback spelling", () => {
    for (const value of ["127.0.0.1", "localhost", "::1", "  127.0.0.1  "]) {
      expect(isLoopback(value)).toBe(true);
    }
  });

  test("a wildcard or concrete LAN address is not loopback", () => {
    for (const value of ["0.0.0.0", "::", "192.168.1.50", "10.0.0.7"]) {
      expect(isLoopback(value)).toBe(false);
    }
  });
});

describe("isRemoteSetupAllowed", () => {
  test("off by default", () => {
    expect(isRemoteSetupAllowed({})).toBe(false);
  });

  test("honours the documented truthy spellings", () => {
    for (const value of ["1", "true", "yes", "TRUE", " Yes "]) {
      expect(isRemoteSetupAllowed({ OP_ALLOW_REMOTE_SETUP: value })).toBe(true);
    }
  });

  test("admin capability always wins, so inherited env cannot weaken the host-only boundary", () => {
    expect(isRemoteSetupAllowed({ OP_ALLOW_REMOTE_SETUP: "1", OP_ENABLE_ADMIN: "1" })).toBe(false);
    expect(isRemoteSetupAllowed({ OP_ALLOW_REMOTE_SETUP: "1", OP_INSIDE_ELECTRON: "1" })).toBe(false);
  });
});

describe("isTrustedProxyEnabled", () => {
  test("off by default", () => {
    expect(isTrustedProxyEnabled({})).toBe(false);
  });

  test.each(["1", "true", "TRUE", "yes"])("honours %s", (value) => {
    expect(isTrustedProxyEnabled({ OP_TRUSTED_PROXY: value })).toBe(true);
  });

  test("admin capability still wins — host admin is never reachable remotely", () => {
    expect(isTrustedProxyEnabled({ OP_TRUSTED_PROXY: "1", OP_ENABLE_ADMIN: "1" })).toBe(false);
    expect(isTrustedProxyEnabled({ OP_TRUSTED_PROXY: "1", OP_INSIDE_ELECTRON: "1" })).toBe(false);
  });

  test("is independent of the wildcard-bind opt-in", () => {
    // The point of the split: every documented TLS proxy connects to loopback,
    // so trusting its headers must not require opening 0.0.0.0 — which the docs
    // then had to tell operators to firewall again.
    expect(isTrustedProxyEnabled({ OP_ALLOW_REMOTE_SETUP: "1" })).toBe(false);
    expect(isRemoteSetupAllowed({ OP_TRUSTED_PROXY: "1" })).toBe(false);
  });
});
