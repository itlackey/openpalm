/**
 * Tests for staging.ts — artifact staging pipeline, env staging,
 * channel/automation staging, and persistence.
 *
 * Core-asset tests (Caddyfile, compose, access scope) live in core-assets.test.ts.
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
  buildArtifactMeta,
  discoverChannelOverlays,
  buildEnvFiles,
  persistArtifacts
} from "./staging.js";
import { makeTempDir, makeTestState, trackDir, registerCleanup, seedConfigChannels } from "./test-helpers.js";

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

describe("buildArtifactMeta", () => {
  test("generates metadata for compose and caddyfile", () => {
    const artifacts = {
      compose: "services:\n  admin:\n    image: admin:latest\n",
      caddyfile: ":8080 {\n  respond 200\n}"
    };
    const meta = buildArtifactMeta(artifacts);
    expect(meta).toHaveLength(2);
    expect(meta[0].name).toBe("compose");
    expect(meta[1].name).toBe("caddyfile");
  });

  test("sha256 matches content hash", () => {
    const content = "test content";
    const artifacts = { compose: content, caddyfile: "" };
    const meta = buildArtifactMeta(artifacts);
    expect(meta[0].sha256).toBe(sha256(content));
    expect(meta[1].sha256).toBe(sha256(""));
  });

  test("bytes reflects buffer byte length (handles multibyte)", () => {
    const artifacts = { compose: "hello", caddyfile: "\u00e9" }; // é = 2 bytes UTF-8
    const meta = buildArtifactMeta(artifacts);
    expect(meta[0].bytes).toBe(5);
    expect(meta[1].bytes).toBe(2);
  });

  test("generatedAt is ISO timestamp", () => {
    const meta = buildArtifactMeta({ compose: "", caddyfile: "" });
    expect(meta[0].generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── Channel Overlay Discovery ────────────────────────────────────────────

describe("discoverChannelOverlays", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("returns empty when components dir does not exist", () => {
    expect(discoverChannelOverlays(configDir)).toEqual([]);
  });

  test("discovers channel overlay .yml files", () => {
    const componentsDir = join(configDir, "components");
    mkdirSync(componentsDir, { recursive: true });
    writeFileSync(join(componentsDir, "channel-chat.yml"), "services: {}");
    writeFileSync(join(componentsDir, "channel-discord.yml"), "services: {}");

    const result = discoverChannelOverlays(configDir);
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.startsWith(configDir))).toBe(true);
  });

  test("ignores non-channel .yml files", () => {
    const componentsDir = join(configDir, "components");
    mkdirSync(componentsDir, { recursive: true });
    writeFileSync(join(componentsDir, "channel-chat.yml"), "services: {}");
    writeFileSync(join(componentsDir, "core.yml"), "services: {}");
    writeFileSync(join(componentsDir, "admin.yml"), "services: {}");

    const result = discoverChannelOverlays(configDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/channel-chat\.yml$/);
  });

  test("ignores subdirectories (only files)", () => {
    const componentsDir = join(configDir, "components");
    mkdirSync(componentsDir, { recursive: true });
    mkdirSync(join(componentsDir, "public"), { recursive: true });
    mkdirSync(join(componentsDir, "lan"), { recursive: true });
    writeFileSync(join(componentsDir, "channel-chat.yml"), "services: {}");

    const result = discoverChannelOverlays(configDir);
    expect(result).toHaveLength(1);
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

    mkdirSync(state.vaultDir, { recursive: true });
    writeFileSync(join(state.vaultDir, "system.env"), "KEY=val");
    writeFileSync(join(state.vaultDir, "user.env"), "SECRET=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("system.env");
    expect(files[1]).toContain("user.env");
  });

  test("returns only system.env when user.env is missing", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(state.vaultDir, { recursive: true });
    writeFileSync(join(state.vaultDir, "system.env"), "KEY=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("system.env");
  });

  test("returns only user.env when system.env is missing", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(state.vaultDir, { recursive: true });
    writeFileSync(join(state.vaultDir, "user.env"), "SECRET=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("user.env");
  });
});

// ── Persist Configuration (Integration) ─────────────────────────────────

describe("persistArtifacts", () => {
  let state: ReturnType<typeof makeTestState>;

  beforeEach(() => {
    state = makeTestState();
    trackDir(state.homeDir);
    state.artifacts = {
      compose: "services:\n  admin:\n    image: admin:latest\n",
      caddyfile: ":8080 {\n  respond 200\n}"
    };
    // Create required base dirs
    mkdirSync(join(state.configDir, "components"), { recursive: true });
    mkdirSync(join(state.vaultDir), { recursive: true });
    mkdirSync(join(state.dataDir, "caddy"), { recursive: true });
  });

  test("writes compose to config/components/ and caddyfile to data/caddy/", () => {
    persistArtifacts(state);

    const composePath = join(state.configDir, "components", "core.yml");
    const caddyPath = join(state.dataDir, "caddy", "Caddyfile");
    expect(existsSync(composePath)).toBe(true);
    expect(readFileSync(composePath, "utf-8")).toBe(state.artifacts.compose);
    expect(readFileSync(caddyPath, "utf-8")).toBe(state.artifacts.caddyfile);
  });

  test("generates channel secrets for discovered channels in system.env", () => {
    seedConfigChannels(state.configDir, [
      { name: "chat", yml: "services: {}" }
    ]);

    persistArtifacts(state);

    const systemEnvPath = join(state.vaultDir, "system.env");
    const content = readFileSync(systemEnvPath, "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=");
  });

  test("writes system.env with runtime configuration", () => {
    persistArtifacts(state);

    const systemEnvPath = join(state.vaultDir, "system.env");
    expect(existsSync(systemEnvPath)).toBe(true);
    const content = readFileSync(systemEnvPath, "utf-8");
    expect(content).toContain(`OP_HOME=${state.homeDir}`);
    expect(content).toContain(`OP_IMAGE_TAG=`);
  });

  test("system.env does NOT contain user secrets (MEMORY_USER_ID)", () => {
    persistArtifacts(state);

    const systemEnvPath = join(state.vaultDir, "system.env");
    const content = readFileSync(systemEnvPath, "utf-8");
    // User secrets belong in user.env, not system.env.
    // Having them in both causes precedence bugs with Docker Compose --env-file.
    expect(content).not.toContain("MEMORY_USER_ID=");
    // OP_ADMIN_TOKEN is a system secret and correctly lives in system.env.
    // Only the legacy bare ADMIN_TOKEN (without OP_ prefix) should not appear.
    const lines = content.split("\n");
    expect(lines.some((l) => /^ADMIN_TOKEN=/.test(l))).toBe(false);
  });

  test("preserves existing channel secrets (does not regenerate)", () => {
    // Pre-seed a channel secret in data/stack.env (where loadPersistedChannelSecrets reads)
    mkdirSync(state.dataDir, { recursive: true });
    writeFileSync(
      join(state.dataDir, "stack.env"),
      "CHANNEL_CHAT_SECRET=pre-existing-secret-value\n"
    );

    seedConfigChannels(state.configDir, [
      { name: "chat", yml: "services: {}" }
    ]);

    persistArtifacts(state);

    // The pre-existing secret should be preserved, not regenerated
    const systemEnvPath = join(state.vaultDir, "system.env");
    const content = readFileSync(systemEnvPath, "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=pre-existing-secret-value");
  });

  test("stages channel caddy files to lan/ directory", () => {
    seedConfigChannels(state.configDir, [
      {
        name: "chat",
        yml: "services:\n  channel-chat:\n    image: chat:latest\n",
        caddy: "handle_path /chat/* {\n\treverse_proxy channel-chat:3000\n}"
      }
    ]);

    persistArtifacts(state);

    const stagedCaddy = join(state.dataDir, "caddy", "channels", "lan", "chat.caddy");
    expect(existsSync(stagedCaddy)).toBe(true);
    const content = readFileSync(stagedCaddy, "utf-8");
    expect(content).toContain("import lan_only");
  });

  test("stages channel caddy files to public/ when marked public", () => {
    seedConfigChannels(state.configDir, [
      {
        name: "api",
        yml: "services:\n  channel-api:\n    image: api:latest\n",
        caddy: "handle_path /api/* {\n\timport public_access\n\treverse_proxy channel-api:3000\n}"
      }
    ]);

    persistArtifacts(state);

    const stagedCaddy = join(state.dataDir, "caddy", "channels", "public", "api.caddy");
    expect(existsSync(stagedCaddy)).toBe(true);
  });
});
