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

  it("treats an empty allow set as unrestricted (empty-allowlist semantics)", () => {
    const result = checkPermissions(
      ruleSet({
        rules: [{ allowedSet: new Set(), actualValues: [""], reason: "user_not_allowed" }],
      }),
      { userId: "" },
    );
    expect(result.allowed).toBe(true);
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
