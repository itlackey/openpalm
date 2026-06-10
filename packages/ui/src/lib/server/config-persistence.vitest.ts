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
  readSecret,
  writeSecret,
  secretPath,
} from "@openpalm/lib";
import { makeTempDir, makeTestState, trackDir, registerCleanup , stackEnvFor} from "./test-helpers.js";

function enableAddons(homeDir: string, csv: string): void {
  const envDir = join(homeDir, "knowledge", "env");
  mkdirSync(envDir, { recursive: true });
  writeFileSync(join(envDir, "stack.env"), `OP_ENABLED_ADDONS=${csv}\n`);
}

function writeStackCompose(homeDir: string, filename: string, yml: string): void {
  const stackDir = join(homeDir, "config", "stack");
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

  test("discovers fixed compose overlay files", () => {
    writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");
    writeFileSync(join(stackDir, "services.compose.yml"), "services: {}");
    writeFileSync(join(stackDir, "channels.compose.yml"), "services: {}");
    writeFileSync(join(stackDir, "custom.compose.yml"), "services: {}");

    const result = discoverStackOverlays(stackDir);
    expect(result).toHaveLength(4);
    expect(result[0]).toMatch(/core\.compose\.yml$/);
    expect(result.some((f) => f.endsWith("services.compose.yml"))).toBe(true);
    expect(result.some((f) => f.endsWith("channels.compose.yml"))).toBe(true);
    expect(result.some((f) => f.endsWith("custom.compose.yml"))).toBe(true);
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

  test("returns stack.env when it exists", () => {
    // Note: user.env is no longer a compose
    // env_file. User-managed env config lives in the akm `env:user` file
    // and are sourced by the assistant entrypoint at container startup.
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.stashDir, "env"), { recursive: true });
    writeFileSync(stackEnvFor(state.stackDir), "KEY=val");
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

    mkdirSync(join(state.stashDir, "env"), { recursive: true });
    writeFileSync(stackEnvFor(state.stackDir), "KEY=val");

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

  test("generates file-based channel secrets for discovered channels", () => {
    writeStackCompose(state.homeDir, "channels.compose.yml", "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n");
    enableAddons(state.homeDir, "chat");

    writeRuntimeFiles(state);

    expect(existsSync(join(state.stackDir, "guardian.env"))).toBe(false);
    expect(readSecret(state.stackDir, "channel_chat_secret")).toBeTruthy();

    // Channel secrets must NOT be in stack.env
    const stackContent = readFileSync(stackEnvFor(state.stackDir), "utf-8");
    expect(stackContent).not.toContain("CHANNEL_CHAT_SECRET=");
  });

  test("writes stack.env with runtime configuration", () => {
    writeRuntimeFiles(state);

    const systemEnvPath = stackEnvFor(state.stackDir);
    expect(existsSync(systemEnvPath)).toBe(true);
    const content = readFileSync(systemEnvPath, "utf-8");
    expect(content).toContain(`OP_HOME=${state.homeDir}`);
    expect(content).toContain(`OP_IMAGE_TAG=`);
    expect(content).toContain('OP_ASSISTANT_IMAGE_TAG=');
    expect(content).toContain('OP_GUARDIAN_IMAGE_TAG=');
    expect(content).toContain('OP_CHANNEL_IMAGE_TAG=');
  });

  test("stack.env does NOT leak user-managed secrets", () => {
    writeRuntimeFiles(state);

    const systemEnvPath = stackEnvFor(state.stackDir);
    const content = readFileSync(systemEnvPath, "utf-8");
    const lines = content.split("\n");
    expect(lines.some((l) => /^OP_UI_LOGIN_PASSWORD=/.test(l))).toBe(false);
  });

  test("preserves existing file-based channel secrets (does not regenerate)", () => {
    writeSecret(state.stackDir, "channel_chat_secret", "pre-existing-secret-value");

    writeStackCompose(state.homeDir, "channels.compose.yml", "services:\n  chat:\n    environment:\n      CHANNEL_NAME: Chat\n");
    enableAddons(state.homeDir, "chat");

    writeRuntimeFiles(state);

    expect(readSecret(state.stackDir, "channel_chat_secret")).toBe("pre-existing-secret-value");
  });

});

// ── Channel Secret Files ─────────────────────────────────────────────────

describe("channel secret files", () => {
  test("reads from knowledge/secrets", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    writeSecret(state.stackDir, "channel_chat_secret", "abc123");
    writeSecret(state.stackDir, "channel_api_secret", "def456");

    expect(readSecret(state.stackDir, "channel_chat_secret")).toBe("abc123");
    expect(readSecret(state.stackDir, "channel_api_secret")).toBe("def456");
  });

  test("returns null when no secret file exists", () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(state.stackDir, { recursive: true });

    expect(readSecret(state.stackDir, "channel_chat_secret")).toBeNull();
  });

  test("writes secrets to knowledge/secrets", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    writeSecret(state.stackDir, "channel_chat_secret", "abc");
    writeSecret(state.stackDir, "channel_api_secret", "def");

    expect(readFileSync(secretPath(state.stackDir, "channel_chat_secret"), "utf-8")).toBe("abc");
    expect(readFileSync(secretPath(state.stackDir, "channel_api_secret"), "utf-8")).toBe("def");
    expect(existsSync(join(state.stackDir, "guardian.env"))).toBe(false);
  });
});
