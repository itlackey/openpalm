import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../src/commands/admin.ts"), "utf-8");

describe("admin command source validation", () => {
  it("supports generic command execution through /command", () => {
    expect(source).toContain('if (subcommand !== "command")');
    expect(source).toContain("client.command(commandType, payload)");
  });

  it("loads state env then merges with Bun.env", () => {
    expect(source).toContain("join(resolveXDGPaths().state, \".env\")");
    expect(source).toContain("await readEnvFile(stateEnvPath)");
    expect(source).toContain("...stateEnv");
    expect(source).toContain("...Bun.env");
  });

  it("uses shared secure admin client helpers", () => {
    expect(source).toContain("resolveAdminBaseUrl");
    expect(source).toContain("resolveAdminToken");
    expect(source).toContain("validateAdminBaseUrl");
    expect(source).toContain("OPENPALM_ALLOW_INSECURE_ADMIN_HTTP");
  });
});
