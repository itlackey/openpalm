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
import adminPkg from "../../../package.json" with { type: "json" };

import {
  sha256,
  buildArtifactMeta,
  discoverStagedChannelYmls,
  stagedEnvFile,
  stagedStackEnvFile,
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

// ── Staged Channel Discovery ────────────────────────────────────────────

describe("discoverStagedChannelYmls", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = trackDir(makeTempDir());
  });

  test("returns empty when channels dir does not exist", () => {
    expect(discoverStagedChannelYmls(stateDir)).toEqual([]);
  });

  test("discovers staged .yml files", () => {
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");
    writeFileSync(join(channelsDir, "discord.yml"), "services: {}");

    const result = discoverStagedChannelYmls(stateDir);
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.startsWith(stateDir))).toBe(true);
  });

  test("ignores non-.yml files", () => {
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");
    writeFileSync(join(channelsDir, "chat.caddy"), "handle /chat {}");

    const result = discoverStagedChannelYmls(stateDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/chat\.yml$/);
  });

  test("ignores subdirectories (only files)", () => {
    const channelsDir = join(stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    mkdirSync(join(channelsDir, "public"), { recursive: true });
    mkdirSync(join(channelsDir, "lan"), { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");

    const result = discoverStagedChannelYmls(stateDir);
    expect(result).toHaveLength(1);
  });
});

// ── Path Helpers ────────────────────────────────────────────────────────

describe("stagedEnvFile", () => {
  test("returns STATE_HOME/artifacts/secrets.env", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    expect(stagedEnvFile(state)).toBe(`${state.stateDir}/artifacts/secrets.env`);
  });
});

describe("stagedStackEnvFile", () => {
  test("returns STATE_HOME/artifacts/stack.env", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    expect(stagedStackEnvFile(state)).toBe(`${state.stateDir}/artifacts/stack.env`);
  });
});

describe("buildEnvFiles", () => {
  test("returns empty when neither file exists", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    expect(buildEnvFiles(state)).toEqual([]);
  });

  test("returns both files when they exist", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const artifactDir = join(state.stateDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "stack.env"), "KEY=val");
    writeFileSync(join(artifactDir, "secrets.env"), "SECRET=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("stack.env");
    expect(files[1]).toContain("secrets.env");
  });

  test("returns only stack.env when secrets.env is missing", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const artifactDir = join(state.stateDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "stack.env"), "KEY=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("stack.env");
  });

  test("returns only secrets.env when stack.env is missing", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const artifactDir = join(state.stateDir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "secrets.env"), "SECRET=val");

    const files = buildEnvFiles(state);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("secrets.env");
  });
});

// ── Persist Artifacts (Integration) ─────────────────────────────────────

describe("persistArtifacts", () => {
  let state: ReturnType<typeof makeTestState>;

  beforeEach(() => {
    state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    state.artifacts = {
      compose: "services:\n  admin:\n    image: admin:latest\n",
      caddyfile: ":8080 {\n  respond 200\n}"
    };
    // Create required base dirs
    mkdirSync(join(state.configDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "artifacts", "channels"), { recursive: true });
    mkdirSync(join(state.dataDir, "caddy"), { recursive: true });
  });

  test("writes compose and caddyfile to STATE_HOME", () => {
    persistArtifacts(state);

    const composePath = join(state.stateDir, "artifacts", "docker-compose.yml");
    const caddyPath = join(state.stateDir, "artifacts", "Caddyfile");
    expect(existsSync(composePath)).toBe(true);
    expect(readFileSync(composePath, "utf-8")).toBe(state.artifacts.compose);
    expect(readFileSync(caddyPath, "utf-8")).toBe(state.artifacts.caddyfile);
  });

  test("writes manifest.json with artifact metadata", () => {
    persistArtifacts(state);

    const manifestPath = join(state.stateDir, "artifacts", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest).toHaveLength(2);
    expect(manifest[0].name).toBe("compose");
    expect(manifest[1].name).toBe("caddyfile");
  });

  test("generates channel secrets for discovered channels", () => {
    seedConfigChannels(state.configDir, [
      { name: "chat", yml: "services: {}" }
    ]);

    persistArtifacts(state);

    expect(state.channelSecrets.chat).toBeDefined();
    expect(state.channelSecrets.chat.length).toBeGreaterThan(0);

    const stackEnvPath = join(state.stateDir, "artifacts", "stack.env");
    const content = readFileSync(stackEnvPath, "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=");
  });

  test("writes stack.env with runtime configuration", () => {
    persistArtifacts(state);

    const stackEnvPath = join(state.stateDir, "artifacts", "stack.env");
    expect(existsSync(stackEnvPath)).toBe(true);
    const content = readFileSync(stackEnvPath, "utf-8");
    expect(content).toContain(`OPENPALM_CONFIG_HOME=${state.configDir}`);
    expect(content).toContain(`OPENPALM_DATA_HOME=${state.dataDir}`);
    expect(content).toContain(`OPENPALM_STATE_HOME=${state.stateDir}`);
    expect(content).toContain(`OPENPALM_IMAGE_TAG=v${adminPkg.version}`);
  });

  test("stack.env does NOT contain user secrets (OPENMEMORY_USER_ID, ADMIN_TOKEN)", () => {
    persistArtifacts(state);

    const stackEnvPath = join(state.stateDir, "artifacts", "stack.env");
    const content = readFileSync(stackEnvPath, "utf-8");
    // User secrets belong in secrets.env, not stack.env.
    // Having them in both causes precedence bugs with Docker Compose --env-file.
    expect(content).not.toContain("OPENMEMORY_USER_ID=");
    expect(content).not.toContain("ADMIN_TOKEN=");
  });

  test("stages channel yml files from CONFIG to STATE", () => {
    seedConfigChannels(state.configDir, [
      { name: "chat", yml: "services:\n  channel-chat:\n    image: chat:latest\n" }
    ]);

    persistArtifacts(state);

    const stagedYml = join(state.stateDir, "artifacts", "channels", "chat.yml");
    expect(existsSync(stagedYml)).toBe(true);
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

    const stagedCaddy = join(state.stateDir, "artifacts", "channels", "lan", "chat.caddy");
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

    const stagedCaddy = join(state.stateDir, "artifacts", "channels", "public", "api.caddy");
    expect(existsSync(stagedCaddy)).toBe(true);
  });

  test("preserves existing channel secrets (does not regenerate)", () => {
    state.channelSecrets.chat = "pre-existing-secret-value";

    seedConfigChannels(state.configDir, [
      { name: "chat", yml: "services: {}" }
    ]);

    persistArtifacts(state);

    // The pre-set secret should be preserved, not regenerated
    expect(state.channelSecrets.chat).toBe("pre-existing-secret-value");

    const stackEnvPath = join(state.stateDir, "artifacts", "stack.env");
    const content = readFileSync(stackEnvPath, "utf-8");
    expect(content).toContain("CHANNEL_CHAT_SECRET=pre-existing-secret-value");
  });

  test("stages automation files from DATA_HOME", () => {
    const automationsDir = join(state.dataDir, "automations");
    mkdirSync(automationsDir, { recursive: true });
    const automationYaml = [
      "name: daily-backup",
      'schedule: "0 0 * * *"',
      "action:",
      "  type: api",
      "  path: /admin/api/action",
      ""
    ].join("\n");
    writeFileSync(join(automationsDir, "daily-backup.yml"), automationYaml);

    persistArtifacts(state);

    const stagedAutomation = join(state.stateDir, "automations", "daily-backup.yml");
    expect(existsSync(stagedAutomation)).toBe(true);
    const content = readFileSync(stagedAutomation, "utf-8");
    expect(content).toContain("daily-backup");
  });
});
