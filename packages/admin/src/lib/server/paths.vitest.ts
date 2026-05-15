/**
 * Tests for paths.ts — home directory setup with v0.11.0 final layout.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { ensureHomeDirs } from "@openpalm/lib";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

registerCleanup();

describe("ensureHomeDirs", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OP_HOME = origEnv.OP_HOME;
  });

  test("creates full home directory tree", () => {
    ensureHomeDirs();
    const home = process.env.OP_HOME!;

    // config/ — user-editable + system config files
    expect(existsSync(join(home, "config"))).toBe(true);
    expect(existsSync(join(home, "config", "automations"))).toBe(true);
    expect(existsSync(join(home, "config", "assistant"))).toBe(true);
    expect(existsSync(join(home, "config", "guardian"))).toBe(true);
    expect(existsSync(join(home, "config", "akm"))).toBe(true);

    // cache/ — regenerable data
    expect(existsSync(join(home, "cache", "akm"))).toBe(true);
    expect(existsSync(join(home, "cache", "guardian"))).toBe(true);
    expect(existsSync(join(home, "cache", "rollback"))).toBe(true);

    // state/ — persistent service data
    expect(existsSync(join(home, "state", "assistant"))).toBe(true);
    expect(existsSync(join(home, "state", "admin"))).toBe(true);
    expect(existsSync(join(home, "state", "guardian"))).toBe(true);
    expect(existsSync(join(home, "state", "guardian", "stash"))).toBe(true);
    expect(existsSync(join(home, "state", "guardian", "akm"))).toBe(true);
    expect(existsSync(join(home, "state", "akm", "data"))).toBe(true);
    expect(existsSync(join(home, "state", "scheduler", "triggers"))).toBe(true);
    expect(existsSync(join(home, "state", "logs", "opencode"))).toBe(true);
    expect(existsSync(join(home, "state", "backups"))).toBe(true);
    expect(existsSync(join(home, "state", "registry", "addons"))).toBe(true);
    expect(existsSync(join(home, "state", "registry", "automations"))).toBe(true);

    // stash/, workspace/, stack/
    expect(existsSync(join(home, "stash"))).toBe(true);
    expect(existsSync(join(home, "workspace"))).toBe(true);
    expect(existsSync(join(home, "stack", "addons"))).toBe(true);

    // removed top-levels must NOT exist
    expect(existsSync(join(home, "vault"))).toBe(false);
    expect(existsSync(join(home, "data"))).toBe(false);
    expect(existsSync(join(home, "logs"))).toBe(false);
    expect(existsSync(join(home, "registry"))).toBe(false);
    expect(existsSync(join(home, "services"))).toBe(false);
  });

  test("is idempotent — safe to call multiple times", () => {
    ensureHomeDirs();
    ensureHomeDirs();
    expect(existsSync(join(process.env.OP_HOME!, "config"))).toBe(true);
    expect(existsSync(join(process.env.OP_HOME!, "cache"))).toBe(true);
    expect(existsSync(join(process.env.OP_HOME!, "state"))).toBe(true);
  });
});
