import { describe, test, expect } from "bun:test";
import { collectBindAddressWarnings, isLoopback, isRemoteSetupAllowed } from "./bind-warning.js";

describe("collectBindAddressWarnings", () => {
  test("returns [] when env is empty (compose default is 127.0.0.1)", () => {
    expect(collectBindAddressWarnings({})).toEqual([]);
  });

  test("returns [] when OP_BIND_ADDRESS is 127.0.0.1", () => {
    expect(collectBindAddressWarnings({ OP_BIND_ADDRESS: "127.0.0.1" })).toEqual([]);
  });

  test("returns [] when OP_BIND_ADDRESS is localhost", () => {
    expect(collectBindAddressWarnings({ OP_BIND_ADDRESS: "localhost" })).toEqual([]);
  });

  test("returns [] when OP_BIND_ADDRESS is ::1", () => {
    expect(collectBindAddressWarnings({ OP_BIND_ADDRESS: "::1" })).toEqual([]);
  });

  test("returns a warning when OP_BIND_ADDRESS is 0.0.0.0", () => {
    const warnings = collectBindAddressWarnings({ OP_BIND_ADDRESS: "0.0.0.0" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OP_BIND_ADDRESS");
    expect(warnings[0]).toContain("0.0.0.0");
    expect(warnings[0]).toContain("host network interface");
  });

  test("returns a warning when OP_BIND_ADDRESS is a LAN IP", () => {
    const warnings = collectBindAddressWarnings({ OP_BIND_ADDRESS: "192.168.1.10" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("192.168.1.10");
  });

  test("returns individual warnings for non-loopback per-service overrides", () => {
    const warnings = collectBindAddressWarnings({
      OP_CHAT_BIND_ADDRESS: "0.0.0.0",
      OP_VOICE_BIND_ADDRESS: "192.168.1.5",
    });
    expect(warnings).toHaveLength(2);
    const joined = warnings.join("\n");
    expect(joined).toContain("OP_CHAT_BIND_ADDRESS");
    expect(joined).toContain("OP_VOICE_BIND_ADDRESS");
  });

  test("does not warn about per-service overrides that are loopback", () => {
    const warnings = collectBindAddressWarnings({
      OP_BIND_ADDRESS: "0.0.0.0",
      OP_CHAT_BIND_ADDRESS: "127.0.0.1",
    });
    // Only the global OP_BIND_ADDRESS warning; OP_CHAT_BIND_ADDRESS is loopback
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OP_BIND_ADDRESS");
    expect(warnings[0]).not.toContain("OP_CHAT_BIND_ADDRESS");
  });

  test("returns warnings for both global and per-service non-loopback values", () => {
    const warnings = collectBindAddressWarnings({
      OP_BIND_ADDRESS: "0.0.0.0",
      OP_ASSISTANT_BIND_ADDRESS: "10.0.0.1",
    });
    expect(warnings).toHaveLength(2);
    const joined = warnings.join("\n");
    expect(joined).toContain("OP_BIND_ADDRESS");
    expect(joined).toContain("OP_ASSISTANT_BIND_ADDRESS");
  });

  test("all known per-service vars are checked", () => {
    const env: Record<string, string> = {
      OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0",
      OP_CHAT_BIND_ADDRESS: "0.0.0.0",
      OP_API_BIND_ADDRESS: "0.0.0.0",
      OP_VOICE_BIND_ADDRESS: "0.0.0.0",
    };
    const warnings = collectBindAddressWarnings(env);
    expect(warnings).toHaveLength(4);
  });

  test("warns when OP_ALLOW_REMOTE_SETUP is enabled", () => {
    const warnings = collectBindAddressWarnings({ OP_ALLOW_REMOTE_SETUP: "1" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("OP_ALLOW_REMOTE_SETUP");
  });
});

describe("isRemoteSetupAllowed", () => {
  test("false when unset", () => {
    expect(isRemoteSetupAllowed({})).toBe(false);
  });
  test("true for 1 / true / yes (case-insensitive)", () => {
    expect(isRemoteSetupAllowed({ OP_ALLOW_REMOTE_SETUP: "1" })).toBe(true);
    expect(isRemoteSetupAllowed({ OP_ALLOW_REMOTE_SETUP: "true" })).toBe(true);
    expect(isRemoteSetupAllowed({ OP_ALLOW_REMOTE_SETUP: "YES" })).toBe(true);
  });
  test("false for other values", () => {
    expect(isRemoteSetupAllowed({ OP_ALLOW_REMOTE_SETUP: "0" })).toBe(false);
    expect(isRemoteSetupAllowed({ OP_ALLOW_REMOTE_SETUP: "off" })).toBe(false);
  });
});

// #488 — isLoopback must be exported so mdns-responder.ts can reuse it for
// bind-gating instead of duplicating the loopback check.
describe("isLoopback", () => {
  test("recognises 127.0.0.1 / localhost / ::1 and rejects 0.0.0.0 and LAN IPs", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.10")).toBe(false);
  });
});

// #563 — T18: per-var warning wording names the preset that configures that
// exposure deliberately (D9). Red reason: today's strings are raw env-var
// wording only, with no preset framing. The existing cases above (counts,
// env-name containment, the "host network interface" phrase, loopback
// []-cases) are preserved unchanged by the rewording contract — this test
// only adds the NEW preset-framing assertion on top of the existing shape.
describe("collectBindAddressWarnings — preset framing (#563 D9, T18)", () => {
  test("OP_ASSISTANT_BIND_ADDRESS warning names the Home network preset framing", () => {
    const warnings = collectBindAddressWarnings({ OP_ASSISTANT_BIND_ADDRESS: "0.0.0.0" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Home network");
    expect(warnings[0]).toContain("OP_ASSISTANT_BIND_ADDRESS");
  });

  test("OP_BIND_ADDRESS warning names the Shared network preset framing", () => {
    const warnings = collectBindAddressWarnings({ OP_BIND_ADDRESS: "0.0.0.0" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Shared network");
    expect(warnings[0]).toContain("OP_BIND_ADDRESS");
  });
});
