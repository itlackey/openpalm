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

let tempDirs: string[] = [];

export function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function seedConfigChannels(
  configDir: string,
  channels: { name: string; yml: string }[]
): void {
  const componentsDir = join(configDir, "components");
  mkdirSync(componentsDir, { recursive: true });
  for (const ch of channels) {
    writeFileSync(join(componentsDir, `channel-${ch.name}.yml`), ch.yml);
  }
}

export function seedSecretsEnv(vaultDir: string, content: string): void {
  mkdirSync(join(vaultDir, "user"), { recursive: true });
  writeFileSync(join(vaultDir, "user", "user.env"), content);
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
