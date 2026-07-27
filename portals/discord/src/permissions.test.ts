import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { checkPermissions, loadPermissionConfig } from "./permissions.ts";

// G3: portals are default-deny with an explicit "*" opt-in. These tests cover
// the Discord-specific wiring (env parsing + the loud first-run WARN); the
// underlying engine semantics are covered by portal-sdk's permissions.test.ts.

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DISCORD_ALLOWED_GUILDS: undefined,
    DISCORD_ALLOWED_ROLES: undefined,
    DISCORD_ALLOWED_USERS: undefined,
    DISCORD_BLOCKED_USERS: undefined,
    ...overrides,
  };
}

describe("discord permissions — default-deny (G3)", () => {
  it("denies every caller when no DISCORD_ALLOWED_* is configured", () => {
    const config = loadPermissionConfig(env());
    const result = checkPermissions(config, { userId: "u1", guildId: "g1", roles: ["member"], username: "u" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_allowlist_configured");
  });

  it('allows any member when DISCORD_ALLOWED_USERS="*" is set (explicit opt-in)', () => {
    const config = loadPermissionConfig(env({ DISCORD_ALLOWED_USERS: "*" }));
    const result = checkPermissions(config, { userId: "anyone", guildId: "g1", roles: [], username: "u" });
    expect(result.allowed).toBe(true);
  });

  it("still enforces a configured guild allowlist normally", () => {
    const config = loadPermissionConfig(env({ DISCORD_ALLOWED_GUILDS: "g1" }));
    const denied = checkPermissions(config, { userId: "u1", guildId: "g2", roles: [], username: "u" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("guild_not_allowed");

    const allowed = checkPermissions(config, { userId: "u1", guildId: "g1", roles: [], username: "u" });
    expect(allowed.allowed).toBe(true);
  });
});

describe("discord permissions — loud first-run WARN (G3)", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "error");
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs a WARN when no allowlist is configured at all", () => {
    loadPermissionConfig(env());
    const logged = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("no_allowlist_configured"))).toBe(true);
  });

  it("does NOT warn when an allowlist is configured", () => {
    loadPermissionConfig(env({ DISCORD_ALLOWED_USERS: "u1" }));
    const logged = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("no_allowlist_configured"))).toBe(false);
  });
});
