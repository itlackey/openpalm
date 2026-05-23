/**
 * Shared test utilities for control-plane module tests.
 */
import { afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { ControlPlaneState } from "@openpalm/lib";
import { createState } from "@openpalm/lib";
import { _replaceState, getState } from "./state.js";

let tempDirs: string[] = [];

export function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Seed the stack.env file into a stateDir.
 * The file lives at ${stateDir}/stack.env (flat, no subdirectory).
 */
export function seedSecretsEnv(stateDir: string, content: string): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "stack.env"), content);
}

export function makeTestState(overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  const tempDir = makeTempDir();
  return {
    homeDir: tempDir,
    configDir: join(tempDir, "config"),
    stashDir: join(tempDir, "stash"),
    workspaceDir: join(tempDir, "workspace"),
    cacheDir: join(tempDir, "cache"),
    stateDir: join(tempDir, "state"),
    stackDir: join(tempDir, "config", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
    audit: [],
    ...overrides
  };
}

export function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
}

/**
 * Call this in each test file to register the afterEach cleanup hook.
 * Must be called at the top level of a describe or test file.
 */
export function registerCleanup(): void {
  afterEach(() => {
    cleanupTempDirs();
  });
}

/**
 * Reset the singleton control-plane state for testing.
 *
 * After Phase 4 of the auth/proxy refactor, `createState()` no longer
 * accepts a token argument — the operator login password lives in
 * `process.env.OP_UI_LOGIN_PASSWORD`. Pass a string here to set the env
 * var for the rest of the test (callers should reset it in `afterEach`
 * if they need isolation).
 */
export function resetState(uiLoginPassword?: string): ControlPlaneState {
  if (uiLoginPassword !== undefined) {
    process.env.OP_UI_LOGIN_PASSWORD = uiLoginPassword;
  }
  const state = createState();
  _replaceState(state);
  return state;
}
