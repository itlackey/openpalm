import { describe, test, expect } from "bun:test";
import { collectBindAddressWarnings } from "./bind-warning.js";

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
});
