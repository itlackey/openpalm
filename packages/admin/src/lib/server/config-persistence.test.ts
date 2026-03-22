/**
 * Tests for configuration persistence — artifact metadata, env files, and runtime file writing.
 *
 * Core-asset tests (compose, access scope) live in core-assets.test.ts.
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
  writeRuntimeFiles
} from "./control-plane.js";
import { makeTempDir, makeTestState, trackDir, registerCleanup } from "./test-helpers.js";

/** Seed channel addon files in stack/addons/<name>/compose.yml. */
function seedChannelAddons(
  homeDir: string,
  channels: { name: string; yml: string }[]
): void {
  for (const ch of channels) {
    const addonDir = join(homeDir, "stack", "addons", ch.name);
    mkdirSync(addonDir, { recursive: true });
    writeFileSync(join(addonDir, "compose.yml"), ch.yml);
  }
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
    const artifacts = { compose: "\u00e9" }; // é = 2 bytes UTF-8
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
  let stackDir: string;

  beforeEach(() => {
    stackDir = trackDir(makeTempDir());
  });

  test("returns empty when stack dir has no compose files", () => {
    expect(discoverStackOverlays(stackDir)).toEqual([]);
  });

  test("discovers core.compose.yml", () => {
    writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");

    const result = discoverStackOverlays(stackDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/core\.compose\.yml$/);
  });

  test("discovers addon compose.yml files", () => {
    writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");
    const addonsDir = join(stackDir, "addons");
    mkdirSync(join(addonsDir, "admin"), { recursive: true });
    mkdirSync(join(addonsDir, "ollama"), { recursive: true });
    writeFileSync(join(addonsDir, "admin", "compose.yml"), "services: {}");
    writeFileSync(join(addonsDir, "ollama", "compose.yml"), "services: {}");

    const result = discoverStackOverlays(stackDir);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatch(/core\.compose\.yml$/);
    expect(result.some((f) => f.includes("admin"))).toBe(true);
    expect(result.some((f) => f.includes("ollama"))).toBe(true);
  });

  test("ignores addon dirs without compose.yml", () => {
    writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");
    const addonsDir = join(stackDir, "addons");
    mkdirSync(join(addonsDir, "empty-addon"), { recursive: true });
    // no compose.yml in empty-addon

    const result = discoverStackOverlays(stackDir);
    expect(result).toHaveLength(1); // only core.compose.yml
  });
});

// ── Env File Paths ────────────────────────────────────────────────────────

describe("buildEnvFiles", () => {
  test("returns empty when neither file exists", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    expect(buildEnvFiles(state)).toEqual([]);
  });

  test("returns both files when they exist", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    mkdirSync(join(state.vaultDir, "user"), { recursive: true });
    writeFileSync(join(state.vaultDir, "stack", "stack.env"), "KEY=val");
    writeFileSync(join(state.vaultDir, "user", "user.env"), "SECRET=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("stack.env");
    expect(files[1]).toContain("user.env");
  });

  test("returns only stack.env when user.env is missing", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(join(state.vaultDir, "stack", "stack.env"), "KEY=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("stack.env");
  });

  test("returns only user.env when stack.env is missing", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "user"), { recursive: true });
    writeFileSync(join(state.vaultDir, "user", "user.env"), "SECRET=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("user.env");
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
    mkdirSync(join(state.homeDir, "stack"), { recursive: true });
    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    mkdirSync(join(state.vaultDir, "user"), { recursive: true });
  });

  test("writes compose to stack/", () => {
    writeRuntimeFiles(state);

    const composePath = join(state.homeDir, "stack", "core.compose.yml");
    expect(existsSync(composePath)).toBe(true);
    expect(readFileSync(composePath, "utf-8")).toBe(state.artifacts.compose);
  });

  test("generates channel secrets for discovered channels in stack.env", () => {
    seedChannelAddons(state.homeDir, [
      { name: "chat", yml: "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n" }
    ]);

    writeRuntimeFiles(state);

    const systemEnvPath = join(state.vaultDir, "stack", "stack.env");
    const content = readFileSync(systemEnvPath, "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=");
  });

  test("writes stack.env with runtime configuration", () => {
    writeRuntimeFiles(state);

    const systemEnvPath = join(state.vaultDir, "stack", "stack.env");
    expect(existsSync(systemEnvPath)).toBe(true);
    const content = readFileSync(systemEnvPath, "utf-8");
    expect(content).toContain(`OP_HOME=${state.homeDir}`);
    expect(content).toContain(`OP_IMAGE_TAG=`);
  });

  test("stack.env does NOT contain user secrets (MEMORY_USER_ID)", () => {
    writeRuntimeFiles(state);

    const systemEnvPath = join(state.vaultDir, "stack", "stack.env");
    const content = readFileSync(systemEnvPath, "utf-8");
    // User secrets belong in user.env, not stack.env.
    // Having them in both causes precedence bugs with Docker Compose --env-file.
    expect(content).not.toContain("MEMORY_USER_ID=");
    // OP_ADMIN_TOKEN is a system secret and correctly lives in stack.env.
    // Only the legacy bare ADMIN_TOKEN (without OP_ prefix) should not appear.
    const lines = content.split("\n");
    expect(lines.some((l) => /^ADMIN_TOKEN=/.test(l))).toBe(false);
  });

  test("preserves existing channel secrets (does not regenerate)", () => {
    // Pre-seed a channel secret in vault/stack/stack.env (where loadPersistedChannelSecrets reads)
    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(state.vaultDir, "stack", "stack.env"),
      "CHANNEL_CHAT_SECRET=pre-existing-secret-value\n"
    );

    seedChannelAddons(state.homeDir, [
      { name: "chat", yml: "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n" }
    ]);

    writeRuntimeFiles(state);

    // The pre-existing secret should be preserved, not regenerated
    const systemEnvPath = join(state.vaultDir, "stack", "stack.env");
    const content = readFileSync(systemEnvPath, "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=pre-existing-secret-value");
  });

});
