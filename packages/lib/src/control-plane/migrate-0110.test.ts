/**
 * Tests for the 0.11.0 auth-migration shim.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateAuth0110 } from "./migrate-0110.js";
import type { ControlPlaneState } from "./types.js";

function makeState(homeDir: string): ControlPlaneState {
  return {
    homeDir,
    configDir: join(homeDir, "config"),
    stashDir: join(homeDir, "stash"),
    workspaceDir: join(homeDir, "workspace"),
    cacheDir: join(homeDir, "cache"),
    stateDir: join(homeDir, "state"),
    stackDir: join(homeDir, "config", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
}

function seedStackEnv(stackDir: string, content: string): string {
  mkdirSync(stackDir, { recursive: true });
  const path = join(stackDir, "stack.env");
  writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe("migrateAuth0110", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-migrate-0110-"));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("no-ops on a fresh install (no stack.env)", () => {
    const state = makeState(homeDir);
    const result = migrateAuth0110(state);
    expect(result.migrated).toBe(false);
    expect(result.reason).toContain("fresh install");
  });

  it("promotes OP_UI_TOKEN → OP_UI_LOGIN_PASSWORD and removes legacy keys", () => {
    const state = makeState(homeDir);
    const stackEnvPath = seedStackEnv(
      state.stackDir,
      [
        "# header",
        "OP_UI_TOKEN=legacy-token-value",
        "OP_ASSISTANT_TOKEN=some-assistant-token",
        "OP_OPENCODE_PASSWORD=opencode-secret",
        "",
      ].join("\n"),
    );

    const result = migrateAuth0110(state);
    expect(result.migrated).toBe(true);
    expect(result.reason).toContain("promoted OP_UI_TOKEN");
    expect(result.reason).toContain("removed OP_UI_TOKEN");
    expect(result.reason).toContain("removed OP_ASSISTANT_TOKEN");

    const after = readFileSync(stackEnvPath, "utf-8");
    expect(after).toContain("OP_UI_LOGIN_PASSWORD=legacy-token-value");
    expect(after).not.toMatch(/^OP_UI_TOKEN=/m);
    expect(after).not.toMatch(/^OP_ASSISTANT_TOKEN=/m);
    // Unrelated keys preserved
    expect(after).toContain("OP_OPENCODE_PASSWORD=opencode-secret");

    // Perms preserved
    expect(statSync(stackEnvPath).mode & 0o777).toBe(0o600);

    // Migration log appended
    const logPath = join(state.stateDir, "logs", "migration-0.11.0.log");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("migrate-auth-0110");
    expect(log).toContain("promoted OP_UI_TOKEN");
  });

  it("does not overwrite an existing OP_UI_LOGIN_PASSWORD", () => {
    const state = makeState(homeDir);
    const stackEnvPath = seedStackEnv(
      state.stackDir,
      [
        "OP_UI_LOGIN_PASSWORD=new-password",
        "OP_UI_TOKEN=legacy-value",
        "",
      ].join("\n"),
    );

    const result = migrateAuth0110(state);
    expect(result.migrated).toBe(true);
    expect(result.reason).not.toContain("promoted");
    expect(result.reason).toContain("removed OP_UI_TOKEN");

    const after = readFileSync(stackEnvPath, "utf-8");
    expect(after).toContain("OP_UI_LOGIN_PASSWORD=new-password");
    expect(after).not.toMatch(/^OP_UI_TOKEN=/m);
  });

  it("removes OP_ASSISTANT_TOKEN even when only it is present", () => {
    const state = makeState(homeDir);
    const stackEnvPath = seedStackEnv(
      state.stackDir,
      [
        "OP_UI_LOGIN_PASSWORD=pw",
        "OP_ASSISTANT_TOKEN=stale",
        "",
      ].join("\n"),
    );

    const result = migrateAuth0110(state);
    expect(result.migrated).toBe(true);
    expect(result.reason).toContain("removed OP_ASSISTANT_TOKEN");
    expect(readFileSync(stackEnvPath, "utf-8")).not.toMatch(/^OP_ASSISTANT_TOKEN=/m);
  });

  it("is idempotent: second run reports already-migrated", () => {
    const state = makeState(homeDir);
    seedStackEnv(
      state.stackDir,
      [
        "OP_UI_TOKEN=t",
        "OP_ASSISTANT_TOKEN=t2",
        "",
      ].join("\n"),
    );

    const first = migrateAuth0110(state);
    expect(first.migrated).toBe(true);

    const second = migrateAuth0110(state);
    expect(second.migrated).toBe(false);
    expect(second.reason).toContain("already migrated");
  });

  it("treats an empty OP_UI_TOKEN value as not-set (no promotion)", () => {
    const state = makeState(homeDir);
    const stackEnvPath = seedStackEnv(
      state.stackDir,
      [
        "OP_UI_TOKEN=",
        "OP_ASSISTANT_TOKEN=foo",
        "",
      ].join("\n"),
    );

    const result = migrateAuth0110(state);
    expect(result.migrated).toBe(true);
    // Empty-string OP_UI_TOKEN should NOT be promoted as a password.
    expect(result.reason).not.toContain("promoted");

    const after = readFileSync(stackEnvPath, "utf-8");
    // The empty OP_UI_TOKEN line is still removed.
    expect(after).not.toMatch(/^OP_UI_TOKEN=/m);
    // No OP_UI_LOGIN_PASSWORD added (would be an empty value).
    expect(after).not.toMatch(/^OP_UI_LOGIN_PASSWORD=/m);
  });
});
