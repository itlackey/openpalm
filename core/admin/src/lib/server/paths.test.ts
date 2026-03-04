/**
 * Tests for paths.ts — XDG directory setup.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureXdgDirs } from "./paths.js";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

describe("ensureXdgDirs", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
    origEnv.OPENPALM_STATE_HOME = process.env.OPENPALM_STATE_HOME;
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;

    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");
  });

  afterEach(() => {
    process.env.OPENPALM_CONFIG_HOME = origEnv.OPENPALM_CONFIG_HOME;
    process.env.OPENPALM_STATE_HOME = origEnv.OPENPALM_STATE_HOME;
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
  });

  test("creates full XDG directory tree", () => {
    ensureXdgDirs();

    const configHome = process.env.OPENPALM_CONFIG_HOME!;
    const stateHome = process.env.OPENPALM_STATE_HOME!;
    const dataHome = process.env.OPENPALM_DATA_HOME!;

    // CONFIG subtrees
    expect(existsSync(configHome)).toBe(true);
    expect(existsSync(join(configHome, "channels"))).toBe(true);
    expect(existsSync(join(configHome, "opencode"))).toBe(true);

    // STATE subtrees
    expect(existsSync(stateHome)).toBe(true);
    expect(existsSync(join(stateHome, "artifacts"))).toBe(true);
    expect(existsSync(join(stateHome, "audit"))).toBe(true);
    expect(existsSync(join(stateHome, "artifacts", "channels"))).toBe(true);

    // DATA subtrees
    expect(existsSync(dataHome)).toBe(true);
    expect(existsSync(join(dataHome, "openmemory"))).toBe(true);
    expect(existsSync(join(dataHome, "caddy"))).toBe(true);
    expect(existsSync(join(dataHome, "caddy", "data"))).toBe(true);
    expect(existsSync(join(dataHome, "caddy", "config"))).toBe(true);
  });

  test("is idempotent — safe to call multiple times", () => {
    ensureXdgDirs();
    ensureXdgDirs(); // No error
    expect(existsSync(process.env.OPENPALM_CONFIG_HOME!)).toBe(true);
  });
});
