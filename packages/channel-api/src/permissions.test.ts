/**
 * API channel non-interactive permission policy — PURE unit tests (design §4.5).
 *
 * The load-bearing security property: the DEFAULT is fail-closed reject, and
 * auto-approval only ever fires for a tool that is EXPLICITLY on the allowlist.
 * Nothing is approved by default; an `auto` mode with an empty (or non-matching)
 * allowlist still rejects every request.
 */
import { describe, test, expect } from "bun:test";
import type { PermissionAsk } from "@openpalm/channels-sdk";
import { loadPermissionPolicy, decidePermission } from "./permissions.ts";

function ask(permission: string): PermissionAsk {
  return { requestID: "per_1", permission, patterns: [] };
}

describe("loadPermissionPolicy — defaults fail-closed", () => {
  test("no env → reject mode", () => {
    const p = loadPermissionPolicy({});
    expect(p.mode).toBe("reject");
    expect(p.allowlist.size).toBe(0);
  });

  test("unknown mode value → reject (not auto)", () => {
    expect(loadPermissionPolicy({ OP_API_PERMISSION_MODE: "yes-please" }).mode).toBe("reject");
  });

  test("auto mode parses an allowlist", () => {
    const p = loadPermissionPolicy({ OP_API_PERMISSION_MODE: "auto", OP_API_PERMISSION_ALLOWLIST: "bash, edit" });
    expect(p.mode).toBe("auto");
    expect([...p.allowlist].sort()).toEqual(["bash", "edit"]);
  });

  test("mode is case/space tolerant", () => {
    expect(loadPermissionPolicy({ OP_API_PERMISSION_MODE: "  AUTO  " }).mode).toBe("auto");
  });
});

describe("decidePermission — default reject (§4.5)", () => {
  test("reject mode denies every request", () => {
    const p = loadPermissionPolicy({});
    expect(decidePermission(p, ask("bash"))).toBe("reject");
    expect(decidePermission(p, ask("edit"))).toBe("reject");
    expect(decidePermission(p, ask("task"))).toBe("reject");
  });

  test("auto mode with EMPTY allowlist still rejects (no accidental open door)", () => {
    const p = loadPermissionPolicy({ OP_API_PERMISSION_MODE: "auto" });
    expect(decidePermission(p, ask("bash"))).toBe("reject");
  });

  test("auto mode approves ONLY allowlisted tools", () => {
    const p = loadPermissionPolicy({ OP_API_PERMISSION_MODE: "auto", OP_API_PERMISSION_ALLOWLIST: "bash" });
    expect(decidePermission(p, ask("bash"))).toBe("once");
    // A tool NOT on the allowlist still rejects.
    expect(decidePermission(p, ask("edit"))).toBe("reject");
  });
});
