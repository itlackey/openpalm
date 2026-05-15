/**
 * Tests for paths.ts — home directory setup with new v0.11.0 layout.
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

    // config/ — user-editable
    expect(existsSync(join(home, "config"))).toBe(true);
    expect(existsSync(join(home, "config", "automations"))).toBe(true);
    expect(existsSync(join(home, "config", "assistant"))).toBe(true);
    expect(existsSync(join(home, "config", "guardian"))).toBe(true);

    // stash/ — akm knowledge
    expect(existsSync(join(home, "stash"))).toBe(true);

    // workspace/ — shared work area
    expect(existsSync(join(home, "workspace"))).toBe(true);

    // services/ — container bind mounts
    expect(existsSync(join(home, "services", "assistant"))).toBe(true);
    expect(existsSync(join(home, "services", "admin"))).toBe(true);
    expect(existsSync(join(home, "services", "guardian"))).toBe(true);
    expect(existsSync(join(home, "services", "guardian", "stash"))).toBe(true);
    expect(existsSync(join(home, "services", "guardian", "akm"))).toBe(true);

    // state/ — system-managed
    expect(existsSync(join(home, "state"))).toBe(true);
    expect(existsSync(join(home, "state", "akm", "config"))).toBe(true);
    expect(existsSync(join(home, "state", "akm", "data"))).toBe(true);
    expect(existsSync(join(home, "state", "scheduler", "triggers"))).toBe(true);
    expect(existsSync(join(home, "state", "logs", "opencode"))).toBe(true);
    expect(existsSync(join(home, "state", "backups"))).toBe(true);
    expect(existsSync(join(home, "state", "registry", "addons"))).toBe(true);
    expect(existsSync(join(home, "state", "registry", "automations"))).toBe(true);
    expect(existsSync(join(home, "state", "cache", "akm"))).toBe(true);
    expect(existsSync(join(home, "state", "cache", "guardian"))).toBe(true);
    expect(existsSync(join(home, "state", "cache", "rollback"))).toBe(true);

    // stack/ — compose runtime
    expect(existsSync(join(home, "stack"))).toBe(true);
    expect(existsSync(join(home, "stack", "addons"))).toBe(true);

    // vault/ and data/ must NOT exist — removed in v0.11.0
    expect(existsSync(join(home, "vault"))).toBe(false);
    expect(existsSync(join(home, "data"))).toBe(false);
    expect(existsSync(join(home, "logs"))).toBe(false);
    expect(existsSync(join(home, "registry"))).toBe(false);
  });

  test("is idempotent — safe to call multiple times", () => {
    ensureHomeDirs();
    ensureHomeDirs();
    expect(existsSync(join(process.env.OP_HOME!, "config"))).toBe(true);
    expect(existsSync(join(process.env.OP_HOME!, "stash"))).toBe(true);
    expect(existsSync(join(process.env.OP_HOME!, "state"))).toBe(true);
  });
});
