import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../src/commands/admin.ts"), "utf-8");

describe("admin command source validation", () => {
  it("loads state env, assistant state env, then merges with Bun.env", () => {
    expect(source).toContain("join(stateRoot, \".env\")");
    expect(source).toContain("assistant/.env");
    expect(source).toContain("await readEnvFile(stateEnvPath)");
    expect(source).toContain("await readEnvFile(assistantStateEnvPath)");
    expect(source).toContain("...stateEnv");
    expect(source).toContain("...assistantStateEnv");
    expect(source).toContain("...Bun.env");
  });

  it("uses shared secure admin client helpers", () => {
    expect(source).toContain("resolveAdminBaseUrl");
    expect(source).toContain("resolveAdminToken");
    expect(source).toContain("validateAdminBaseUrl");
    expect(source).toContain("OPENPALM_ALLOW_INSECURE_ADMIN_HTTP");
  });
});
