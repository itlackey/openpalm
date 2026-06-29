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
    stackDir: join(tempDir, "system", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
    ...overrides,
  };
}

function seedCoreCompose(): void {
  const stackDir = join(tempDir, "system", "stack");
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
  const stackDir = join(tempDir, "system", "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, "portals.compose.yml"), `services:\n  ${name}:\n    profiles: [\"addon.${name}\"]\n    image: test\n`);
  const envDir = join(tempDir, "knowledge", "env");
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, "stack.env"), `OP_ENABLED_ADDONS=${name}\n`);
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

  it("includes fixed channel compose and profile from OP_ENABLED_ADDONS", () => {
    seedCoreCompose();
    seedAddon("chat");

    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.files).toHaveLength(2);
    expect(opts.files[1]).toContain("portals.compose.yml");
    expect(opts.profiles).toContain("addon.chat");
  });

  it("activates the profile when OP_ENABLED_ADDONS is in state/ (not legacy stack.env)", () => {
    // Regression: `openpalm addon enable` writes OP_ENABLED_ADDONS to
    // state/stack.state.env, but resolveActiveProfiles used to read only
    // knowledge/env/stack.env — so the addon's compose profile never activated
    // and its service was never started. resolveActiveProfiles must read the
    // SAME merged source (state over legacy) as listEnabledAddonIds.
    seedCoreCompose();
    const stackDir = join(tempDir, "system", "stack");
    writeFileSync(
      join(stackDir, "portals.compose.yml"),
      'services:\n  discord:\n    profiles: ["addon.discord"]\n    image: test\n',
    );
    const stateDir = join(tempDir, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "stack.state.env"), "OP_ENABLED_ADDONS=discord\n");
    // legacy stack.env intentionally absent / without the addon

    const opts = buildComposeOptions(makeState());
    expect(opts.profiles).toContain("addon.discord");
  });

  it("includes the user custom compose file", () => {
    seedCoreCompose();
    // custom.compose.yml is USER-owned → config/stack (not system/stack).
    const stackDir = join(tempDir, "config", "stack");
    mkdirSync(stackDir, { recursive: true });
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

  it("(#470) defaults an enabled-but-unprofiled ollama addon to addon.ollama.cpu", () => {
    // No OP_OLLAMA_PROFILE written — only the enable flag. resolveActiveProfiles
    // must resolve the canonical CPU profile so setup-deploy does NOT need a
    // separate (non-atomic) post-install write.
    seedCoreCompose();
    const envDir = join(tempDir, "knowledge", "env");
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, "stack.env"), "OP_ENABLED_ADDONS=ollama\n");
    const state = makeState();
    const args = buildComposeCliArgs(state);
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

  it('does not synthesize profiles from COMPOSE_PROFILES', () => {
    seedCoreCompose();
    seedEnvFiles({ stack: true });
    writeFileSync(join(tempDir, 'knowledge', 'env', 'stack.env'), 'COMPOSE_PROFILES=addon.chat\n');
    const state = makeState();
    const args = buildComposeCliArgs(state);
    expect(args).not.toContain('addon.chat');
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
    expect(fFlags[1]).toContain("portals.compose.yml");
  });
});
