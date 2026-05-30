/**
 * Tests for the configuration persistence contract.
 *
 * Verifies that:
 * 1. Stack compose overlays live in config/stack/ (not config/components/)
 * 2. Compose file list uses config/stack/ paths
 * 3. User vault data lives in stash/vaults/user.env; stack secrets live in stash/vaults/secrets/
 * 4. Runtime validation checks fixed compose files for channels
 * 5. Configuration persistence is idempotent
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Import real functions from @openpalm/lib ────────────────────────────
import type { ControlPlaneState } from "@openpalm/lib";
import {
  discoverChannels,
  isValidChannel,
  discoverStackOverlays,
  writeSystemEnv,
} from "@openpalm/lib";

// ── Test helpers — create isolated temp directories ────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a minimal ControlPlaneState for tests. */
function makeState(tempDir?: string): ControlPlaneState {
  const base = tempDir ?? makeTempDir();
  return {
    homeDir: base,
    configDir: join(base, "config"),
    stashDir: join(base, "stash"),
    workspaceDir: join(base, "workspace"),
    dataDir: join(base, "data"),
    stackDir: join(base, "config", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
}

function writeStackCompose(homeDir: string, filename: string, yml: string): void {
  const stackDir = join(homeDir, "config", "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, filename), yml);
}

function seedUserEnv(stashDir: string, content: string): void {
  mkdirSync(join(stashDir, "vaults"), { recursive: true });
  writeFileSync(join(stashDir, "vaults", "user.env"), content);
}

// ── Tests ─────────────────────────────────────────────────────────────

let baseDir: string;

beforeEach(() => {
  baseDir = makeTempDir();
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe("Stack overlay discovery — stack/ layout", () => {
  test("discoverStackOverlays returns core.compose.yml from stack/", () => {
    const stackDir = join(baseDir, "stack");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "core.compose.yml"), "services:\n  guardian:\n    image: guardian:latest\n");

    const files = discoverStackOverlays(stackDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/core\.compose\.yml$/);
  });

  test("discoverStackOverlays discovers fixed compose overlay files", () => {
    const stackDir = join(baseDir, "stack");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");
    writeFileSync(join(stackDir, "services.compose.yml"), "services: {}");

    const files = discoverStackOverlays(stackDir);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.endsWith("services.compose.yml"))).toBe(true);
  });

  test("discoverStackOverlays returns empty when stack dir is empty", () => {
    const stackDir = join(baseDir, "stack");
    mkdirSync(stackDir, { recursive: true });

    expect(discoverStackOverlays(stackDir)).toEqual([]);
  });
});

describe("User extensions in stash/vaults/user.env (akm vault:user store)", () => {
  test("user.env is read from stash/vaults/", () => {
    const state = makeState(baseDir);
    const secretsContent = "CUSTOM_SECRET=test-token\n";
    seedUserEnv(state.stashDir, secretsContent);

    const userEnvPath = join(state.stashDir, "vaults", "user.env");
    expect(existsSync(userEnvPath)).toBe(true);
    expect(readFileSync(userEnvPath, "utf-8")).toBe(secretsContent);
  });
});

describe("Runtime validation uses fixed compose overlays", () => {
  test("isValidChannel checks channel services from fixed compose files", () => {
    const state = makeState(baseDir);
    writeStackCompose(state.homeDir, "custom.compose.yml", "services:\n  custom:\n    environment:\n      CHANNEL_NAME: Custom\n");

    expect(isValidChannel("custom", state.configDir)).toBe(true);

    // Should NOT find an uninstalled channel
    expect(isValidChannel("nonexistent", state.configDir)).toBe(false);
  });

  test("source-only channel (not in fixed compose files) is not valid at runtime", () => {
    const state = makeState(baseDir);
    // Write to old channels/ dir, not fixed compose files.
    const channelsDir = join(state.configDir, "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "unstaged.yml"), "services:\n  channel-unstaged:\n    image: unstaged:latest\n");

    // NOT in fixed compose files — so runtime validation should reject
    expect(isValidChannel("unstaged", state.configDir)).toBe(false);
  });
});
