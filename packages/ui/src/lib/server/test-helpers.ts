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
import { createState, initializeStateSecrets, legacyStackEnvFile } from "@openpalm/lib";
import { dirname } from "node:path";
import { _replaceState } from "./state.js";
import { _seedSession, _clearSessions } from "./session-store.js";

let tempDirs: string[] = [];

export function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve the stack.env path (knowledge/env/stack.env) from an OP_HOME root. */
export function stackEnvFor(homeDir: string): string {
  return legacyStackEnvFile(homeDir);
}

/**
 * Seed the stack.env file. Callers pass the `stackDir` (`<home>/config/stack`);
 * the file is written to `<home>/knowledge/env/stack.env`.
 */
export function seedSecretsEnv(homeDir: string, content: string): void {
  const path = legacyStackEnvFile(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function makeTestState(overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  const tempDir = makeTempDir();
  return {
    homeDir: tempDir,
    configDir: join(tempDir, "config"),
    stashDir: join(tempDir, "knowledge"),
    workspaceDir: join(tempDir, "workspace"),
    dataDir: join(tempDir, "data"),
    stackDir: join(tempDir, "system", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
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
  initializeStateSecrets(state);
  if (uiLoginPassword !== undefined) {
    // Secret bootstrap may override the test-provided login password; restore it.
    process.env.OP_UI_LOGIN_PASSWORD = uiLoginPassword;
    // Seed the password value as a valid session token so tests can pass it
    // directly as the op_session cookie value without calling createSession().
    _clearSessions();
    _seedSession(uiLoginPassword);
  }
  _replaceState(state);
  return state;
}
