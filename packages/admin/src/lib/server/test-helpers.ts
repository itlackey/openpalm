/**
 * Shared test utilities for control-plane module tests.
 */
import { afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { ControlPlaneState } from "./types.js";
import { createState } from "@openpalm/lib";
import { _replaceState, getState } from "./state.js";

let tempDirs: string[] = [];

export function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function seedSecretsEnv(vaultDir: string, content: string): void {
  mkdirSync(join(vaultDir, "stack"), { recursive: true });
  writeFileSync(join(vaultDir, "stack", "stack.env"), content);
}

export function makeTestState(overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  const tempDir = makeTempDir();
  return {
    adminToken: "test-admin-token",
    assistantToken: "test-assistant-token",
    setupToken: "test-setup-token",
    homeDir: tempDir,
    configDir: join(tempDir, "config"),
    vaultDir: join(tempDir, "vault"),
    dataDir: join(tempDir, "data"),
    logsDir: join(tempDir, "logs"),
    cacheDir: join(tempDir, "cache"),
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
 * Creates a fresh state with the given admin token.
 */
export function resetState(token?: string): ControlPlaneState {
  const state = createState(token);
  _replaceState(state);
  return state;
}
