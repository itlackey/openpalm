/**
 * Tests for configuration persistence — artifact metadata, env files, and runtime file writing.
 *
 * Core-asset tests (compose, access scope) live in core-assets.vitest.ts.
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync
} from "node:fs";
import { join } from "node:path";

import {
  sha256,
  buildRuntimeFileMeta,
  discoverStackOverlays,
  buildEnvFiles,
  writeRuntimeFiles,
  ensureSecrets,
  readSecret,
  writeSecret,
  secretPath,
} from "@openpalm/lib";
import { makeTempDir, makeTestState, trackDir, registerCleanup , stackEnvFor} from "./test-helpers.js";

function enableAddons(homeDir: string, csv: string): void {
  const envDir = join(homeDir, "state");
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, "stack.env"), `OP_ENABLED_ADDONS=${csv}\n`);
}

function writeStackCompose(homeDir: string, filename: string, yml: string): void {
  const stackDir = join(homeDir, "system", "stack");
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, filename), yml);
}

registerCleanup();

// ── Pure Utility Functions ──────────────────────────────────────────────

describe("sha256", () => {
  test("produces consistent hash for same input", () => {
    const hash1 = sha256("hello world");
    const hash2 = sha256("hello world");
    expect(hash1).toBe(hash2);
  });

  test("produces known hash for known input", () => {
    // SHA-256 of empty string
    expect(sha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  test("different inputs produce different hashes", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });

  test("returns 64-char lowercase hex string", () => {
    const hash = sha256("test");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});

// ── Artifact Metadata ───────────────────────────────────────────────────

describe("buildRuntimeFileMeta", () => {
  test("generates metadata for compose", () => {
    const artifacts = {
      compose: "services:\n  admin:\n    image: admin:latest\n",
    };
    const meta = buildRuntimeFileMeta(artifacts);
    expect(meta).toHaveLength(1);
    expect(meta[0].name).toBe("compose");
  });

  test("sha256 matches content hash", () => {
    const content = "test content";
    const artifacts = { compose: content };
    const meta = buildRuntimeFileMeta(artifacts);
    expect(meta[0].sha256).toBe(sha256(content));
  });

  test("bytes reflects buffer byte length (handles multibyte)", () => {
    const artifacts = { compose: "é" }; // é = 2 bytes UTF-8
    const meta = buildRuntimeFileMeta(artifacts);
    expect(meta[0].bytes).toBe(2);
  });

  test("generatedAt is ISO timestamp", () => {
    const meta = buildRuntimeFileMeta({ compose: "" });
    expect(meta[0].generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── Stack Overlay Discovery ───────────────────────────────────────────────

describe("discoverStackOverlays", () => {
  // discoverStackOverlays takes an OP_HOME root: managed compose from system/stack,
  // the user custom overlay from config/stack.
  let homeDir: string;
  let sysStack: string;
  let cfgStack: string;

  beforeEach(() => {
    homeDir = trackDir(makeTempDir());
    sysStack = join(homeDir, "system", "stack");
    cfgStack = join(homeDir, "config", "stack");
    mkdirSync(sysStack, { recursive: true });
    mkdirSync(cfgStack, { recursive: true });
  });

  test("returns empty when stack dir has no compose files", () => {
    expect(discoverStackOverlays(homeDir)).toEqual([]);
  });

  test("discovers core.compose.yml", () => {
    writeFileSync(join(sysStack, "core.compose.yml"), "services: {}");

    const result = discoverStackOverlays(homeDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/core\.compose\.yml$/);
  });

  test("discovers fixed compose overlay files", () => {
    writeFileSync(join(sysStack, "core.compose.yml"), "services: {}");
    writeFileSync(join(sysStack, "services.compose.yml"), "services: {}");
    writeFileSync(join(sysStack, "portals.compose.yml"), "services: {}");
    writeFileSync(join(cfgStack, "custom.compose.yml"), "services: {}");

    const result = discoverStackOverlays(homeDir);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatch(/core\.compose\.yml$/);
    expect(result.some((f) => f.endsWith("services.compose.yml"))).toBe(true);
    expect(result.some((f) => f.endsWith("portals.compose.yml"))).toBe(true);
    expect(result.some((f) => f.endsWith("custom.compose.yml"))).toBe(true);
  });

  test("ignores addon dirs without compose.yml", () => {
    writeFileSync(join(sysStack, "core.compose.yml"), "services: {}");
    const addonsDir = join(sysStack, "addons");
    mkdirSync(join(addonsDir, "empty-addon"), { recursive: true });
    // no compose.yml in empty-addon

    const result = discoverStackOverlays(homeDir);
    expect(result).toHaveLength(1); // only core.compose.yml
  });
});

// ── Env File Paths ────────────────────────────────────────────────────────

describe("buildEnvFiles", () => {
  test("returns empty when no files exist", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    expect(buildEnvFiles(state)).toEqual([]);
  });

  test("returns stack.env when it exists", () => {
    // Note: user.env is no longer a compose
    // env_file. User-managed env config lives in the akm `env/user` file
    // and are sourced by the assistant entrypoint at container startup.
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.homeDir, "state"), { recursive: true });
    writeFileSync(stackEnvFor(state.homeDir), "KEY=val");
    // user.env may still exist on disk during migration but must NOT be
    // surfaced as a compose env_file (compose would shadow akm-sourced values).

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("stack.env");
    // user.env must never appear in the env file list.
    expect(files.some((f) => f.includes("user.env"))).toBe(false);
  });

  test("returns only stack.env", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.homeDir, "state"), { recursive: true });
    writeFileSync(stackEnvFor(state.homeDir), "KEY=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("stack.env");
    expect(files.some((f) => f.includes("user.env"))).toBe(false);
  });

  test("returns empty list when stack.env is missing", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    // No env files — empty result
    const files = buildEnvFiles(state);
    expect(files).toEqual([]);
  });

});

// ── Persist Configuration (Integration) ─────────────────────────────────

describe("writeRuntimeFiles", () => {
  let state: ReturnType<typeof makeTestState>;

  beforeEach(() => {
    state = makeTestState();
    trackDir(state.homeDir);
    state.artifacts = {
      compose: "services:\n  admin:\n    image: admin:latest\n",
    };
    // Create required base dirs
    mkdirSync(state.stackDir, { recursive: true });
  });

  test("writes compose to config/stack/", () => {
    writeRuntimeFiles(state);

    const composePath = join(state.stackDir, "core.compose.yml");
    expect(existsSync(composePath)).toBe(true);
    expect(readFileSync(composePath, "utf-8")).toBe(state.artifacts.compose);
  });

  test('seeds the managed compose only when absent and never clobbers an existing one or the custom overlay', () => {
    // writeRuntimeFiles is strictly seed-if-absent. The managed system/ tree is
    // refreshed wholesale by overwriteSystemTree (covered in lib core-assets
    // tests), so an already-present managed core.compose.yml must be left intact.
    const managedCore = join(state.stackDir, 'core.compose.yml');
    writeFileSync(managedCore, 'services:\n  assistant:\n    image: already-here\n');
    // The USER custom overlay lives in config/stack and must NOT be clobbered.
    const userStackDir = join(state.homeDir, 'config', 'stack');
    mkdirSync(userStackDir, { recursive: true });
    writeFileSync(join(userStackDir, 'custom.compose.yml'), 'services:\n  mine: {}\n');

    writeRuntimeFiles(state);

    // Existing managed core left untouched (not overwritten with state.artifacts);
    // user custom preserved.
    expect(readFileSync(managedCore, 'utf-8')).toContain('image: already-here');
    expect(readFileSync(join(userStackDir, 'custom.compose.yml'), 'utf-8')).toContain('mine');
  });

  test("keeps portal secrets out of stack.env and writes no guardian.env", () => {
    // Provisioning them is ensureSecrets' job (portals.compose.yml grants all
    // four as file secrets whether or not their addons are on); writeRuntimeFiles
    // only has to keep the VALUES out of the plain-config file.
    writeStackCompose(state.homeDir, "portals.compose.yml", "services:\n  chat:\n    environment:\n      PORTAL_NAME: Chat\n");
    enableAddons(state.homeDir, "chat");

    writeRuntimeFiles(state);

    expect(existsSync(join(state.stackDir, "guardian.env"))).toBe(false);
    const stackContent = readFileSync(stackEnvFor(state.homeDir), "utf-8");
    expect(stackContent).not.toContain("PORTAL_CHAT_SECRET=");
  });

  test("ensureSecrets materializes every portal secret, with no addon enabled", () => {
    ensureSecrets(state);

    for (const portal of ["chat", "api", "discord", "slack"]) {
      expect(readSecret(state.homeDir, `portal_${portal}_secret`)).toBeTruthy();
    }
  });

  test("writes stack.env with runtime configuration", () => {
    writeRuntimeFiles(state);

    const systemEnvPath = stackEnvFor(state.homeDir);
    expect(existsSync(systemEnvPath)).toBe(true);
    const content = readFileSync(systemEnvPath, "utf-8");
    expect(content).toContain(`OP_HOME=${state.homeDir}`);
    // Per-image version pins (exact tag / "latest" / "next") replaced the old
    // single OP_IMAGE_TAG + per-unit OP_*_IMAGE_TAG cascade.
    expect(content).toContain('OP_ASSISTANT_VERSION=');
    expect(content).toContain('OP_GUARDIAN_VERSION=');
    expect(content).toContain('OP_PORTAL_VERSION=');
    expect(content).toContain('OP_VOICE_VERSION=');
  });

  test("stack.env does NOT leak user-managed secrets", () => {
    writeRuntimeFiles(state);

    const systemEnvPath = stackEnvFor(state.homeDir);
    const content = readFileSync(systemEnvPath, "utf-8");
    const lines = content.split("\n");
    expect(lines.some((l) => /^OP_UI_LOGIN_PASSWORD=/.test(l))).toBe(false);
  });

  test("preserves existing file-based portal secrets (does not regenerate)", () => {
    writeSecret(state.homeDir, "portal_chat_secret", "pre-existing-secret-value");

    writeStackCompose(state.homeDir, "portals.compose.yml", "services:\n  chat:\n    environment:\n      PORTAL_NAME: Chat\n");
    enableAddons(state.homeDir, "chat");

    writeRuntimeFiles(state);

    expect(readSecret(state.homeDir, "portal_chat_secret")).toBe("pre-existing-secret-value");
  });

});

// ── Portal Secret Files ─────────────────────────────────────────────────

describe("portal secret files", () => {
  test("reads from knowledge/secrets", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    writeSecret(state.homeDir, "portal_chat_secret", "abc123");
    writeSecret(state.homeDir, "portal_api_secret", "def456");

    expect(readSecret(state.homeDir, "portal_chat_secret")).toBe("abc123");
    expect(readSecret(state.homeDir, "portal_api_secret")).toBe("def456");
  });

  test("returns null when no secret file exists", () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(state.stackDir, { recursive: true });

    expect(readSecret(state.homeDir, "portal_chat_secret")).toBeNull();
  });

  test("writes secrets to knowledge/secrets", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    writeSecret(state.homeDir, "portal_chat_secret", "abc");
    writeSecret(state.homeDir, "portal_api_secret", "def");

    expect(readFileSync(secretPath(state.homeDir, "portal_chat_secret"), "utf-8")).toBe("abc");
    expect(readFileSync(secretPath(state.homeDir, "portal_api_secret"), "utf-8")).toBe("def");
    expect(existsSync(join(state.stackDir, "guardian.env"))).toBe(false);
  });
});
