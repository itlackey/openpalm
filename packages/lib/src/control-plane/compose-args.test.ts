/**
 * Tests for canonical compose argument builder.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  COMPOSE_PROJECT_NAME,
  buildComposeOptions,
  buildComposeCliArgs,
} from "./compose-args.js";
import type { ControlPlaneState } from "./types.js";

let tempDir: string;

function makeState(overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  const configDir = join(tempDir, "config");
  return {
    homeDir: tempDir,
    configDir,
    stashDir: join(tempDir, "stash"),
    workspaceDir: join(tempDir, "workspace"),
    cacheDir: join(tempDir, "cache"),
    stateDir: join(tempDir, "state"),
    stackDir: join(configDir, "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
    audit: [],
    ...overrides,
  };
}

function seedCoreCompose(): void {
  const stackDir = join(tempDir, "config", "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");
}

function seedEnvFiles(files: { stack?: boolean; guardian?: boolean } = {}): void {
  const stackDir = join(tempDir, "config", "stack");
  if (files.stack) {
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "stack.env"), "KEY=val");
  }
  if (files.guardian) {
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "guardian.env"), "CHANNEL_CHAT_SECRET=abc");
  }
}

function seedAddon(name: string): void {
  const addonDir = join(tempDir, "config", "stack", "addons", name);
  mkdirSync(addonDir, { recursive: true });
  writeFileSync(join(addonDir, "compose.yml"), "services: {}");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "compose-args-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── COMPOSE_PROJECT_NAME ─────────────────────────────────────────────────

describe("COMPOSE_PROJECT_NAME", () => {
  it("is 'openpalm'", () => {
    expect(COMPOSE_PROJECT_NAME).toBe("openpalm");
  });
});

// ── buildComposeOptions ──────────────────────────────────────────────────

describe("buildComposeOptions", () => {
  it("returns core compose file when present", () => {
    seedCoreCompose();
    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.files).toHaveLength(1);
    expect(opts.files[0]).toContain("core.compose.yml");
  });

  it("includes addon overlays when compose files are present in stack/addons", () => {
    seedCoreCompose();
    seedAddon("chat");

    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.files).toHaveLength(2);
    expect(opts.files[1]).toContain("chat");
  });

  it("returns env files in correct order", () => {
    // Note: vault/user/user.env is no longer a
    // compose env_file. The runtime env file list is: stack.env, guardian.env.
    // Even when a legacy user.env is present on disk, it is intentionally
    // excluded from the compose args.
    seedEnvFiles({ stack: true, guardian: true });
    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.envFiles).toHaveLength(2);
    expect(opts.envFiles[0]).toContain("stack.env");
    expect(opts.envFiles[1]).toContain("guardian.env");
  });

  it("excludes missing env files", () => {
    // No env files seeded
    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.envFiles).toHaveLength(0);
  });
});

// ── buildComposeCliArgs ──────────────────────────────────────────────────

describe("buildComposeCliArgs", () => {
  it("starts with --project-name openpalm", () => {
    seedCoreCompose();
    const state = makeState();
    const args = buildComposeCliArgs(state);
    expect(args[0]).toBe("--project-name");
    expect(args[1]).toBe("openpalm");
  });

  it("includes -f flags for compose files", () => {
    seedCoreCompose();
    const state = makeState();
    const args = buildComposeCliArgs(state);
    const fIdx = args.indexOf("-f");
    expect(fIdx).toBeGreaterThan(-1);
    expect(args[fIdx + 1]).toContain("core.compose.yml");
  });

  it("includes --env-file flags for env files that exist", () => {
    // Note: vault/user/user.env is no longer
    // listed in the compose env_file set. Only stack.env and guardian.env
    // (when present) are passed via --env-file.
    seedCoreCompose();
    seedEnvFiles({ stack: true, guardian: true });
    const state = makeState();
    const args = buildComposeCliArgs(state);
    const envFileIndices = args.reduce<number[]>((acc, arg, i) => {
      if (arg === "--env-file") acc.push(i);
      return acc;
    }, []);
    expect(envFileIndices).toHaveLength(2);
  });

  it("does not include --env-file for missing files", () => {
    seedCoreCompose();
    const state = makeState();
    const args = buildComposeCliArgs(state);
    expect(args).not.toContain("--env-file");
  });

  it("includes addon overlays in -f flags", () => {
    seedCoreCompose();
    seedAddon("chat");

    const state = makeState();
    const args = buildComposeCliArgs(state);
    const fFlags = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "-f" && args[i + 1]) acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(fFlags).toHaveLength(2);
    expect(fFlags[1]).toContain("chat");
  });
});
