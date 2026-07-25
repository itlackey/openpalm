import { describe, expect, test } from "bun:test";
import { isLoopback, isRemoteSetupAllowed, isUiLanExposed } from "./bind-warning.js";

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

describe("isUiLanExposed", () => {
  test("an absent bind means loopback — every bind is generated, so unset is not inherit", () => {
    expect(isUiLanExposed({})).toBe(false);
    expect(isUiLanExposed({ OP_UI_BIND_ADDRESS: "127.0.0.1" })).toBe(false);
  });

  test("a wildcard or concrete LAN bind is exposed", () => {
    expect(isUiLanExposed({ OP_UI_BIND_ADDRESS: "0.0.0.0" })).toBe(true);
    expect(isUiLanExposed({ OP_UI_BIND_ADDRESS: "192.168.1.50" })).toBe(true);
  });

  test("no longer inherits from the retired OP_BIND_ADDRESS cascade", () => {
    // The cascade is gone: OP_BIND_ADDRESS cannot silently expose the UI.
    expect(isUiLanExposed({ OP_BIND_ADDRESS: "0.0.0.0" })).toBe(false);
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
