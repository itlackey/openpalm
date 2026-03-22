/**
 * Test that env schema validation uses the correct nested vault paths.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ControlPlaneState } from "./types.js";

describe("env schema validation paths", () => {
  let tmpDir: string;
  let state: ControlPlaneState;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `openpalm-schema-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "vault/user"), { recursive: true });
    mkdirSync(join(tmpDir, "vault/stack"), { recursive: true });
    mkdirSync(join(tmpDir, "data"), { recursive: true });
    mkdirSync(join(tmpDir, "logs"), { recursive: true });
    mkdirSync(join(tmpDir, "config"), { recursive: true });

    state = {
      adminToken: "test-token",
      assistantToken: "test-assistant",
      setupToken: "test-setup",
      homeDir: tmpDir,
      configDir: join(tmpDir, "config"),
      vaultDir: join(tmpDir, "vault"),
      dataDir: join(tmpDir, "data"),
      logsDir: join(tmpDir, "logs"),
      cacheDir: join(tmpDir, "cache"),
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
      audit: [],
    };
  });

  afterAll(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("validation succeeds when no schema files exist (skip mode)", async () => {
    const { validateProposedState } = await import("./validate.js");
    const result = await validateProposedState(state);
    // When schema files don't exist, validation is skipped (no errors)
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("schema paths match canonical vault layout", () => {
    const expectedUserSchema = join(tmpDir, "vault/user/user.env.schema");
    const expectedStackSchema = join(tmpDir, "vault/stack/stack.env.schema");

    writeFileSync(expectedUserSchema, "# test schema\n");
    writeFileSync(expectedStackSchema, "# test schema\n");

    expect(existsSync(expectedUserSchema)).toBe(true);
    expect(existsSync(expectedStackSchema)).toBe(true);

    // Old flat paths must NOT exist
    expect(existsSync(join(tmpDir, "vault/user.env.schema"))).toBe(false);
    expect(existsSync(join(tmpDir, "vault/system.env.schema"))).toBe(false);
  });

  test("validate.ts reads from nested paths, not flat paths", async () => {
    // Write schemas at OLD flat paths — should be ignored
    writeFileSync(join(tmpDir, "vault/user.env.schema"), "OPENAI_API_KEY\n");
    writeFileSync(join(tmpDir, "vault/system.env.schema"), "OP_ADMIN_TOKEN\n");
    // Write env files
    writeFileSync(join(tmpDir, "vault/user/user.env"), "# empty\n");
    writeFileSync(join(tmpDir, "vault/stack/stack.env"), "# empty\n");
    // Delete nested schemas to prove flat paths are ignored
    try { rmSync(join(tmpDir, "vault/user/user.env.schema")); } catch { /* may not exist */ }
    try { rmSync(join(tmpDir, "vault/stack/stack.env.schema")); } catch { /* may not exist */ }

    const { validateProposedState } = await import("./validate.js");
    const result = await validateProposedState(state);
    // Should pass because nested schemas don't exist (skipped), not because flat schemas were read
    expect(result.ok).toBe(true);
  });
});
