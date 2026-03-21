import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSetupInput,
  buildSecretsFromSetup,
  buildSystemSecretsFromSetup,
  buildConnectionEnvVarMap,
  performSetup,
  validateSetupConfig,
  normalizeToSetupInput,
  buildChannelCredentialEnvVars,
  performSetupFromConfig,
  CHANNEL_CREDENTIAL_ENV_MAP,
} from "./setup.js";
import type { SetupInput, SetupConnection, SetupConfig } from "./setup.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";
import { STACK_SPEC_FILENAME, readStackSpec } from "./stack-spec.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeValidInput(overrides?: Partial<SetupInput>): SetupInput {
  return {
    adminToken: "test-admin-token-12345",
    ownerName: "Test User",
    ownerEmail: "test@example.com",
    memoryUserId: "test_user",
    ollamaEnabled: false,
    connections: [
      {
        id: "openai-main",
        name: "OpenAI",
        provider: "openai",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-test-key-123",
      },
    ],
    assignments: {
      llm: { connectionId: "openai-main", model: "gpt-4o" },
      embeddings: { connectionId: "openai-main", model: "text-embedding-3-small" },
    },
    ...overrides,
  };
}

/** Stub asset provider that returns minimal content for all assets. */
function createStubAssetProvider(): CoreAssetProvider {
  return {
    coreCompose: () => "services:\n  assistant:\n    image: assistant:latest\n",
    agentsMd: () => "# Agents\n",
    opencodeConfig: () => '{"$schema":"https://opencode.ai/config.json"}\n',
    secretsSchema: () => "ADMIN_TOKEN=string\n",
    stackSchema: () => "OP_IMAGE_TAG=string\n",
    cleanupLogs: () => "name: cleanup-logs\nschedule: daily\n",
    cleanupData: () => "name: cleanup-data\nschedule: weekly\n",
    validateConfig: () => "name: validate-config\nschedule: hourly\n",
  };
}

// ── Tests: validateSetupInput ────────────────────────────────────────────

describe("validateSetupInput", () => {
  it("accepts a valid input", () => {
    const result = validateSetupInput(makeValidInput());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects null input", () => {
    const result = validateSetupInput(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Input must be a non-null object");
  });

  it("rejects missing adminToken", () => {
    const input = makeValidInput({ adminToken: "" });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("adminToken"))).toBe(true);
  });

  it("rejects short adminToken", () => {
    const input = makeValidInput({ adminToken: "short" });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least 8"))).toBe(true);
  });

  it("rejects empty connections array", () => {
    const input = makeValidInput({ connections: [] });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("connections"))).toBe(true);
  });

  it("rejects duplicate connection IDs", () => {
    const conn: SetupConnection = {
      id: "dup",
      name: "Dup",
      provider: "openai",
      baseUrl: "",
      apiKey: "",
    };
    const input = makeValidInput({ connections: [conn, conn] });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate"))).toBe(true);
  });

  it("rejects unsupported provider", () => {
    const input = makeValidInput({
      connections: [
        { id: "bad", name: "Bad", provider: "unsupported-provider", baseUrl: "", apiKey: "" },
      ],
    });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("outside wizard scope"))).toBe(true);
  });

  it("rejects invalid connection ID pattern", () => {
    const input = makeValidInput({
      connections: [
        { id: "-invalid", name: "Bad", provider: "openai", baseUrl: "", apiKey: "" },
      ],
    });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must start with a letter or digit"))).toBe(true);
  });

  it("rejects missing assignments.llm", () => {
    const input = makeValidInput();
    (input.assignments as Record<string, unknown>).llm = null;
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("assignments.llm"))).toBe(true);
  });

  it("rejects missing assignments.embeddings", () => {
    const input = makeValidInput();
    (input.assignments as Record<string, unknown>).embeddings = null;
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("assignments.embeddings"))).toBe(true);
  });

  it("rejects non-integer embeddingDims", () => {
    const input = makeValidInput();
    input.assignments.embeddings.embeddingDims = 1.5;
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("embeddingDims"))).toBe(true);
  });

  it("rejects assignment referencing non-existent connection", () => {
    const input = makeValidInput();
    input.assignments.llm.connectionId = "does-not-exist";
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("does not match any connection"))).toBe(true);
  });

  it("accepts multiple connections with different IDs", () => {
    const input = makeValidInput({
      connections: [
        { id: "openai-main", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-abc" },
        { id: "ollama-local", name: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "" },
      ],
    });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(true);
  });

  it("rejects memoryUserId with dots", () => {
    const input = makeValidInput({ memoryUserId: "user.name" });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("alphanumeric and underscores only"))).toBe(true);
  });

  it("rejects memoryUserId with hyphens", () => {
    const input = makeValidInput({ memoryUserId: "user-name" });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("alphanumeric and underscores only"))).toBe(true);
  });

  it("accepts memoryUserId with underscores", () => {
    const input = makeValidInput({ memoryUserId: "user_name_123" });
    const result = validateSetupInput(input);
    expect(result.valid).toBe(true);
  });
});

// ── Tests: buildSecretsFromSetup ─────────────────────────────────────────

describe("buildSecretsFromSetup", () => {
  it("does not include admin token in user secrets", () => {
    const secrets = buildSecretsFromSetup(makeValidInput());
    expect(secrets.OP_ADMIN_TOKEN).toBeUndefined();
    expect(secrets.ADMIN_TOKEN).toBeUndefined();
  });

  it("does not include SYSTEM_LLM_* in user secrets (now in capabilities)", () => {
    const secrets = buildSecretsFromSetup(makeValidInput());
    expect(secrets.SYSTEM_LLM_PROVIDER).toBeUndefined();
    expect(secrets.SYSTEM_LLM_MODEL).toBeUndefined();
    expect(secrets.SYSTEM_LLM_BASE_URL).toBeUndefined();
    expect(secrets.OPENAI_BASE_URL).toBeUndefined();
  });

  it("does not include MEMORY_USER_ID in user secrets (now in capabilities)", () => {
    const secrets = buildSecretsFromSetup(makeValidInput());
    expect(secrets.MEMORY_USER_ID).toBeUndefined();
  });

  it("does not include MEMORY_USER_ID even when empty (now in capabilities)", () => {
    const secrets = buildSecretsFromSetup(makeValidInput({ memoryUserId: "" }));
    expect(secrets.MEMORY_USER_ID).toBeUndefined();
  });

  it("sets owner info when provided", () => {
    const secrets = buildSecretsFromSetup(makeValidInput());
    expect(secrets.OWNER_NAME).toBe("Test User");
    expect(secrets.OWNER_EMAIL).toBe("test@example.com");
  });

  it("omits owner info when empty", () => {
    const secrets = buildSecretsFromSetup(makeValidInput({ ownerName: "", ownerEmail: "" }));
    expect(secrets.OWNER_NAME).toBeUndefined();
    expect(secrets.OWNER_EMAIL).toBeUndefined();
  });

  it("maps API key to correct env var", () => {
    const secrets = buildSecretsFromSetup(makeValidInput());
    expect(secrets.OPENAI_API_KEY).toBe("sk-test-key-123");
  });

  it("does not include Ollama base URL in user secrets when ollamaEnabled (now in capabilities)", () => {
    const input = makeValidInput({
      ollamaEnabled: true,
      connections: [
        { id: "ollama-1", name: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "" },
      ],
      assignments: {
        llm: { connectionId: "ollama-1", model: "llama3.2" },
        embeddings: { connectionId: "ollama-1", model: "nomic-embed-text" },
      },
    });
    const secrets = buildSecretsFromSetup(input);
    // These are no longer written to user.env — they live in capabilities/managed.env
    expect(secrets.SYSTEM_LLM_BASE_URL).toBeUndefined();
    expect(secrets.OPENAI_BASE_URL).toBeUndefined();
  });
});

describe("buildSystemSecretsFromSetup", () => {
  it("includes distinct admin and assistant credentials", () => {
    const secrets = buildSystemSecretsFromSetup(makeValidInput());
    expect(secrets.OP_ADMIN_TOKEN).toBe("test-admin-token-12345");
    expect(typeof secrets.ASSISTANT_TOKEN).toBe("string");
    expect(secrets.ASSISTANT_TOKEN).not.toBe("test-admin-token-12345");
    expect(typeof secrets.MEMORY_AUTH_TOKEN).toBe("string");
  });
});

// ── Tests: buildConnectionEnvVarMap ──────────────────────────────────────

describe("buildConnectionEnvVarMap", () => {
  it("maps a single OpenAI connection", () => {
    const connections: SetupConnection[] = [
      { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-abc" },
    ];
    const map = buildConnectionEnvVarMap(connections);
    expect(map.get("openai-1")).toBe("OPENAI_API_KEY");
  });

  it("namespaces duplicate provider env vars with safe IDs", () => {
    const connections: SetupConnection[] = [
      { id: "openai_1", name: "OpenAI Primary", provider: "openai", baseUrl: "", apiKey: "sk-abc" },
      { id: "openai_2", name: "OpenAI Secondary", provider: "openai", baseUrl: "", apiKey: "sk-def" },
    ];
    const map = buildConnectionEnvVarMap(connections);
    expect(map.get("openai_1")).toBe("OPENAI_API_KEY");
    expect(map.get("openai_2")).toBe("OPENAI_API_KEY_OPENAI_2");
  });

  it("skips connections with unsafe env var keys (hyphen in ID)", () => {
    const connections: SetupConnection[] = [
      { id: "openai-1", name: "OpenAI Primary", provider: "openai", baseUrl: "", apiKey: "sk-abc" },
      { id: "openai-2", name: "OpenAI Secondary", provider: "openai", baseUrl: "", apiKey: "sk-def" },
    ];
    const map = buildConnectionEnvVarMap(connections);
    expect(map.get("openai-1")).toBe("OPENAI_API_KEY");
    // openai-2 generates OPENAI_API_KEY_OPENAI-2 which fails the SAFE_ENV_KEY_RE (hyphen)
    expect(map.has("openai-2")).toBe(false);
  });

  it("maps different providers to their canonical env vars", () => {
    const connections: SetupConnection[] = [
      { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-abc" },
      { id: "groq-1", name: "Groq", provider: "groq", baseUrl: "", apiKey: "gsk-abc" },
    ];
    const map = buildConnectionEnvVarMap(connections);
    expect(map.get("openai-1")).toBe("OPENAI_API_KEY");
    expect(map.get("groq-1")).toBe("GROQ_API_KEY");
  });

  it("uses OPENAI_API_KEY fallback for unmapped providers", () => {
    const connections: SetupConnection[] = [
      { id: "ollama-1", name: "Ollama", provider: "ollama", baseUrl: "", apiKey: "" },
    ];
    const map = buildConnectionEnvVarMap(connections);
    expect(map.get("ollama-1")).toBe("OPENAI_API_KEY");
  });
});

// ── Tests: performSetup ──────────────────────────────────────────────────

describe("performSetup", () => {
  let homeDir: string;
  let configDir: string;
  let vaultDir: string;
  let dataDir: string;
  let logsDir: string;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-setup-"));
    configDir = join(homeDir, "config");
    vaultDir = join(homeDir, "vault");
    dataDir = join(homeDir, "data");
    logsDir = join(homeDir, "logs");

    // Create required directory structure
    for (const dir of [
      homeDir,
      configDir,
      join(configDir, "components"),
      join(configDir, "automations"),
      join(configDir, "channels"),
      join(configDir, "connections"),
      join(configDir, "assistant"),
      join(configDir, "stash"),
      vaultDir,
      dataDir,
      join(dataDir, "admin"),
      join(dataDir, "memory"),
      join(dataDir, "assistant"),
      join(dataDir, "guardian"),
      join(dataDir, "automations"),
      join(dataDir, "opencode"),
      logsDir,
      join(logsDir, "opencode"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // Create stub stack.env so isSetupComplete doesn't crash
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(join(vaultDir, "stack", "stack.env"), "OP_SETUP_COMPLETE=false\n");

    // Seed a user.env file to avoid ensureSecrets() file-not-found
    writeFileSync(
      join(vaultDir, "user", "user.env"),
      [
        "# OpenPalm Secrets",
        "export OP_ADMIN_TOKEN=",
        "export ADMIN_TOKEN=",
        "export OPENAI_API_KEY=",
        "export OPENAI_BASE_URL=",
        "export ANTHROPIC_API_KEY=",
        "export GROQ_API_KEY=",
        "export MISTRAL_API_KEY=",
        "export GOOGLE_API_KEY=",
        "export MEMORY_USER_ID=default_user",
        "export MEMORY_AUTH_TOKEN=abc123",
        "export OWNER_NAME=",
        "export OWNER_EMAIL=",
        "",
      ].join("\n")
    );

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
      { adminToken: "short" } as SetupInput,
      createStubAssetProvider()
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("writes stack.env with the admin token", async () => {
    const result = await performSetup(makeValidInput(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    const secretsContent = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(secretsContent).toContain("test-admin-token-12345");
  });

  it("writes memory config", async () => {
    const result = await performSetup(makeValidInput(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    const memConfigPath = join(dataDir, "memory", "default_config.json");
    expect(existsSync(memConfigPath)).toBe(true);

    const memConfig = JSON.parse(readFileSync(memConfigPath, "utf-8"));
    expect(memConfig.mem0.llm.config.model).toBe("gpt-4o");
    expect(memConfig.mem0.embedder.config.model).toBe("text-embedding-3-small");
  });

  it("writes capabilities to stack.yaml v2", async () => {
    const result = await performSetup(makeValidInput(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.capabilities.llm).toBe("openai/gpt-4o");
    expect(spec!.capabilities.embeddings.model).toBe("text-embedding-3-small");
    expect(spec!.capabilities.embeddings.provider).toBe("openai");
  });

  it("creates staged artifacts directory", async () => {
    const result = await performSetup(makeValidInput(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    // applyInstall should have written the compose file
    const stagedCompose = join(configDir, "components", "core.yml");
    expect(existsSync(stagedCompose)).toBe(true);
  });

  it("writes ollama addon when ollamaEnabled is true", async () => {
    const input = makeValidInput({
      ollamaEnabled: true,
      connections: [
        {
          id: "ollama-local",
          name: "Ollama",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "",
        },
      ],
      assignments: {
        llm: { connectionId: "ollama-local", model: "llama3.2" },
        embeddings: { connectionId: "ollama-local", model: "nomic-embed-text" },
      },
    });

    const result = await performSetup(input, createStubAssetProvider());
    expect(result.ok).toBe(true);

    // v2 spec should have ollama addon enabled and correct capabilities
    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.addons.ollama).toBe(true);
    expect(spec!.capabilities.llm).toBe("ollama/llama3.2");
  });

  it("resolves embedding dims from EMBEDDING_DIMS lookup", async () => {
    const input = makeValidInput({
      connections: [
        {
          id: "ollama-local",
          name: "Ollama",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "",
        },
      ],
      assignments: {
        llm: { connectionId: "ollama-local", model: "llama3.2" },
        embeddings: { connectionId: "ollama-local", model: "nomic-embed-text" },
      },
    });

    const result = await performSetup(input, createStubAssetProvider());
    expect(result.ok).toBe(true);

    // nomic-embed-text is 768 dims per EMBEDDING_DIMS
    const memConfigPath = join(dataDir, "memory", "default_config.json");
    const memConfig = JSON.parse(readFileSync(memConfigPath, "utf-8"));
    expect(memConfig.mem0.vector_store.config.embedding_model_dims).toBe(768);
  });

  it("writes stack.yaml with correct v2 structure", async () => {
    const result = await performSetup(makeValidInput(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    const specPath = join(configDir, STACK_SPEC_FILENAME);
    expect(existsSync(specPath)).toBe(true);

    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.capabilities.llm).toBe("openai/gpt-4o");
    expect(spec!.capabilities.embeddings.provider).toBe("openai");
    expect(spec!.capabilities.embeddings.model).toBe("text-embedding-3-small");
    expect(spec!.capabilities.memory.userId).toBe("test_user");
    expect(Object.keys(spec!.addons)).toHaveLength(0);
  });

  it("completes setup even when duplicate connection ID with hyphen is skipped by env var map", async () => {
    // When two connections share a provider and the second has a hyphen in the ID,
    // buildConnectionEnvVarMap skips it (OPENAI_API_KEY_OPENAI-2 fails SAFE_ENV_KEY_RE).
    // Setup should still succeed — the primary connection's key is written.
    const input = makeValidInput({
      connections: [
        { id: "openai_primary", name: "OpenAI Primary", provider: "openai", baseUrl: "https://api.openai.com", apiKey: "sk-primary" },
        { id: "openai-secondary", name: "OpenAI Secondary", provider: "openai", baseUrl: "https://api.openai.com", apiKey: "sk-secondary" },
      ],
      assignments: {
        llm: { connectionId: "openai_primary", model: "gpt-4o" },
        embeddings: { connectionId: "openai_primary", model: "text-embedding-3-small" },
      },
    });

    const result = await performSetup(input, createStubAssetProvider());
    expect(result.ok).toBe(true);

    // v2 spec should still have correct capabilities
    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.capabilities.llm).toBe("openai/gpt-4o");
  });

  it("writes TTS and STT env vars to user.env when voice uses openai engines", async () => {
    const input = makeValidInput({
      voice: { tts: "openai-tts", stt: "openai-stt" },
    });
    const result = await performSetup(input, createStubAssetProvider());
    expect(result.ok).toBe(true);

    const secretsContent = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(secretsContent).toContain("TTS_MODEL=tts-1");
    expect(secretsContent).toContain("TTS_VOICE=alloy");
    expect(secretsContent).toContain("STT_MODEL=whisper-1");
  });

  it("writes TTS env vars for local engines without API key", async () => {
    const input = makeValidInput({
      voice: { tts: "kokoro", stt: "whisper-local" },
    });
    const result = await performSetup(input, createStubAssetProvider());
    expect(result.ok).toBe(true);

    const secretsContent = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(secretsContent).toContain("TTS_MODEL=kokoro");
    expect(secretsContent).toContain("TTS_BASE_URL=http://kokoro:8880");
    expect(secretsContent).toContain("STT_MODEL=whisper-1");
    expect(secretsContent).toContain("STT_BASE_URL=http://whisper:9000");
  });

  it("does not write voice env vars when voice is not provided", async () => {
    const input = makeValidInput();
    const result = await performSetup(input, createStubAssetProvider());
    expect(result.ok).toBe(true);

    const secretsContent = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(secretsContent).not.toContain("TTS_MODEL=");
    expect(secretsContent).not.toContain("STT_MODEL=");
  });

  it("writes TTS only when stt is absent", async () => {
    const input = makeValidInput({
      voice: { tts: "kokoro" },
    });
    const result = await performSetup(input, createStubAssetProvider());
    expect(result.ok).toBe(true);

    const secretsContent = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(secretsContent).toContain("TTS_MODEL=kokoro");
    expect(secretsContent).not.toContain("STT_MODEL=");
  });
});

// ── Helpers: SetupConfig ─────────────────────────────────────────────────

function makeValidConfig(overrides?: Partial<SetupConfig>): SetupConfig {
  return {
    version: 1,
    owner: { name: "Test User", email: "test@example.com" },
    security: { adminToken: "test-admin-token-12345" },
    connections: [
      {
        id: "openai-main",
        name: "OpenAI",
        provider: "openai",
        baseUrl: "https://api.openai.com",
        apiKey: "sk-test-key-123",
      },
    ],
    assignments: {
      llm: { connectionId: "openai-main", model: "gpt-4o" },
      embeddings: { connectionId: "openai-main", model: "text-embedding-3-small" },
    },
    memory: { userId: "test_user" },
    ...overrides,
  };
}

// ── Tests: validateSetupConfig ───────────────────────────────────────────

describe("validateSetupConfig", () => {
  it("accepts a valid config", () => {
    const result = validateSetupConfig(makeValidConfig());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects null input", () => {
    const result = validateSetupConfig(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Config must be a non-null object");
  });

  it("rejects wrong version", () => {
    const config = { ...makeValidConfig(), version: 2 };
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version must be 1"))).toBe(true);
  });

  it("rejects missing security object", () => {
    const config = makeValidConfig();
    (config as Record<string, unknown>).security = null;
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("security object is required"))).toBe(true);
  });

  it("rejects missing security.adminToken", () => {
    const config = makeValidConfig();
    config.security.adminToken = "";
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("security.adminToken"))).toBe(true);
  });

  it("rejects short security.adminToken", () => {
    const config = makeValidConfig();
    config.security.adminToken = "short";
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least 8"))).toBe(true);
  });

  it("rejects empty connections array", () => {
    const config = makeValidConfig({ connections: [] });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("connections"))).toBe(true);
  });

  it("rejects duplicate connection IDs", () => {
    const conn: SetupConnection = {
      id: "dup",
      name: "Dup",
      provider: "openai",
      baseUrl: "",
      apiKey: "",
    };
    const config = makeValidConfig({ connections: [conn, conn] });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Duplicate"))).toBe(true);
  });

  it("rejects unsupported provider", () => {
    const config = makeValidConfig({
      connections: [
        { id: "bad", name: "Bad", provider: "unsupported-provider", baseUrl: "", apiKey: "" },
      ],
    });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("outside wizard scope"))).toBe(true);
  });

  it("rejects missing assignments.llm", () => {
    const config = makeValidConfig();
    (config.assignments as Record<string, unknown>).llm = null;
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("assignments.llm"))).toBe(true);
  });

  it("rejects missing assignments.embeddings", () => {
    const config = makeValidConfig();
    (config.assignments as Record<string, unknown>).embeddings = null;
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("assignments.embeddings"))).toBe(true);
  });

  it("rejects assignment referencing non-existent connection", () => {
    const config = makeValidConfig();
    config.assignments.llm.connectionId = "does-not-exist";
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("does not match any connection"))).toBe(true);
  });

  it("requires discord botToken when discord channel is an enabled object", () => {
    const config = makeValidConfig({
      channels: {
        discord: { applicationId: "123456" },
      },
    });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("discord.botToken"))).toBe(true);
  });

  it("does not require discord botToken when enabled is false", () => {
    const config = makeValidConfig({
      channels: {
        discord: { enabled: false },
      },
    });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(true);
  });

  it("requires slack slackBotToken and slackAppToken when slack is an enabled object", () => {
    const config = makeValidConfig({
      channels: {
        slack: { allowedChannels: "#general" },
      },
    });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("slack.slackBotToken"))).toBe(true);
    expect(result.errors.some((e) => e.includes("slack.slackAppToken"))).toBe(true);
  });

  it("accepts slack with required tokens", () => {
    const config = makeValidConfig({
      channels: {
        slack: { slackBotToken: "xoxb-test", slackAppToken: "xapp-test" },
      },
    });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(true);
  });

  it("accepts channels as boolean values", () => {
    const config = makeValidConfig({
      channels: { chat: true, api: false },
    });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid channel value type", () => {
    const config = makeValidConfig({
      channels: { chat: "yes" as unknown as boolean },
    });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("channels.chat"))).toBe(true);
  });

  it("accepts valid owner fields", () => {
    const config = makeValidConfig({ owner: { name: "Alice", email: "alice@test.com" } });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(true);
  });

  it("rejects non-string owner.name", () => {
    const config = makeValidConfig();
    (config.owner as Record<string, unknown>).name = 42;
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("owner.name"))).toBe(true);
  });

  it("accepts valid memory section", () => {
    const config = makeValidConfig({ memory: { userId: "my_user" } });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(true);
  });

  it("rejects non-string memory.userId", () => {
    const config = makeValidConfig();
    (config.memory as Record<string, unknown>).userId = 123;
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("memory.userId"))).toBe(true);
  });

  it("rejects memory.userId with dots", () => {
    const config = makeValidConfig({ memory: { userId: "user.name" } });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("alphanumeric and underscores only"))).toBe(true);
  });

  it("rejects memory.userId with hyphens", () => {
    const config = makeValidConfig({ memory: { userId: "user-name" } });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("alphanumeric and underscores only"))).toBe(true);
  });

  it("rejects non-integer embeddingDims", () => {
    const config = makeValidConfig();
    config.assignments.embeddings.embeddingDims = 1.5;
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("embeddingDims"))).toBe(true);
  });

  it("rejects non-boolean/object service value", () => {
    const config = makeValidConfig({ services: { admin: "yes" } as unknown as Record<string, boolean> });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("services.admin"));
  });

  it("rejects service object without enabled boolean", () => {
    const config = makeValidConfig({ services: { admin: { enabled: "yes" } } as unknown as Record<string, boolean> });
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining("services.admin.enabled"));
  });
});

// ── Tests: normalizeToSetupInput ─────────────────────────────────────────

describe("normalizeToSetupInput", () => {
  it("maps all fields correctly for a full config", () => {
    const config = makeValidConfig();
    const input = normalizeToSetupInput(config);

    expect(input.adminToken).toBe("test-admin-token-12345");
    expect(input.ownerName).toBe("Test User");
    expect(input.ownerEmail).toBe("test@example.com");
    expect(input.memoryUserId).toBe("test_user");
    expect(input.ollamaEnabled).toBe(false);
    expect(input.connections).toHaveLength(1);
    expect(input.connections[0].id).toBe("openai-main");
    expect(input.assignments.llm.model).toBe("gpt-4o");
    expect(input.assignments.embeddings.model).toBe("text-embedding-3-small");
  });

  it("defaults memoryUserId when not provided", () => {
    const config = makeValidConfig({ memory: undefined });
    const input = normalizeToSetupInput(config);
    expect(input.memoryUserId).toBe("default_user");
  });

  it("maps tts string to voice.tts", () => {
    const config = makeValidConfig();
    config.assignments.tts = "kokoro";
    const input = normalizeToSetupInput(config);
    expect(input.voice?.tts).toBe("kokoro");
  });

  it("maps tts object to voice.tts using engine field", () => {
    const config = makeValidConfig();
    config.assignments.tts = { engine: "openai-tts", model: "tts-1" };
    const input = normalizeToSetupInput(config);
    expect(input.voice?.tts).toBe("openai-tts");
  });

  it("maps stt string to voice.stt", () => {
    const config = makeValidConfig();
    config.assignments.stt = "whisper-local";
    const input = normalizeToSetupInput(config);
    expect(input.voice?.stt).toBe("whisper-local");
  });

  it("maps stt object to voice.stt using engine field", () => {
    const config = makeValidConfig();
    config.assignments.stt = { engine: "openai-stt", model: "whisper-1" };
    const input = normalizeToSetupInput(config);
    expect(input.voice?.stt).toBe("openai-stt");
  });

  it("omits voice when neither tts nor stt are set", () => {
    const config = makeValidConfig();
    const input = normalizeToSetupInput(config);
    expect(input.voice).toBeUndefined();
  });

  it("handles null tts/stt values", () => {
    const config = makeValidConfig();
    config.assignments.tts = null;
    config.assignments.stt = null;
    const input = normalizeToSetupInput(config);
    expect(input.voice).toBeUndefined();
  });

  it("extracts enabled channels from boolean values", () => {
    const config = makeValidConfig({
      channels: { chat: true, api: true, discord: false },
    });
    const input = normalizeToSetupInput(config);
    expect(input.channels).toContain("chat");
    expect(input.channels).toContain("api");
    expect(input.channels).not.toContain("discord");
  });

  it("extracts enabled channels from object values", () => {
    const config = makeValidConfig({
      channels: {
        discord: { botToken: "bot-token-123", enabled: true },
        slack: { slackBotToken: "xoxb-test", slackAppToken: "xapp-test", enabled: false },
      },
    });
    const input = normalizeToSetupInput(config);
    expect(input.channels).toContain("discord");
    expect(input.channels).not.toContain("slack");
  });

  it("defaults channel enabled to true when object has no enabled field", () => {
    const config = makeValidConfig({
      channels: {
        discord: { botToken: "bot-token-123" },
      },
    });
    const input = normalizeToSetupInput(config);
    expect(input.channels).toContain("discord");
  });

  it("extracts services from boolean and object values", () => {
    const config = makeValidConfig({
      services: {
        admin: true,
        ollama: false,
        openviking: { enabled: true },
      },
    });
    const input = normalizeToSetupInput(config);
    expect(input.services?.admin).toBe(true);
    expect(input.services?.ollama).toBe(false);
    expect(input.ollamaEnabled).toBe(false);
  });

  it("sets ollamaEnabled from services.ollama", () => {
    const config = makeValidConfig({
      services: { ollama: true },
    });
    const input = normalizeToSetupInput(config);
    expect(input.ollamaEnabled).toBe(true);
  });

  it("omits channels when all channels are disabled", () => {
    const config = makeValidConfig({
      channels: { chat: false, api: false, discord: { enabled: false } },
    });
    const input = normalizeToSetupInput(config);
    expect(input.channels).toBeUndefined();
  });

  it("omits channels when none are configured", () => {
    const config = makeValidConfig({ channels: undefined });
    const input = normalizeToSetupInput(config);
    expect(input.channels).toBeUndefined();
  });

  it("omits services when none are configured", () => {
    const config = makeValidConfig({ services: undefined });
    const input = normalizeToSetupInput(config);
    expect(input.services).toBeUndefined();
  });
});

// ── Tests: buildChannelCredentialEnvVars ──────────────────────────────────

describe("buildChannelCredentialEnvVars", () => {
  it("maps discord credentials to env vars", () => {
    const envVars = buildChannelCredentialEnvVars({
      discord: {
        botToken: "bot-token-123",
        applicationId: "app-id-456",
        allowedGuilds: "guild1,guild2",
      },
    });
    expect(envVars.DISCORD_BOT_TOKEN).toBe("bot-token-123");
    expect(envVars.DISCORD_APPLICATION_ID).toBe("app-id-456");
    expect(envVars.DISCORD_ALLOWED_GUILDS).toBe("guild1,guild2");
  });

  it("maps slack credentials to env vars", () => {
    const envVars = buildChannelCredentialEnvVars({
      slack: {
        slackBotToken: "xoxb-slack-token",
        slackAppToken: "xapp-slack-token",
        allowedChannels: "#general,#random",
      },
    });
    expect(envVars.SLACK_BOT_TOKEN).toBe("xoxb-slack-token");
    expect(envVars.SLACK_APP_TOKEN).toBe("xapp-slack-token");
    expect(envVars.SLACK_ALLOWED_CHANNELS).toBe("#general,#random");
  });

  it("converts boolean values to strings", () => {
    const envVars = buildChannelCredentialEnvVars({
      discord: {
        botToken: "bot-token-123",
        registerCommands: true,
      },
    });
    expect(envVars.DISCORD_REGISTER_COMMANDS).toBe("true");
  });

  it("skips boolean-only channel entries", () => {
    const envVars = buildChannelCredentialEnvVars({
      chat: true,
      api: false,
    });
    expect(Object.keys(envVars)).toHaveLength(0);
  });

  it("skips unknown channels not in CHANNEL_CREDENTIAL_ENV_MAP", () => {
    const envVars = buildChannelCredentialEnvVars({
      "custom-channel": {
        apiKey: "custom-key",
        enabled: true,
      },
    });
    expect(Object.keys(envVars)).toHaveLength(0);
  });

  it("skips undefined and null credential values", () => {
    const envVars = buildChannelCredentialEnvVars({
      discord: {
        botToken: "bot-token-123",
        applicationId: undefined,
        allowedGuilds: undefined,
      },
    });
    expect(envVars.DISCORD_BOT_TOKEN).toBe("bot-token-123");
    expect(envVars.DISCORD_APPLICATION_ID).toBeUndefined();
    expect(envVars.DISCORD_ALLOWED_GUILDS).toBeUndefined();
  });

  it("skips empty string credential values", () => {
    const envVars = buildChannelCredentialEnvVars({
      discord: {
        botToken: "bot-token-123",
        applicationId: "",
      },
    });
    expect(envVars.DISCORD_BOT_TOKEN).toBe("bot-token-123");
    expect(envVars.DISCORD_APPLICATION_ID).toBeUndefined();
  });

  it("returns empty object for undefined channels", () => {
    const envVars = buildChannelCredentialEnvVars(undefined);
    expect(Object.keys(envVars)).toHaveLength(0);
  });

  it("handles multiple channels simultaneously", () => {
    const envVars = buildChannelCredentialEnvVars({
      discord: { botToken: "discord-bot" },
      slack: { slackBotToken: "slack-bot", slackAppToken: "slack-app" },
      chat: true,
    });
    expect(envVars.DISCORD_BOT_TOKEN).toBe("discord-bot");
    expect(envVars.SLACK_BOT_TOKEN).toBe("slack-bot");
    expect(envVars.SLACK_APP_TOKEN).toBe("slack-app");
    expect(Object.keys(envVars)).toHaveLength(3);
  });
});

// ── Tests: CHANNEL_CREDENTIAL_ENV_MAP ────────────────────────────────────

describe("CHANNEL_CREDENTIAL_ENV_MAP", () => {
  it("has discord mappings", () => {
    expect(CHANNEL_CREDENTIAL_ENV_MAP.discord).toBeDefined();
    expect(CHANNEL_CREDENTIAL_ENV_MAP.discord.botToken).toBe("DISCORD_BOT_TOKEN");
  });

  it("has slack mappings", () => {
    expect(CHANNEL_CREDENTIAL_ENV_MAP.slack).toBeDefined();
    expect(CHANNEL_CREDENTIAL_ENV_MAP.slack.slackBotToken).toBe("SLACK_BOT_TOKEN");
  });
});

// ── Tests: performSetupFromConfig ────────────────────────────────────────

describe("performSetupFromConfig", () => {
  let homeDir: string;
  let configDir: string;
  let vaultDir: string;
  let dataDir: string;
  let logsDir: string;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-setup-config-"));
    configDir = join(homeDir, "config");
    vaultDir = join(homeDir, "vault");
    dataDir = join(homeDir, "data");
    logsDir = join(homeDir, "logs");

    // Create required directory structure
    for (const dir of [
      homeDir,
      configDir,
      join(configDir, "components"),
      join(configDir, "automations"),
      join(configDir, "channels"),
      join(configDir, "connections"),
      join(configDir, "assistant"),
      join(configDir, "stash"),
      vaultDir,
      dataDir,
      join(dataDir, "admin"),
      join(dataDir, "memory"),
      join(dataDir, "assistant"),
      join(dataDir, "guardian"),
      join(dataDir, "automations"),
      join(dataDir, "opencode"),
      logsDir,
      join(logsDir, "opencode"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // Create stub stack.env so isSetupComplete doesn't crash
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(join(vaultDir, "stack", "stack.env"), "OP_SETUP_COMPLETE=false\n");

    // Seed a user.env file to avoid ensureSecrets() file-not-found
    writeFileSync(
      join(vaultDir, "user", "user.env"),
      [
        "# OpenPalm Secrets",
        "export OP_ADMIN_TOKEN=",
        "export ADMIN_TOKEN=",
        "export OPENAI_API_KEY=",
        "export OPENAI_BASE_URL=",
        "export ANTHROPIC_API_KEY=",
        "export GROQ_API_KEY=",
        "export MISTRAL_API_KEY=",
        "export GOOGLE_API_KEY=",
        "export MEMORY_USER_ID=default_user",
        "export MEMORY_AUTH_TOKEN=abc123",
        "export OWNER_NAME=",
        "export OWNER_EMAIL=",
        "",
      ].join("\n")
    );

    // Override env vars for test isolation
    savedEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = homeDir;
  });

  afterEach(() => {
    process.env.OP_HOME = savedEnv.OP_HOME;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns an error for invalid config", async () => {
    const config = makeValidConfig();
    (config as Record<string, unknown>).version = 99;
    const result = await performSetupFromConfig(config, createStubAssetProvider());
    expect(result.ok).toBe(false);
    expect(result.error).toContain("version must be 1");
  });

  it("completes setup with a valid config", async () => {
    const result = await performSetupFromConfig(makeValidConfig(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    // Verify stack.env was written with the admin credential
    const secretsContent = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(secretsContent).toContain("test-admin-token-12345");
  });

  it("writes channel credentials to user/user.env", async () => {
    const config = makeValidConfig({
      channels: {
        discord: {
          botToken: "discord-bot-token-xyz",
          applicationId: "discord-app-id-123",
        },
      },
    });
    const result = await performSetupFromConfig(config, createStubAssetProvider());
    expect(result.ok).toBe(true);

    const secretsContent = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(secretsContent).toContain("discord-bot-token-xyz");
    expect(secretsContent).toContain("discord-app-id-123");
  });

  it("writes memory config with correct models", async () => {
    const result = await performSetupFromConfig(makeValidConfig(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    const memConfigPath = join(dataDir, "memory", "default_config.json");
    expect(existsSync(memConfigPath)).toBe(true);

    const memConfig = JSON.parse(readFileSync(memConfigPath, "utf-8"));
    expect(memConfig.mem0.llm.config.model).toBe("gpt-4o");
    expect(memConfig.mem0.embedder.config.model).toBe("text-embedding-3-small");
  });

  it("creates staged artifacts", async () => {
    const result = await performSetupFromConfig(makeValidConfig(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    const stagedCompose = join(configDir, "components", "core.yml");
    expect(existsSync(stagedCompose)).toBe(true);
  });
});
