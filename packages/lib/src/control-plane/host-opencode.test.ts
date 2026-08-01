/**
 * Tests for detectHostOpenCode() and importHostOpenCode().
 *
 * Uses real temp directories — no network, no Docker, no akm CLI.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectHostOpenCode,
  importHostOpenCode,
  persistHostOpenCodeOAuthCredential,
} from "./host-opencode.js";
import type { ControlPlaneState } from "./types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeState(homeDir: string): ControlPlaneState {
  return {
    homeDir,
    configDir: join(homeDir, "config"),
    stashDir: join(homeDir, "knowledge"),
    workspaceDir: join(homeDir, "workspace"),
    dataDir: join(homeDir, "data"),
    stackDir: join(homeDir, "config/stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
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

  it("returns modelPreferences when model and small_model are set", () => {
    const configDir = join(xdgRoot, "config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
      provider: { groq: {} },
      model: "groq/llama-3.3-70b-versatile",
      small_model: "groq/llama-3.1-8b-instant",
    }));
    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const status = detectHostOpenCode();
      expect(status.modelPreferences).toBeDefined();
      expect(status.modelPreferences?.model).toBe("groq/llama-3.3-70b-versatile");
      expect(status.modelPreferences?.small_model).toBe("groq/llama-3.1-8b-instant");
    });
  });

  it("omits modelPreferences when no model fields are set", () => {
    const configDir = join(xdgRoot, "config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
      provider: { groq: {} },
    }));
    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const status = detectHostOpenCode();
      expect(status.modelPreferences).toBeUndefined();
    });
  });

  it("returns partial modelPreferences when only model is set", () => {
    const configDir = join(xdgRoot, "config", "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
      provider: { anthropic: {} },
      model: "anthropic/claude-sonnet-4-5",
    }));
    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const status = detectHostOpenCode();
      expect(status.modelPreferences?.model).toBe("anthropic/claude-sonnet-4-5");
      expect(status.modelPreferences?.small_model).toBeUndefined();
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
      provider: { openai: { name: "OpenAI" }, groq: {} },
      model: "openai/gpt-4o",
      small_model: "openai/gpt-4o-mini",
      disabled_providers: ["groq"],
      // These should be stripped:
      plugin: [{ module: "some-plugin" }],
      mcp: { server: {} },
    }));
    writeFileSync(join(hostDataDir, "auth.json"), JSON.stringify({
      openai: { token: "sk-openai-token" },
    }));

    const state = makeState(opHome);

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const result = importHostOpenCode(state);
      expect(result.imported.providers).toBe(2);
      expect(result.imported.credentials).toBe(1);
      expect(result.conflicts).toHaveLength(0);
      expect(result.changed).toEqual({ config: true, auth: true });
    });

    // Verify opencode.json was written and plugin key was stripped
    const destConfig = JSON.parse(readFileSync(join(opHome, "config", "assistant", "opencode.json"), "utf-8"));
    expect(destConfig.provider).toEqual({ openai: { name: "OpenAI" }, groq: {} });
    expect(destConfig.model).toBe("openai/gpt-4o");
    expect(destConfig.small_model).toBe("openai/gpt-4o-mini");
    expect(destConfig.disabled_providers).toEqual(["groq"]);
    expect(destConfig.plugin).toBeUndefined();
    expect(destConfig.mcp).toBeUndefined();

    // Verify auth.json was written
    expect(existsSync(join(opHome, "knowledge", "secrets", "auth.json"))).toBe(true);

    // Verify auth.json permissions are 0o600
    const authStat = statSync(join(opHome, "knowledge", "secrets", "auth.json"));
    // On Linux, mode & 0o777 extracts permission bits
    expect(authStat.mode & 0o777).toBe(0o600);
  });

  it("filters anthropic credentials from auth.json on fresh import", () => {
    const hostConfigDir = join(xdgRoot, "config", "opencode");
    const hostDataDir = join(xdgRoot, "data", "opencode");
    mkdirSync(hostConfigDir, { recursive: true });
    mkdirSync(hostDataDir, { recursive: true });

    writeFileSync(join(hostConfigDir, "opencode.json"), JSON.stringify({
      provider: { openai: { name: "OpenAI" } },
    }));
    // Host has both anthropic and openai credentials — only openai should land in OP_HOME.
    writeFileSync(join(hostDataDir, "auth.json"), JSON.stringify({
      anthropic: { token: "sk-ant-secret" },
      openai: { token: "sk-openai-token" },
    }));

    const state = makeState(opHome);

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const result = importHostOpenCode(state);
      // anthropic is filtered out; only openai counts
      expect(result.imported.credentials).toBe(1);
    });

    const destAuth = JSON.parse(readFileSync(join(opHome, "knowledge", "secrets", "auth.json"), "utf-8"));
    expect(destAuth.anthropic).toBeUndefined();
    expect(destAuth.openai).toBeDefined();
  });

  it("filters anthropic credentials from auth.json on merge import", () => {
    const hostConfigDir = join(xdgRoot, "config", "opencode");
    const hostDataDir = join(xdgRoot, "data", "opencode");
    mkdirSync(hostConfigDir, { recursive: true });
    mkdirSync(hostDataDir, { recursive: true });

    writeFileSync(join(hostConfigDir, "opencode.json"), JSON.stringify({
      provider: { openai: { name: "OpenAI" } },
    }));
    writeFileSync(join(hostDataDir, "auth.json"), JSON.stringify({
      anthropic: { token: "sk-ant-secret" },
      openai: { token: "sk-openai-token" },
    }));

    const state = makeState(opHome);
    // Pre-create an existing auth.json so the merge path is taken
    const destSecretsDir = join(opHome, "knowledge", "secrets");
    mkdirSync(destSecretsDir, { recursive: true });
    writeFileSync(join(destSecretsDir, "auth.json"), JSON.stringify({
      groq: { token: "gsk-existing" },
    }));

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const result = importHostOpenCode(state, { overwriteConflicts: false });
      // Only openai is new and non-anthropic
      expect(result.imported.credentials).toBe(1);
    });

    const destAuth = JSON.parse(readFileSync(join(destSecretsDir, "auth.json"), "utf-8"));
    expect(destAuth.anthropic).toBeUndefined();
    expect(destAuth.openai).toBeDefined();
    expect(destAuth.groq).toBeDefined(); // pre-existing preserved
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

  it("keeps existing model defaults and fills only missing host fields", () => {
    const hostConfigDir = join(xdgRoot, "config", "opencode");
    mkdirSync(hostConfigDir, { recursive: true });
    writeFileSync(join(hostConfigDir, "opencode.json"), JSON.stringify({
      provider: { openai: { name: "Host OpenAI" } },
      model: "openai/gpt-4.1",
      small_model: "openai/gpt-4.1-mini",
      disabled_providers: ["groq"],
    }));

    const state = makeState(opHome);
    const destDir = join(opHome, "config", "assistant");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "opencode.json"), JSON.stringify({
      provider: { anthropic: { name: "Existing Anthropic" } },
      model: "anthropic/claude-sonnet-4",
    }));

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      importHostOpenCode(state);
    });

    const written = JSON.parse(readFileSync(join(destDir, "opencode.json"), "utf-8"));
    expect(written.model).toBe("anthropic/claude-sonnet-4");
    expect(written.small_model).toBe("openai/gpt-4.1-mini");
    expect(written.disabled_providers).toEqual(["groq"]);
  });

  it("returns zero counts when no host config is present", () => {
    const state = makeState(opHome);
    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const result = importHostOpenCode(state);
      expect(result.imported.providers).toBe(0);
      expect(result.imported.credentials).toBe(0);
      expect(result.conflicts).toHaveLength(0);
      expect(result.changed).toEqual({ config: false, auth: false });
    });
  });

  it("reports no durable change when an import is repeated", () => {
    const hostConfigDir = join(xdgRoot, "config", "opencode");
    const hostDataDir = join(xdgRoot, "data", "opencode");
    mkdirSync(hostConfigDir, { recursive: true });
    mkdirSync(hostDataDir, { recursive: true });
    writeFileSync(join(hostConfigDir, "opencode.json"), JSON.stringify({ provider: { openai: {} } }));
    writeFileSync(join(hostDataDir, "auth.json"), JSON.stringify({ openai: { token: "sk-openai" } }));
    const state = makeState(opHome);

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      expect(importHostOpenCode(state).changed).toEqual({ config: true, auth: true });
      expect(importHostOpenCode(state).changed).toEqual({ config: false, auth: false });
    });
  });

  it("partial-merge auth: does not overwrite existing credential, adds new one", () => {
    // Pre-seed OP_HOME/knowledge/secrets/auth.json with one existing credential
    mkdirSync(join(opHome, "knowledge", "secrets"), { recursive: true });
    writeFileSync(join(opHome, "knowledge", "secrets", "auth.json"), JSON.stringify({
      azure: { type: "api", key: "existing" },
    }));

    // Set up host auth.json with azure (conflict) + groq (new)
    const hostDataDir = join(xdgRoot, "data", "opencode");
    mkdirSync(hostDataDir, { recursive: true });
    writeFileSync(join(hostDataDir, "auth.json"), JSON.stringify({
      azure: { type: "api", key: "host-override" },
      groq: { type: "api", key: "gsk-host" },
    }));

    const state = makeState(opHome);

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      const result = importHostOpenCode(state, { overwriteConflicts: false });
      // Only groq was new — azure is a conflict and must NOT be overwritten
      expect(result.imported.credentials).toBe(1);
    });

    // Verify azure key was NOT overwritten
    const written = JSON.parse(readFileSync(join(opHome, "knowledge", "secrets", "auth.json"), "utf-8")) as Record<string, { key: string }>;
    expect(written.azure.key).toBe("existing");
    // Verify groq was added
    expect(written.groq.key).toBe("gsk-host");
  });

  for (const credential of [
    { type: "oauth", access: "new-access", refresh: "new-refresh" },
    { type: "api", key: "oauth-method-result" },
  ]) {
    it(`persists a completed OAuth method stored as type ${credential.type}`, () => {
      const hostDataDir = join(xdgRoot, "data", "opencode");
      mkdirSync(hostDataDir, { recursive: true });
      writeFileSync(join(hostDataDir, "auth.json"), JSON.stringify({
        openai: credential,
        github: { type: "oauth", access: "unrelated" },
      }));

      const destDir = join(opHome, "knowledge", "secrets");
      const destPath = join(destDir, "auth.json");
      mkdirSync(destDir, { recursive: true, mode: 0o755 });
      writeFileSync(destPath, JSON.stringify({
        groq: { type: "api", key: "existing" },
        openai: { type: "oauth", access: "old-access" },
      }), { mode: 0o640 });
      const inode = statSync(destPath).ino;

      withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
        persistHostOpenCodeOAuthCredential(makeState(opHome), "openai");
      });

      const written = JSON.parse(readFileSync(destPath, "utf-8"));
      expect(written).toEqual({
        groq: { type: "api", key: "existing" },
        openai: credential,
      });
      expect(written.github).toBeUndefined();
      expect(statSync(destPath).ino).toBe(inode);
      expect(statSync(destPath).mode & 0o777).toBe(0o600);
      expect(statSync(destDir).mode & 0o777).toBe(0o700);
    });
  }

  it("rejects non-object credential entries", () => {
    const hostDataDir = join(xdgRoot, "data", "opencode");
    mkdirSync(hostDataDir, { recursive: true });
    const hostAuthPath = join(hostDataDir, "auth.json");

    withXdgEnv(`${xdgRoot}/config`, `${xdgRoot}/data`, () => {
      for (const invalid of [null, "credential", 42, ["credential"]]) {
        writeFileSync(hostAuthPath, JSON.stringify({ openai: invalid }));
        expect(() => persistHostOpenCodeOAuthCredential(makeState(opHome), "openai"))
          .toThrow("Completed OAuth credential for openai was not found");
      }
    });
  });
});
