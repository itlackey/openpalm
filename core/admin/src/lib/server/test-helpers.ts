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
  channels: { name: string; yml: string; caddy?: string }[]
): void {
  const channelsDir = join(configDir, "channels");
  mkdirSync(channelsDir, { recursive: true });
  for (const ch of channels) {
    writeFileSync(join(channelsDir, `${ch.name}.yml`), ch.yml);
    if (ch.caddy) {
      writeFileSync(join(channelsDir, `${ch.name}.caddy`), ch.caddy);
    }
  }
}

export function seedSecretsEnv(configDir: string, content: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "secrets.env"), content);
}

export function makeTestState(overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  const stateDir = makeTempDir();
  const configDir = makeTempDir();
  const dataDir = makeTempDir();
  return {
    adminToken: "test-admin-token",
    setupToken: "test-setup-token",
    postgresPassword: "test-pg-password",
    stateDir,
    configDir,
    dataDir,
    services: {},
    artifacts: { compose: "", caddyfile: "" },
    artifactMeta: [],
    audit: [],
    channelSecrets: {},
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
