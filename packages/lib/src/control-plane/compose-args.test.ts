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
import { writeStackSpec } from "./stack-spec.js";
import type { ControlPlaneState } from "./types.js";
import type { StackSpec } from "./stack-spec.js";

let tempDir: string;

function makeState(overrides: Partial<ControlPlaneState> = {}): ControlPlaneState {
  return {
    adminToken: "test",
    assistantToken: "test",
    setupToken: "test",
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
    ...overrides,
  };
}

function seedCoreCompose(): void {
  const stackDir = join(tempDir, "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");
}

function seedEnvFiles(files: { stack?: boolean; user?: boolean; guardian?: boolean } = {}): void {
  if (files.stack) {
    mkdirSync(join(tempDir, "vault", "stack"), { recursive: true });
    writeFileSync(join(tempDir, "vault", "stack", "stack.env"), "KEY=val");
  }
  if (files.user) {
    mkdirSync(join(tempDir, "vault", "user"), { recursive: true });
    writeFileSync(join(tempDir, "vault", "user", "user.env"), "SECRET=val");
  }
  if (files.guardian) {
    mkdirSync(join(tempDir, "vault", "stack"), { recursive: true });
    writeFileSync(join(tempDir, "vault", "stack", "guardian.env"), "CHANNEL_CHAT_SECRET=abc");
  }
}

function seedAddon(name: string): void {
  const addonDir = join(tempDir, "stack", "addons", name);
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

  it("includes addon overlays when enabled in stack spec", () => {
    seedCoreCompose();
    seedAddon("chat");

    const spec: StackSpec = {
      version: 2,
      capabilities: {
        llm: "openai/gpt-4o",
        embeddings: { provider: "openai", model: "test", dims: 768 },
        memory: { userId: "test" },
      },
      addons: { chat: true },
    };
    mkdirSync(join(tempDir, "config"), { recursive: true });
    writeStackSpec(join(tempDir, "config"), spec);

    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.files).toHaveLength(2);
    expect(opts.files[1]).toContain("chat");
  });

  it("returns env files in correct order", () => {
    seedEnvFiles({ stack: true, user: true, guardian: true });
    const state = makeState();
    const opts = buildComposeOptions(state);
    expect(opts.envFiles).toHaveLength(3);
    expect(opts.envFiles[0]).toContain("stack.env");
    expect(opts.envFiles[1]).toContain("user.env");
    expect(opts.envFiles[2]).toContain("guardian.env");
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
    seedCoreCompose();
    seedEnvFiles({ stack: true, user: true });
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

    const spec: StackSpec = {
      version: 2,
      capabilities: {
        llm: "openai/gpt-4o",
        embeddings: { provider: "openai", model: "test", dims: 768 },
        memory: { userId: "test" },
      },
      addons: { chat: true },
    };
    mkdirSync(join(tempDir, "config"), { recursive: true });
    writeStackSpec(join(tempDir, "config"), spec);

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
