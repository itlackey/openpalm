/**
 * Tests for detectHostOpenCode() and importHostOpenCode().
 *
 * Uses real temp directories — no network, no Docker, no akm CLI.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHostOpenCode, importHostOpenCode } from "./host-opencode.js";
import type { ControlPlaneState } from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeState(homeDir: string): ControlPlaneState {
  return {
    adminToken: "test-admin",
    assistantToken: "test-assistant",
    setupToken: "test-setup",
    homeDir,
    configDir: join(homeDir, "config"),
    stashDir: join(homeDir, "stash"),
    workspaceDir: join(homeDir, "workspace"),
    cacheDir: join(homeDir, "cache"),
    stateDir: join(homeDir, "state"),
    stackDir: join(homeDir, "config/stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
    audit: [],
  };
}

/** Snapshot of env vars so tests can override XDG paths and restore after. */
function withXdgEnv(configHome: string, dataHome: string, fn: () => void) {
  const prevConfig = process.env.XDG_CONFIG_HOME;
  const prevData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_DATA_HOME = dataHome;
  try {
    fn();
  } finally {
    if (prevConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevConfig;
    if (prevData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevData;
  }
}

// ── detectHostOpenCode ────────────────────────────────────────────────────────

describe("detectHostOpenCode", () => {
  let xdgRoot: string;

  beforeEach(() => {
    xdgRoot = mkdtempSync(join(tmpdir(), "op-host-detect-"));
  });

  afterEach(() => {
    rmSync(xdgRoot, { recursive: true, force: true });
  });

  it("returns zero counts when no host config exists", () => {
    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const status = detectHostOpenCode();
      expect(status.providerCount).toBe(0);
      expect(status.credentialCount).toBe(0);
      expect(status.configPath).toBeUndefined();
      expect(status.authPath).toBeUndefined();
    });
  });

  it("counts providers from opencode.json", () => {
    const configDir = join(xdgRoot, "config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
      provider: { anthropic: {}, openai: {}, groq: {} },
    }));
    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const status = detectHostOpenCode();
      expect(status.providerCount).toBe(3);
      expect(status.credentialCount).toBe(0);
      expect(status.configPath).toContain("opencode.json");
    });
  });

  it("counts credentials from auth.json", () => {
    const dataDir = join(xdgRoot, "data", "opencode");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "auth.json"), JSON.stringify({
      anthropic: { token: "sk-ant" },
      groq: { token: "gsk_" },
    }));
    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const status = detectHostOpenCode();
      expect(status.credentialCount).toBe(2);
      expect(status.providerCount).toBe(0);
      expect(status.authPath).toContain("auth.json");
    });
  });

  it("handles malformed opencode.json gracefully", () => {
    const configDir = join(xdgRoot, "config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), "{ invalid json {{");
    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const status = detectHostOpenCode();
      expect(status.providerCount).toBe(0);
    });
  });
});

// ── importHostOpenCode ────────────────────────────────────────────────────────

describe("importHostOpenCode", () => {
  let xdgRoot: string;
  let opHome: string;

  beforeEach(() => {
    xdgRoot = mkdtempSync(join(tmpdir(), "op-host-import-xdg-"));
    opHome = mkdtempSync(join(tmpdir(), "op-host-import-home-"));
  });

  afterEach(() => {
    rmSync(xdgRoot, { recursive: true, force: true });
    rmSync(opHome, { recursive: true, force: true });
  });

  it("imports providers and credentials from a fresh state", () => {
    // Set up host opencode files
    const hostConfigDir = join(xdgRoot, "config", "opencode");
    const hostDataDir = join(xdgRoot, "data", "opencode");
    mkdirSync(hostConfigDir, { recursive: true });
    mkdirSync(hostDataDir, { recursive: true });

    writeFileSync(join(hostConfigDir, "opencode.json"), JSON.stringify({
      provider: { anthropic: { name: "Anthropic" }, groq: {} },
      model: "anthropic/claude-3-5-sonnet",
      // These should be stripped:
      plugin: [{ module: "some-plugin" }],
      mcp: { server: {} },
    }));
    writeFileSync(join(hostDataDir, "auth.json"), JSON.stringify({
      anthropic: { token: "sk-ant-token" },
    }));

    const state = makeState(opHome);

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const result = importHostOpenCode(state);
      expect(result.imported.providers).toBe(2);
      expect(result.imported.credentials).toBe(1);
      expect(result.conflicts).toHaveLength(0);
    });

    // Verify opencode.json was written and plugin key was stripped
    const destConfig = JSON.parse(readFileSync(join(opHome, "config", "assistant", "opencode.json"), "utf-8"));
    expect(destConfig.provider).toEqual({ anthropic: { name: "Anthropic" }, groq: {} });
    expect(destConfig.model).toBe("anthropic/claude-3-5-sonnet");
    expect(destConfig.plugin).toBeUndefined();
    expect(destConfig.mcp).toBeUndefined();

    // Verify auth.json was written
    expect(existsSync(join(opHome, "config", "auth.json"))).toBe(true);

    // Verify auth.json permissions are 0o600
    const authStat = statSync(join(opHome, "config", "auth.json"));
    // On Linux, mode & 0o777 extracts permission bits
    expect(authStat.mode & 0o777).toBe(0o600);
  });

  it("preserves existing providers on conflict when overwriteConflicts is false", () => {
    const hostConfigDir = join(xdgRoot, "config", "opencode");
    mkdirSync(hostConfigDir, { recursive: true });
    writeFileSync(join(hostConfigDir, "opencode.json"), JSON.stringify({
      provider: { anthropic: { name: "Host Anthropic" }, openai: { name: "Host OpenAI" } },
    }));

    const state = makeState(opHome);
    const destDir = join(opHome, "config", "assistant");
    mkdirSync(destDir, { recursive: true });
    // Pre-existing OP_HOME config with anthropic already configured
    writeFileSync(join(destDir, "opencode.json"), JSON.stringify({
      provider: { anthropic: { name: "Existing Anthropic" } },
    }));

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const result = importHostOpenCode(state, { overwriteConflicts: false });
      expect(result.conflicts).toEqual(["anthropic"]);
      expect(result.imported.providers).toBe(1); // only openai imported
    });

    const written = JSON.parse(readFileSync(join(destDir, "opencode.json"), "utf-8"));
    // Existing anthropic is preserved
    expect(written.provider.anthropic.name).toBe("Existing Anthropic");
    // Host openai was merged in
    expect(written.provider.openai.name).toBe("Host OpenAI");
  });

  it("overwrites existing providers when overwriteConflicts is true", () => {
    const hostConfigDir = join(xdgRoot, "config", "opencode");
    mkdirSync(hostConfigDir, { recursive: true });
    writeFileSync(join(hostConfigDir, "opencode.json"), JSON.stringify({
      provider: { anthropic: { name: "Host Anthropic" } },
    }));

    const state = makeState(opHome);
    const destDir = join(opHome, "config", "assistant");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "opencode.json"), JSON.stringify({
      provider: { anthropic: { name: "Old Anthropic" } },
    }));

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const result = importHostOpenCode(state, { overwriteConflicts: true });
      expect(result.conflicts).toHaveLength(0);
      expect(result.imported.providers).toBe(1);
    });

    const written = JSON.parse(readFileSync(join(opHome, "config", "assistant", "opencode.json"), "utf-8"));
    expect(written.provider.anthropic.name).toBe("Host Anthropic");
  });

  it("returns zero counts when no host config is present", () => {
    const state = makeState(opHome);
    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const result = importHostOpenCode(state);
      expect(result.imported.providers).toBe(0);
      expect(result.imported.credentials).toBe(0);
      expect(result.conflicts).toHaveLength(0);
    });
  });
});
