import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { checkPermissions, loadPermissionConfig } from "./permissions.ts";

// G3: portals are default-deny with an explicit "*" opt-in. These tests cover
// the Slack-specific wiring (env parsing + the loud first-run WARN); the
// underlying engine semantics are covered by portal-sdk's permissions.test.ts.

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    SLACK_ALLOWED_CHANNELS: undefined,
    SLACK_ALLOWED_USERS: undefined,
    SLACK_BLOCKED_USERS: undefined,
    ...overrides,
  };
}

describe("slack permissions — default-deny (G3)", () => {
  it("denies every caller when no SLACK_ALLOWED_* is configured", () => {
    const config = loadPermissionConfig(env());
    const result = checkPermissions(config, { userId: "u1", teamId: "t1", channelId: "c1" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_allowlist_configured");
  });

  it('allows any member when SLACK_ALLOWED_USERS="*" is set (explicit opt-in)', () => {
    const config = loadPermissionConfig(env({ SLACK_ALLOWED_USERS: "*" }));
    const result = checkPermissions(config, { userId: "anyone", teamId: "t1", channelId: "c1" });
    expect(result.allowed).toBe(true);
  });

  it("a channels-only allowlist is enforced normally and not misclassified as unconfigured", () => {
    const config = loadPermissionConfig(env({ SLACK_ALLOWED_CHANNELS: "c1" }));

    const denied = checkPermissions(config, { userId: "u1", teamId: "t1", channelId: "c2" });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("channel_not_allowed");

    const allowed = checkPermissions(config, { userId: "u1", teamId: "t1", channelId: "c1" });
    expect(allowed.allowed).toBe(true);
  });
});

describe("slack permissions — loud first-run WARN (G3)", () => {
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
    loadPermissionConfig(env({ SLACK_ALLOWED_CHANNELS: "c1" }));
    const logged = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes("no_allowlist_configured"))).toBe(false);
  });
});
