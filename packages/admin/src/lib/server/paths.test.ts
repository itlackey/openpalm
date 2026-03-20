/**
 * Tests for paths.ts — home directory setup.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureXdgDirs } from "./paths.js";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

describe("ensureXdgDirs (ensureHomeDirs)", () => {
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
    ensureXdgDirs();

    const home = process.env.OP_HOME!;
    const configDir = join(home, "config");
    const vaultDir = join(home, "vault");
    const dataDir = join(home, "data");
    const logsDir = join(home, "logs");

    // config/ subtrees
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, "components"))).toBe(true);
    expect(existsSync(join(configDir, "automations"))).toBe(true);
    expect(existsSync(join(configDir, "assistant"))).toBe(true);

    // vault/
    expect(existsSync(vaultDir)).toBe(true);

    // data/ subtrees
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(join(dataDir, "assistant"))).toBe(true);
    expect(existsSync(join(dataDir, "admin"))).toBe(true);
    expect(existsSync(join(dataDir, "memory"))).toBe(true);
    expect(existsSync(join(dataDir, "guardian"))).toBe(true);
    expect(existsSync(join(dataDir, "stash"))).toBe(true);
    expect(existsSync(join(dataDir, "workspace"))).toBe(true);

    // logs/ subtrees
    expect(existsSync(logsDir)).toBe(true);
    expect(existsSync(join(logsDir, "opencode"))).toBe(true);
  });

  test("is idempotent — safe to call multiple times", () => {
    ensureXdgDirs();
    ensureXdgDirs(); // No error
    expect(existsSync(join(process.env.OP_HOME!, "config"))).toBe(true);
  });
});
