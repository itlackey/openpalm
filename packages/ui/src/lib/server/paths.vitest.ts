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
    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    const home = process.env.OP_HOME!;

    // config/ — user-editable + system config files
    expect(existsSync(join(home, "config"))).toBe(true);
    expect(existsSync(join(home, "config", "assistant"))).toBe(true);
    expect(existsSync(join(home, "config", "guardian"))).toBe(true);
    expect(existsSync(join(home, "config", "akm"))).toBe(true);

    // cache/ — regenerable container caches (§S1). Pre-created here, and
    // deliberately operator-owned: Docker creates a MISSING bind-mount source
    // root-owned, which is what broke rootless in the first S1 attempt.
    expect(existsSync(join(home, "cache"))).toBe(true);
    expect(existsSync(join(home, "cache", "assistant"))).toBe(true);
    // The guardian's bun/npm cache — NOT the old per-service AKM cache this
    // suite used to assert against (the guardian still makes no akm calls).
    expect(existsSync(join(home, "cache", "guardian"))).toBe(true);

    // The abandoned cache-everything layout stays abandoned: only the two
    // service cache dirs live here, never durable state.
    expect(existsSync(join(home, "cache", "akm"))).toBe(false);
    expect(existsSync(join(home, "cache", "rollback"))).toBe(false);
    expect(existsSync(join(home, "cache", "logs"))).toBe(false);
    expect(existsSync(join(home, "cache", "backups"))).toBe(false);

    // data/ — persistent service data
    expect(existsSync(join(home, "data", "assistant"))).toBe(true);
    // data/admin removed — admin UI is a host process, nothing mounts it
    expect(existsSync(join(home, "data", "admin"))).toBe(false);
    expect(existsSync(join(home, "data", "guardian"))).toBe(true);
    expect(existsSync(join(home, "data", "akm"))).toBe(true);
    expect(existsSync(join(home, "data", "akm", "cache"))).toBe(true);
    expect(existsSync(join(home, "data", "akm", "data"))).toBe(true);
    expect(existsSync(join(home, "data", "akm", "state"))).toBe(true);
    // guardian AKM subdirs removed — guardian has no akm CLI invocations
    expect(existsSync(join(home, "data", "guardian", "knowledge"))).toBe(false);
    expect(existsSync(join(home, "data", "guardian", "akm"))).toBe(false);
    expect(existsSync(join(home, "data", "logs"))).toBe(true);
    expect(existsSync(join(home, "data", "backups"))).toBe(true);
    expect(existsSync(join(home, "data", "rollback"))).toBe(true);
    expect(existsSync(join(home, "data", "registry"))).toBe(false);

    // knowledge/, workspace/, system/stack/
    expect(existsSync(join(home, "knowledge", "tasks"))).toBe(true);
    expect(existsSync(join(home, "knowledge"))).toBe(true);
    expect(existsSync(join(home, "workspace"))).toBe(true);
    expect(existsSync(join(home, "system", "stack"))).toBe(true);
    expect(existsSync(join(home, "system", "stack", "addons"))).toBe(false);
    // config/stack holds the USER-owned custom.compose.yml overlay (created, seeded once)
    expect(existsSync(join(home, "config", "stack"))).toBe(true);

    // removed top-levels must NOT exist
    expect(existsSync(join(home, "vault"))).toBe(false);
    // state/ is now a created managed tree (app-written pins/addons/setup)
    expect(existsSync(join(home, "state"))).toBe(true);
    expect(existsSync(join(home, "logs"))).toBe(false);
    expect(existsSync(join(home, "registry"))).toBe(false);
    expect(existsSync(join(home, "services"))).toBe(false);
  });

  test("is idempotent — safe to call multiple times", () => {
    ensureHomeDirs();
    ensureHomeDirs();
    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    expect(existsSync(join(process.env.OP_HOME!, "config"))).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    expect(existsSync(join(process.env.OP_HOME!, "data"))).toBe(true);
  });
});
