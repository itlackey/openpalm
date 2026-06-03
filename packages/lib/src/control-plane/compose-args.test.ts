/**
 * Tests for canonical compose argument builder.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
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
    stashDir: join(tempDir, "knowledge"),
    workspaceDir: join(tempDir, "workspace"),
    dataDir: join(tempDir, "data"),
    stackDir: join(configDir, "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
    ...overrides,
  };
}

function seedCoreCompose(): void {
  const stackDir = join(tempDir, "config", "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");
}

function seedEnvFiles(files: { stack?: boolean } = {}): void {
  if (files.stack) {
    const envDir = join(tempDir, "knowledge", "env");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "stack.env"), "KEY=val");
  }
}

function seedAddon(name: string): void {
  const stackDir = join(tempDir, "config", "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, "channels.compose.yml"), `services:\n  ${name}:\n    profiles: [\"addon.${name}\"]\n    image: test\n`);
  writeFileSync(join(stackDir, "stack.yml"), `version: 2\naddons:\n  - ${name}\n`);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "compose-args-test-"));
  process.env.OP_HOME = tempDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
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

  it("includes fixed channel compose and profile from stack.yml", () => {
    seedCoreCompose();
    seedAddon("chat");

    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.files).toHaveLength(2);
    expect(opts.files[1]).toContain("channels.compose.yml");
    expect(opts.profiles).toContain("addon.chat");
  });

  it("includes the user custom compose file", () => {
    seedCoreCompose();
    const stackDir = join(tempDir, "config", "stack");
    writeFileSync(join(stackDir, "custom.compose.yml"), "services: {}");

    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.files).toHaveLength(2);
    expect(opts.files[1]).toContain("custom.compose.yml");
  });

  it("returns env files in correct order", () => {
    // The runtime --env-file list is knowledge/env/stack.env only. The user env
    // (knowledge/env/user.env) is sourced by the assistant entrypoint, not a
    // compose env_file.
    seedEnvFiles({ stack: true });
    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.envFiles).toHaveLength(1);
    expect(opts.envFiles[0]).toContain("stack.env");
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

  it("uses OP_PROJECT_NAME from stack.env", () => {
    seedCoreCompose();
    seedEnvFiles({ stack: true });
    writeFileSync(join(tempDir, "knowledge", "env", "stack.env"), "OP_PROJECT_NAME=openpalm-test\n");
    const state = makeState();
    const args = buildComposeCliArgs(state);
    expect(args[0]).toBe("--project-name");
    expect(args[1]).toBe("openpalm-test");
  });

  it("uses canonical voice and ollama profile ids", () => {
    seedCoreCompose();
    seedEnvFiles({ stack: true });
    writeFileSync(join(tempDir, "knowledge", "env", "stack.env"), "OP_VOICE_PROFILE=addon.voice.cuda\nOP_OLLAMA_PROFILE=addon.ollama.cpu\n");
    const state = makeState();
    const args = buildComposeCliArgs(state);
    expect(args).toContain("addon.voice.cuda");
    expect(args).toContain("addon.ollama.cpu");
  });

  it("ignores non-canonical addon profile ids", () => {
    seedCoreCompose();
    seedEnvFiles({ stack: true });
    writeFileSync(join(tempDir, "knowledge", "env", "stack.env"), "OP_VOICE_PROFILE=not-canonical\nOP_OLLAMA_PROFILE=also-not-canonical\n");
    const state = makeState();
    const args = buildComposeCliArgs(state);
    expect(args).not.toContain("not-canonical");
    expect(args).not.toContain("also-not-canonical");
    expect(args).not.toContain("addon.voice.cuda");
    expect(args).not.toContain("addon.ollama.cpu");
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
    // Only knowledge/env/stack.env is passed via --env-file.
    seedCoreCompose();
    seedEnvFiles({ stack: true });
    const state = makeState();
    const args = buildComposeCliArgs(state);
    const envFileIndices = args.reduce<number[]>((acc, arg, i) => {
      if (arg === "--env-file") acc.push(i);
      return acc;
    }, []);
    expect(envFileIndices).toHaveLength(1);
  });

  it("does not include --env-file for missing files", () => {
    seedCoreCompose();
    const state = makeState();
    const args = buildComposeCliArgs(state);
    expect(args).not.toContain("--env-file");
  });

  it("includes fixed channel compose in -f flags", () => {
    seedCoreCompose();
    seedAddon("chat");

    const state = makeState();
    const args = buildComposeCliArgs(state);
    const fFlags = args.reduce<string[]>((acc, arg, i) => {
      if (arg === "-f" && args[i + 1]) acc.push(args[i + 1]);
      return acc;
    }, []);
    expect(fFlags).toHaveLength(2);
    expect(fFlags[1]).toContain("channels.compose.yml");
  });
});
