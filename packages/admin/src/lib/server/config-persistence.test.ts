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
  writeRuntimeFiles,
  readChannelSecrets,
  writeChannelSecrets,
  migrateLegacyChannelSecrets,
} from "@openpalm/lib";
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
  test("returns empty when no files exist", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    expect(buildEnvFiles(state)).toEqual([]);
  });

  test("returns all three files in correct order when they exist", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    mkdirSync(join(state.vaultDir, "user"), { recursive: true });
    writeFileSync(join(state.vaultDir, "stack", "stack.env"), "KEY=val");
    writeFileSync(join(state.vaultDir, "user", "user.env"), "SECRET=val");
    writeFileSync(join(state.vaultDir, "stack", "guardian.env"), "CHANNEL_CHAT_SECRET=abc");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(3);
    expect(files[0]).toContain("stack.env");
    expect(files[1]).toContain("user.env");
    expect(files[2]).toContain("guardian.env");
  });

  test("returns stack.env and user.env when guardian.env is missing", () => {
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

  test("returns only stack.env when user.env and guardian.env are missing", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(join(state.vaultDir, "stack", "stack.env"), "KEY=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("stack.env");
  });

  test("returns only user.env when stack.env and guardian.env are missing", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "user"), { recursive: true });
    writeFileSync(join(state.vaultDir, "user", "user.env"), "SECRET=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("user.env");
  });

  test("guardian.env is last (takes precedence for channel secrets)", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    mkdirSync(join(state.vaultDir, "user"), { recursive: true });
    writeFileSync(join(state.vaultDir, "stack", "stack.env"), "KEY=val");
    writeFileSync(join(state.vaultDir, "user", "user.env"), "");
    writeFileSync(join(state.vaultDir, "stack", "guardian.env"), "CHANNEL_CHAT_SECRET=abc");

    const files = buildEnvFiles(state);
    const guardianIdx = files.findIndex(f => f.includes("guardian.env"));
    expect(guardianIdx).toBe(files.length - 1);
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

  test("generates channel secrets for discovered channels in guardian.env", () => {
    seedChannelAddons(state.homeDir, [
      { name: "chat", yml: "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n" }
    ]);

    writeRuntimeFiles(state);

    const guardianEnvPath = join(state.vaultDir, "stack", "guardian.env");
    expect(existsSync(guardianEnvPath)).toBe(true);
    const content = readFileSync(guardianEnvPath, "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=");

    // Channel secrets must NOT be in stack.env
    const stackContent = readFileSync(join(state.vaultDir, "stack", "stack.env"), "utf-8");
    expect(stackContent).not.toContain("CHANNEL_CHAT_SECRET=");
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

  test("preserves existing channel secrets in guardian.env (does not regenerate)", () => {
    // Pre-seed a channel secret in vault/stack/guardian.env
    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(state.vaultDir, "stack", "guardian.env"),
      "CHANNEL_CHAT_SECRET=pre-existing-secret-value\n"
    );

    seedChannelAddons(state.homeDir, [
      { name: "chat", yml: "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n" }
    ]);

    writeRuntimeFiles(state);

    // The pre-existing secret should be preserved, not regenerated
    const guardianEnvPath = join(state.vaultDir, "stack", "guardian.env");
    const content = readFileSync(guardianEnvPath, "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=pre-existing-secret-value");
  });

  test("migrates legacy channel secrets from stack.env to guardian.env", () => {
    // Pre-seed a channel secret in stack.env (legacy location)
    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(state.vaultDir, "stack", "stack.env"),
      "OP_HOME=/tmp\nCHANNEL_CHAT_SECRET=legacy-secret-value\n"
    );

    seedChannelAddons(state.homeDir, [
      { name: "chat", yml: "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n" }
    ]);

    writeRuntimeFiles(state);

    // Secret should be in guardian.env
    const guardianEnvPath = join(state.vaultDir, "stack", "guardian.env");
    const guardianContent = readFileSync(guardianEnvPath, "utf-8");
    expect(guardianContent).toContain("CHANNEL_CHAT_SECRET=legacy-secret-value");

    // Secret should be removed from stack.env
    const stackContent = readFileSync(join(state.vaultDir, "stack", "stack.env"), "utf-8");
    expect(stackContent).not.toContain("CHANNEL_CHAT_SECRET=");
    // Non-channel entries should be preserved
    expect(stackContent).toContain("OP_HOME=");
  });

});

// ── Channel Secrets API ──────────────────────────────────────────────────

describe("readChannelSecrets", () => {
  test("reads from guardian.env", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(state.vaultDir, "stack", "guardian.env"),
      "CHANNEL_CHAT_SECRET=abc123\nCHANNEL_API_SECRET=def456\n"
    );

    const secrets = readChannelSecrets(state.vaultDir);
    expect(secrets).toEqual({ chat: "abc123", api: "def456" });
  });

  test("falls back to stack.env for pre-migration installs", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(state.vaultDir, "stack", "stack.env"),
      "OP_HOME=/tmp\nCHANNEL_CHAT_SECRET=legacy-value\n"
    );

    const secrets = readChannelSecrets(state.vaultDir);
    expect(secrets).toEqual({ chat: "legacy-value" });
  });

  test("returns empty when no secrets exist", () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });

    const secrets = readChannelSecrets(state.vaultDir);
    expect(secrets).toEqual({});
  });
});

describe("writeChannelSecrets", () => {
  test("writes secrets to guardian.env", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    writeChannelSecrets(state.vaultDir, { chat: "abc", api: "def" });

    const content = readFileSync(join(state.vaultDir, "stack", "guardian.env"), "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=abc");
    expect(content).toContain("CHANNEL_API_SECRET=def");
  });

  test("merges with existing guardian.env content", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(state.vaultDir, "stack", "guardian.env"),
      "CHANNEL_CHAT_SECRET=existing\n"
    );

    writeChannelSecrets(state.vaultDir, { api: "new-secret" });

    const content = readFileSync(join(state.vaultDir, "stack", "guardian.env"), "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=existing");
    expect(content).toContain("CHANNEL_API_SECRET=new-secret");
  });
});

describe("migrateLegacyChannelSecrets", () => {
  test("migrates secrets from stack.env to guardian.env", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(state.vaultDir, "stack", "stack.env"),
      "OP_HOME=/tmp\nCHANNEL_CHAT_SECRET=migrated\nCHANNEL_API_SECRET=also-migrated\n"
    );

    const result = migrateLegacyChannelSecrets(state.vaultDir);
    expect(result.migrated).toBe(2);
    expect(result.skipped).toBe(0);

    // guardian.env has the secrets
    const guardianContent = readFileSync(join(state.vaultDir, "stack", "guardian.env"), "utf-8");
    expect(guardianContent).toContain("CHANNEL_CHAT_SECRET=migrated");
    expect(guardianContent).toContain("CHANNEL_API_SECRET=also-migrated");

    // stack.env has secrets removed
    const stackContent = readFileSync(join(state.vaultDir, "stack", "stack.env"), "utf-8");
    expect(stackContent).not.toContain("CHANNEL_CHAT_SECRET=");
    expect(stackContent).not.toContain("CHANNEL_API_SECRET=");
    expect(stackContent).toContain("OP_HOME=/tmp");
  });

  test("does not overwrite existing guardian.env secrets", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(state.vaultDir, "stack", "stack.env"),
      "CHANNEL_CHAT_SECRET=old-value\n"
    );
    writeFileSync(
      join(state.vaultDir, "stack", "guardian.env"),
      "CHANNEL_CHAT_SECRET=guardian-value\n"
    );

    const result = migrateLegacyChannelSecrets(state.vaultDir);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(1);

    // guardian.env retains its value
    const guardianContent = readFileSync(join(state.vaultDir, "stack", "guardian.env"), "utf-8");
    expect(guardianContent).toContain("CHANNEL_CHAT_SECRET=guardian-value");
  });

  test("is idempotent — no-op when no legacy secrets exist", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(join(state.vaultDir, "stack", "stack.env"), "OP_HOME=/tmp\n");

    const result = migrateLegacyChannelSecrets(state.vaultDir);
    expect(result.migrated).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test("returns zero counts when stack.env does not exist", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    const result = migrateLegacyChannelSecrets(state.vaultDir);
    expect(result).toEqual({ migrated: 0, skipped: 0 });
  });
});
