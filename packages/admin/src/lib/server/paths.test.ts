/**
 * Tests for paths.ts — home directory setup.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureHomeDirs } from "./paths.js";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

describe("ensureHomeDirs", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OP_HOME = process.env.OP_HOME;

    const base = trackDir(makeTempDir());
    process.env.OP_HOME = base;
  });

  afterEach(() => {
    process.env.OP_HOME = origEnv.OP_HOME;
  });

  test("creates full home directory tree", () => {
    ensureHomeDirs();

    const home = process.env.OP_HOME!;
    const configDir = join(home, "config");
    const vaultDir = join(home, "vault");
    const dataDir = join(home, "data");
    const logsDir = join(home, "logs");

    // config/ subtrees
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, "automations"))).toBe(true);
    expect(existsSync(join(configDir, "assistant"))).toBe(true);
    expect(existsSync(join(configDir, "guardian"))).toBe(true);

    // vault/ subtrees
    expect(existsSync(vaultDir)).toBe(true);
    expect(existsSync(join(vaultDir, "stack"))).toBe(true);
    expect(existsSync(join(vaultDir, "stack", "addons"))).toBe(true);
    expect(existsSync(join(vaultDir, "user"))).toBe(true);

    // data/ subtrees
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(join(dataDir, "assistant"))).toBe(true);
    expect(existsSync(join(dataDir, "admin"))).toBe(true);
    expect(existsSync(join(dataDir, "memory"))).toBe(true);
    expect(existsSync(join(dataDir, "guardian"))).toBe(true);
    expect(existsSync(join(dataDir, "stash"))).toBe(true);

    // stack/ subtrees
    expect(existsSync(join(home, "stack"))).toBe(true);
    expect(existsSync(join(home, "stack", "addons"))).toBe(true);

    // backups/
    expect(existsSync(join(home, "backups"))).toBe(true);

    // workspace/
    expect(existsSync(join(home, "workspace"))).toBe(true);

    // logs/ subtrees
    expect(existsSync(logsDir)).toBe(true);
    expect(existsSync(join(logsDir, "opencode"))).toBe(true);
  });

  test("is idempotent — safe to call multiple times", () => {
    ensureHomeDirs();
    ensureHomeDirs(); // No error
    expect(existsSync(join(process.env.OP_HOME!, "config"))).toBe(true);
  });
});
