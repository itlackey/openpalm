import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSetupSpec,
  buildSecretsFromSetup,
  buildAuthJsonFromSetup,
  buildSystemSecretsFromSetup,
  performSetup,
} from "./setup.js";
import type { SetupSpec, SetupConnection } from "./setup.js";
import { STACK_SPEC_FILENAME, readStackSpec } from "./stack-spec.js";
import { readSecret } from './secrets-files.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeValidSpec(overrides?: Partial<SetupSpec>): SetupSpec {
  return {
    version: 2,
    llm: { provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com/v1" },
    embedding: { provider: "openai", model: "text-embedding-3-small", dims: 1536, baseUrl: "https://api.openai.com/v1" },
    security: { uiLoginPassword: "test-admin-token-12345" },
    owner: { name: "Test User", email: "test@example.com" },
    connections: [
      {
        id: "openai-main",
        name: "OpenAI",
        provider: "openai",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-test-key-123",
      },
    ],
    ...overrides,
  };
}

/** Seed the minimal asset files that ensure* functions expect to find at OP_HOME. */
function seedRequiredAssets(homeDir: string): void {
  mkdirSync(join(homeDir, "config", "stack"), { recursive: true });
  writeFileSync(join(homeDir, "config", "stack", "core.compose.yml"), "services:\n  assistant:\n    image: assistant:latest\n");
  mkdirSync(join(homeDir, "data", "assistant"), { recursive: true });
  writeFileSync(join(homeDir, "data", "assistant", "opencode.jsonc"), '{"$schema":"https://opencode.ai/config.json"}\n');
  writeFileSync(join(homeDir, "data", "assistant", "AGENTS.md"), "# Agents\n");
  mkdirSync(join(homeDir, "data"), { recursive: true });
  // Automations live in knowledge/tasks as AKM-owned task files.
  mkdirSync(join(homeDir, "data", "registry", "automations"), { recursive: true });
  writeFileSync(join(homeDir, "data", "registry", "automations", "cleanup-logs.yml"), "schedule: \"0 4 * * 0\"\ndescription: cleanup logs\ncommand: [\"echo\",\"clean\"]\n");
  writeFileSync(join(homeDir, "data", "registry", "automations", "cleanup-data.yml"), "schedule: \"0 5 * * 0\"\ndescription: cleanup data\ncommand: [\"echo\",\"clean\"]\n");
  writeFileSync(join(homeDir, "data", "registry", "automations", "validate-config.yml"), "schedule: \"0 3 * * *\"\ndescription: validate config\ncommand: [\"echo\",\"clean\"]\n");
}

// ── Tests: validateSetupSpec ────────────────────────────────────────────

describe("validateSetupSpec", () => {
  it("accepts a valid input", () => {
    const result = validateSetupSpec(makeValidSpec());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects null input", () => {
    const result = validateSetupSpec(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Input must be a non-null object");
  });

  it("rejects missing security object", () => {
    const spec = makeValidSpec();
    (spec as Record<string, unknown>).security = null;
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("security object is required"))).toBe(true);
  });

  it("rejects missing security.uiLoginPassword", () => {
    const spec = makeValidSpec();
    spec.security.uiLoginPassword = "";
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("security.uiLoginPassword"))).toBe(true);
  });

  it("rejects short security.uiLoginPassword", () => {
    const spec = makeValidSpec();
    spec.security.uiLoginPassword = "short";
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least 8"))).toBe(true);
  });

  it("accepts empty connections array", () => {
    const spec = makeValidSpec({ connections: [] });
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(true);
  });

  it("rejects duplicate connection IDs", () => {
    const conn: SetupConnection = {
      id: "dup",
      name: "Dup",
      provider: "openai",
      baseUrl: "",
      apiKey: "",
    };
    const spec = makeValidSpec({ connections: [conn, conn] });
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate"))).toBe(true);
  });

  it("accepts any provider string", () => {
    const spec = makeValidSpec({
      connections: [
        { id: "custom", name: "Custom", provider: "any-provider", baseUrl: "", apiKey: "" },
      ],
    });
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid connection ID pattern", () => {
    const spec = makeValidSpec({
      connections: [
        { id: "-invalid", name: "Bad", provider: "openai", baseUrl: "", apiKey: "" },
      ],
    });
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must start with a letter or digit"))).toBe(true);
  });

  it("rejects wrong version", () => {
    const input = makeValidSpec();
    (input as Record<string, unknown>).version = 1;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version must be 2"))).toBe(true);
  });

  it("rejects missing llm.model", () => {
    const input = makeValidSpec();
    (input.llm as Record<string, unknown>).model = "";
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("llm.model"))).toBe(true);
  });

  it("rejects missing llm.provider", () => {
    const input = makeValidSpec();
    (input.llm as Record<string, unknown>).provider = "";
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("llm.provider"))).toBe(true);
  });

  it("rejects non-integer embedding.dims", () => {
    const input = makeValidSpec();
    (input.embedding as Record<string, unknown>).dims = 1.5;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("dims must be a positive integer"))).toBe(true);
  });

  it("accepts spec without llm or embedding (minimal)", () => {
    const input = makeValidSpec();
    delete (input as Record<string, unknown>).llm;
    delete (input as Record<string, unknown>).embedding;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(true);
  });

  it("accepts multiple connections with different IDs", () => {
    const spec = makeValidSpec({
      connections: [
        { id: "openai-main", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-abc" },
        { id: "ollama-local", name: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "" },
      ],
    });
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(true);
  });

  it("accepts valid owner fields", () => {
    const spec = makeValidSpec({ owner: { name: "Alice", email: "alice@test.com" } });
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(true);
  });

  it("rejects non-string owner.name", () => {
    const spec = makeValidSpec();
    (spec.owner as Record<string, unknown>).name = 42;
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("owner.name"))).toBe(true);
  });

});

// ── Tests: buildSecretsFromSetup ─────────────────────────────────────────

describe("buildSecretsFromSetup", () => {
  it("does not include UI login password in user secrets", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OP_UI_LOGIN_PASSWORD).toBeUndefined();
    expect(secrets.OP_UI_TOKEN).toBeUndefined();
  });

  it("does not include SYSTEM_LLM_* in user secrets", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.SYSTEM_LLM_PROVIDER).toBeUndefined();
    expect(secrets.SYSTEM_LLM_MODEL).toBeUndefined();
    expect(secrets.SYSTEM_LLM_BASE_URL).toBeUndefined();
  });

  it("sets owner info when provided", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OP_OWNER_NAME).toBe("Test User");
    expect(secrets.OP_OWNER_EMAIL).toBe("test@example.com");
  });

  it("omits owner info when empty", () => {
    const spec = makeValidSpec({ owner: { name: "", email: "" } });
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OP_OWNER_NAME).toBeUndefined();
    expect(secrets.OP_OWNER_EMAIL).toBeUndefined();
  });

  it("does NOT include provider API keys in stack.env updates", () => {
    // Provider API keys now live in OpenCode's auth.json — buildSecretsFromSetup
    // returns only non-credential vars. See buildAuthJsonFromSetup for the key flow.
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OPENAI_API_KEY).toBeUndefined();
    expect(secrets.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("does not include Ollama base URL in stack.env secrets", () => {
    const caps: SetupConnection[] = [
      { id: "ollama-1", name: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "" },
    ];
    const secrets = buildSecretsFromSetup(caps);
    expect(secrets.SYSTEM_LLM_BASE_URL).toBeUndefined();
    expect(secrets.OLLAMA_BASE_URL).toBeUndefined();
  });
});

describe("buildAuthJsonFromSetup", () => {
  it("maps provider id → apiKey from the spec", () => {
    const conns: SetupConnection[] = [
      { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-from-spec" },
      { id: "anthropic-1", name: "Anthropic", provider: "anthropic", baseUrl: "", apiKey: "sk-ant" },
    ];
    const keys = buildAuthJsonFromSetup(conns);
    expect(keys.openai).toBe("sk-from-spec");
    expect(keys.anthropic).toBe("sk-ant");
  });

  it("falls back to process.env when spec apiKey is empty", () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-from-env";
    try {
      const conns: SetupConnection[] = [
        { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "" },
      ];
      const keys = buildAuthJsonFromSetup(conns);
      expect(keys.openai).toBe("sk-from-env");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("spec apiKey takes precedence over process.env", () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-from-env";
    try {
      const conns: SetupConnection[] = [
        { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-from-spec" },
      ];
      const keys = buildAuthJsonFromSetup(conns);
      expect(keys.openai).toBe("sk-from-spec");
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it("skips connections without a key in either spec or env", () => {
    const conns: SetupConnection[] = [
      { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "" },
    ];
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const keys = buildAuthJsonFromSetup(conns);
      expect(keys.openai).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("buildSystemSecretsFromSetup", () => {
  it("returns the file-based UI login password update", () => {
    const secrets = buildSystemSecretsFromSetup("test-admin-token-12345");
    expect(secrets.OP_UI_LOGIN_PASSWORD).toBe("test-admin-token-12345");
    expect(secrets.OP_UI_TOKEN).toBeUndefined();
    expect(secrets.OP_ASSISTANT_TOKEN).toBeUndefined();
  });
});

// ── Tests: performSetup ──────────────────────────────────────────────────

describe("performSetup", () => {
  let homeDir: string;
  let configDir: string;
  let dataDir: string;
  let stackDir: string;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-setup-"));
    configDir = join(homeDir, "config");
    dataDir = join(homeDir, "data");
    stackDir = join(configDir, "stack");

    // Create required directory structure
    for (const dir of [
      homeDir,
      configDir,
      join(homeDir, "data", "registry", "automations"),
      join(configDir, "assistant"),
      join(configDir, "akm"),
      stackDir,
      join(stackDir, "addons"),
      join(homeDir, "knowledge"),
      join(homeDir, "knowledge", "env"),
      join(homeDir, "knowledge", "secrets"),
      join(homeDir, "workspace"),
      dataDir,
      join(dataDir, "assistant"),
      join(dataDir, "admin"),
      join(dataDir, "guardian"),
      join(dataDir, "akm", "cache"),
      join(dataDir, "akm", "data"),
      join(dataDir, "logs"),
      join(dataDir, "backups"),
      join(dataDir, "rollback"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // Create stub stack.env so isSetupComplete doesn't crash
    writeFileSync(
      join(homeDir, "knowledge", "env", "stack.env"),
      [
        "OP_SETUP_COMPLETE=false",
        "OPENAI_BASE_URL=",
        "OP_OWNER_NAME=",
        "OP_OWNER_EMAIL=",
        "",
      ].join("\n")
    );

    // Seed required asset files at OP_HOME
    seedRequiredAssets(homeDir);

    // Override env vars for test isolation
    savedEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;
  });

  afterEach(() => {
    process.env.OP_HOME = savedEnv.OP_HOME;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns an error for invalid input", async () => {
    const result = await performSetup(
      { security: { uiLoginPassword: "short" } } as SetupSpec
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("writes the UI login password to knowledge/secrets", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    expect(readSecret(stackDir, 'op_ui_login_password')).toBe("test-admin-token-12345\n");
  });

  it("writes akm config.json with llm and embedding", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    const akmConfigPath = join(homeDir, "config", "akm", "config.json");
    expect(existsSync(akmConfigPath)).toBe(true);
    const config = JSON.parse(readFileSync(akmConfigPath, "utf-8"));
    // Canonical akm 0.8.0 shape: profiles.llm.default + defaults.llm — NOT top-level `llm`.
    expect(config.llm).toBeUndefined();
    expect(config.profiles.llm.default.model).toBe("gpt-4o");
    expect(config.profiles.llm.default.provider).toBe("openai");
    expect(config.defaults.llm).toBe("default");
    expect(config.embedding.model).toBe("text-embedding-3-small");
    expect(config.embedding.provider).toBe("openai");
    expect(config.embedding.dimension).toBe(1536);
    // The assistant primary stash is pinned to the bind mount, not operator-set.
    expect(config.stashDir).toBe("/stash");
  });

  it("does not write the legacy migration-triggering akm config shape (I-3)", async () => {
    // akm's config-migration.ts triggers the legacy 0.7->0.8 shim (which rewrites
    // the file on load) when `isObj(raw.llm) && hasOwn(raw.llm, "endpoint")`. We must
    // write the canonical shape so that condition can NEVER be satisfied — otherwise
    // the assistant's akm config silently rewrites on first load today and becomes a
    // fatal load error when akm removes the shim.
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);
    const config = JSON.parse(
      readFileSync(join(homeDir, "config", "akm", "config.json"), "utf-8"),
    ) as Record<string, unknown>;
    // The exact migration trigger: a top-level `llm` object carrying `endpoint`.
    const legacyLlm = config.llm as Record<string, unknown> | undefined;
    expect(legacyLlm === undefined || !Object.hasOwn(legacyLlm, "endpoint")).toBe(true);
    expect(config.llm).toBeUndefined();
  });

  it("writes stack.yml v2 version marker", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    const spec = readStackSpec(stackDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
  });

  it("writes core compose file to stack/", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    // applyInstall should have written the compose file to stack/ (not config/components/)
    const stagedCompose = join(homeDir, "config", "stack", "core.compose.yml");
    expect(existsSync(stagedCompose)).toBe(true);
  });

  it("writes akm config.json with ollama llm settings", async () => {
    const input = makeValidSpec({
      llm: { provider: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434/v1" },
      embedding: { provider: "ollama", model: "nomic-embed-text", dims: 768, baseUrl: "http://localhost:11434/v1" },
      connections: [
        { id: "ollama-local", name: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "" },
      ],
    });

    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    const akmConfigPath = join(homeDir, "config", "akm", "config.json");
    const config = JSON.parse(readFileSync(akmConfigPath, "utf-8"));
    expect(config.llm).toBeUndefined();
    expect(config.profiles.llm.default.provider).toBe("ollama");
    expect(config.profiles.llm.default.model).toBe("llama3.2");
    expect(config.profiles.llm.default.endpoint).toBe("http://localhost:11434/v1/chat/completions");
    expect(config.defaults.llm).toBe("default");
    expect(config.embedding.dimension).toBe(768);
  });

  it("auto-enables host akm sharing when host AKM is available (no overlay, no personal-side write)", async () => {
    // HOME must point at a temp dir so we NEVER touch the real ~/.config/akm.
    const fakeHome = mkdtempSync(join(tmpdir(), "openpalm-fakehome-"));
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      mkdirSync(join(fakeHome, "akm"), { recursive: true });
      mkdirSync(join(fakeHome, ".config", "akm"), { recursive: true });
      const hostCfgRaw = JSON.stringify({ stashDir: join(fakeHome, "akm") });
      writeFileSync(join(fakeHome, ".config", "akm", "config.json"), hostCfgRaw);

      const result = await performSetup(makeValidSpec({ hostAkm: true }));
      expect(result.ok).toBe(true);

      // NO conditional overlay file is produced any more.
      expect(existsSync(join(stackDir, "host-akm.compose.yml"))).toBe(false);
      // OP_HOST_AKM_STASH points at the host stash (mount is always in core.compose.yml).
      expect(readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8")).toContain(
        `OP_HOST_AKM_STASH=${join(fakeHome, "akm")}`,
      );
      // Assistant-side source entry present.
      const opCfg = JSON.parse(readFileSync(join(homeDir, "config", "akm", "config.json"), "utf-8"));
      expect((opCfg.sources as Array<Record<string, unknown>>).some((s) => s.name === "host-akm")).toBe(true);
      // D1: the personal config is NEVER written (byte-for-byte unchanged, no `openpalm` source).
      expect(readFileSync(join(fakeHome, ".config", "akm", "config.json"), "utf-8")).toBe(hostCfgRaw);
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("does not enable (and does not fail) when host AKM is not available; mount falls back to empty dir", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "openpalm-fakehome-"));
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // No ~/.config/akm/config.json → not available.
      const result = await performSetup(makeValidSpec({ hostAkm: true }));
      expect(result.ok).toBe(true);
      // No source entry added, and OP_HOST_AKM_STASH left unset (→ compose empty-dir fallback).
      const opCfg = JSON.parse(readFileSync(join(homeDir, "config", "akm", "config.json"), "utf-8"));
      expect((opCfg.sources ?? []).some((s: { name?: string }) => s.name === "host-akm")).toBe(false);
      expect(readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8")).not.toContain("OP_HOST_AKM_STASH=");
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("writes stack.yml as version marker only", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    const specPath = join(stackDir, STACK_SPEC_FILENAME);
    expect(existsSync(specPath)).toBe(true);

    const spec = readStackSpec(stackDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
  });

  it("completes setup with multiple connections", async () => {
    const input = makeValidSpec({
      connections: [
        { id: "openai_primary", name: "OpenAI Primary", provider: "openai", baseUrl: "https://api.openai.com", apiKey: "sk-primary" },
        { id: "openai-secondary", name: "OpenAI Secondary", provider: "openai", baseUrl: "https://api.openai.com", apiKey: "sk-secondary" },
      ],
    });

    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    const spec = readStackSpec(stackDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);

    const stackEnv = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), 'utf-8');
    expect(stackEnv).not.toContain('OPENAI_API_KEY=');
    expect(readSecret(stackDir, 'openai_api_key')).toBeNull();

    const authJson = JSON.parse(readFileSync(join(homeDir, "knowledge", "secrets", "auth.json"), 'utf-8')) as Record<string, { key: string }>;
    expect(authJson.openai.key).toBe('sk-secondary');
  });

  it("splits channel credentials between secret files and stack.env", async () => {
    const input = makeValidSpec({
      channelCredentials: {
        discord: {
          botToken: "discord-bot-token-xyz",
          applicationId: "discord-app-id-123",
        },
      },
    });

    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    expect(readSecret(stackDir, 'discord_bot_token')).toBe("discord-bot-token-xyz\n");
    expect(readSecret(stackDir, 'discord_application_id')).toBeNull();
    const stackEnv = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), 'utf-8');
    expect(stackEnv).toContain('DISCORD_APPLICATION_ID=discord-app-id-123');
    expect(stackEnv).not.toContain('DISCORD_BOT_TOKEN=');
  });

  it("ensureOpenCodeConfig never writes forbidden keys (providers, smallModel, model) to the user config", async () => {
    // OpenCode v1.2.24+ rejects these keys with ConfigInvalidError at startup.
    // This test locks the starter config shape so future changes can't
    // accidentally introduce keys that would crash the assistant on boot.
    const { ensureOpenCodeConfig } = await import("./secrets.js");
    ensureOpenCodeConfig();

    const configPath = join(homeDir, "config", "assistant", "opencode.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config).not.toHaveProperty("providers");
    expect(config).not.toHaveProperty("smallModel");
    expect(config).not.toHaveProperty("model");
    // $schema is the only required key
    expect(config.$schema).toBeTruthy();
  });
});
