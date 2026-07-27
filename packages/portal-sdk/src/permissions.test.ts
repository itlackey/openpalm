import { describe, expect, it } from "bun:test";
import { checkPermissions } from "./permissions.ts";
import type { PermissionRuleSet } from "./permissions.ts";

function ruleSet(overrides: Partial<PermissionRuleSet> = {}): PermissionRuleSet {
  return { blocked: new Set(), rules: [], ...overrides };
}

describe("checkPermissions engine", () => {
  it("denies a blocked user before any allow-list check", () => {
    const result = checkPermissions(
      ruleSet({
        blocked: new Set(["u1"]),
        // even a matching allow rule must not rescue a blocked user
        rules: [{ allowedSet: new Set(["u1"]), actualValues: ["u1"], reason: "user_not_allowed" }],
      }),
      { userId: "u1", username: "blocked-guy" },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_blocked");
  });

  it("denies when a non-empty allow set has no matching actual value, using that rule's reason", () => {
    const result = checkPermissions(
      ruleSet({
        rules: [{ allowedSet: new Set(["allowed"]), actualValues: ["actual"], reason: "guild_not_allowed" }],
      }),
      { userId: "u1" },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("guild_not_allowed");
  });

  it("allows when an actual value is in the allow set", () => {
    const result = checkPermissions(
      ruleSet({
        rules: [{ allowedSet: new Set(["a", "b"]), actualValues: ["member", "b"], reason: "role_not_allowed" }],
      }),
      { userId: "u1" },
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // G3: portals are default-deny now. When EVERY rule's allowedSet is empty,
  // there is no allowlist configured at all, so the caller is denied rather
  // than silently let through — the prior "empty allow-list semantics" (open
  // by default) was the confirmed vulnerability.
  it("denies with 'no_allowlist_configured' when every rule's allow set is empty", () => {
    const result = checkPermissions(
      ruleSet({
        rules: [{ allowedSet: new Set(), actualValues: [""], reason: "user_not_allowed" }],
      }),
      { userId: "" },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_allowlist_configured");
  });

  it("denies with 'no_allowlist_configured' when multiple rules are all empty", () => {
    const result = checkPermissions(
      ruleSet({
        rules: [
          { allowedSet: new Set(), actualValues: ["u1"], reason: "user_not_allowed" },
          { allowedSet: new Set(), actualValues: ["g1"], reason: "guild_not_allowed" },
          { allowedSet: new Set(), actualValues: [], reason: "role_not_allowed" },
        ],
      }),
      { userId: "u1" },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("no_allowlist_configured");
  });

  it("is not denied by 'no_allowlist_configured' when at least one scope is configured (channels-only allowlist is not misclassified)", () => {
    // Mirrors a Slack config with only SLACK_ALLOWED_CHANNELS set: the
    // users scope is empty (unrestricted-for-that-scope) but the channels
    // scope is non-empty and must still be enforced normally, not treated as
    // "nothing configured".
    const result = checkPermissions(
      ruleSet({
        rules: [
          { allowedSet: new Set(), actualValues: ["u1"], reason: "user_not_allowed" },
          { allowedSet: new Set(["c1"]), actualValues: ["c2"], reason: "channel_not_allowed" },
        ],
      }),
      { userId: "u1" },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("channel_not_allowed");
  });

  it("treats a scope whose allow set contains '*' as an explicit unrestricted opt-in", () => {
    const result = checkPermissions(
      ruleSet({
        rules: [{ allowedSet: new Set(["*"]), actualValues: ["anyone"], reason: "user_not_allowed" }],
      }),
      { userId: "anyone" },
    );
    expect(result.allowed).toBe(true);
  });

  it("'*' opt-in on one scope does not bypass a genuinely non-matching, non-wildcard scope", () => {
    const result = checkPermissions(
      ruleSet({
        rules: [
          { allowedSet: new Set(["*"]), actualValues: ["anyone"], reason: "user_not_allowed" },
          { allowedSet: new Set(["g1"]), actualValues: ["g2"], reason: "guild_not_allowed" },
        ],
      }),
      { userId: "anyone" },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("guild_not_allowed");
  });

  it("denies when the only actual value is empty against a non-empty allow set", () => {
    const result = checkPermissions(
      ruleSet({
        rules: [{ allowedSet: new Set(["u1"]), actualValues: [""], reason: "user_not_allowed" }],
      }),
      { userId: "" },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("user_not_allowed");
  });

  it("returns the first failing rule's reason when multiple scopes are configured", () => {
    const result = checkPermissions(
      ruleSet({
        rules: [
          { allowedSet: new Set(["g1"]), actualValues: ["g1"], reason: "guild_not_allowed" },
          { allowedSet: new Set(["admin"]), actualValues: ["member"], reason: "role_not_allowed" },
        ],
      }),
      { userId: "u1" },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("role_not_allowed");
  });
});
