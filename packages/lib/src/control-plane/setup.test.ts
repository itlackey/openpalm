import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSetupInput,
  buildSecretsFromSetup,
  buildConnectionEnvVarMap,
  performSetup,
} from "./setup.js";
import type { SetupInput, SetupConnection } from "./setup.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";

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
    coreCompose: () => "services:\n  caddy:\n    image: caddy:latest\n",
    caddyfile: () =>
      ":80 {\n  @denied not remote_ip 127.0.0.0/8 ::1\n  respond @denied 403\n}\n",
    ollamaCompose: () => "services:\n  ollama:\n    image: ollama/ollama\n",
    agentsMd: () => "# Agents\n",
    opencodeConfig: () => '{"$schema":"https://opencode.ai/config.json"}\n',
    adminOpencodeConfig: () => '{"$schema":"https://opencode.ai/config.json","plugin":["@openpalm/admin-tools"]}\n',
    secretsSchema: () => "ADMIN_TOKEN=string\n",
    stackSchema: () => "OPENPALM_IMAGE_TAG=string\n",
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
});

// ── Tests: buildSecretsFromSetup ─────────────────────────────────────────

describe("buildSecretsFromSetup", () => {
  it("includes admin token in both keys", () => {
    const secrets = buildSecretsFromSetup(makeValidInput());
    expect(secrets.OPENPALM_ADMIN_TOKEN).toBe("test-admin-token-12345");
    expect(secrets.ADMIN_TOKEN).toBe("test-admin-token-12345");
  });

  it("sets SYSTEM_LLM_* from the LLM connection", () => {
    const secrets = buildSecretsFromSetup(makeValidInput());
    expect(secrets.SYSTEM_LLM_PROVIDER).toBe("openai");
    expect(secrets.SYSTEM_LLM_MODEL).toBe("gpt-4o");
    expect(secrets.SYSTEM_LLM_BASE_URL).toBe("https://api.openai.com");
    expect(secrets.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });

  it("sets MEMORY_USER_ID", () => {
    const secrets = buildSecretsFromSetup(makeValidInput());
    expect(secrets.MEMORY_USER_ID).toBe("test_user");
  });

  it("defaults MEMORY_USER_ID when empty", () => {
    const secrets = buildSecretsFromSetup(makeValidInput({ memoryUserId: "" }));
    expect(secrets.MEMORY_USER_ID).toBe("default_user");
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

  it("overrides Ollama base URL when ollamaEnabled is true", () => {
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
    // System LLM base URL should use in-stack Ollama URL
    expect(secrets.SYSTEM_LLM_BASE_URL).toBe("http://ollama:11434");
    expect(secrets.OPENAI_BASE_URL).toBe("http://ollama:11434/v1");
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
  let tempBase: string;
  let configDir: string;
  let dataDir: string;
  let stateDir: string;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "openpalm-setup-"));
    configDir = join(tempBase, "config");
    dataDir = join(tempBase, "data");
    stateDir = join(tempBase, "state");

    // Create required directory structure
    for (const dir of [
      configDir,
      join(configDir, "channels"),
      join(configDir, "connections"),
      join(configDir, "assistant"),
      join(configDir, "automations"),
      join(configDir, "stash"),
      dataDir,
      join(dataDir, "admin"),
      join(dataDir, "memory"),
      join(dataDir, "assistant"),
      join(dataDir, "guardian"),
      join(dataDir, "caddy"),
      join(dataDir, "caddy", "data"),
      join(dataDir, "caddy", "config"),
      join(dataDir, "automations"),
      join(dataDir, "opencode"),
      stateDir,
      join(stateDir, "artifacts"),
      join(stateDir, "audit"),
      join(stateDir, "artifacts", "channels"),
      join(stateDir, "automations"),
      join(stateDir, "opencode"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // Create stub stack.env so isSetupComplete doesn't crash
    writeFileSync(join(stateDir, "artifacts", "stack.env"), "OPENPALM_SETUP_COMPLETE=false\n");

    // Seed a secrets.env file to avoid ensureSecrets() file-not-found
    writeFileSync(
      join(configDir, "secrets.env"),
      [
        "# OpenPalm Secrets",
        "export OPENPALM_ADMIN_TOKEN=",
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
    savedEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
    savedEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    savedEnv.OPENPALM_STATE_HOME = process.env.OPENPALM_STATE_HOME;
    process.env.OPENPALM_CONFIG_HOME = configDir;
    process.env.OPENPALM_DATA_HOME = dataDir;
    process.env.OPENPALM_STATE_HOME = stateDir;
  });

  afterEach(() => {
    process.env.OPENPALM_CONFIG_HOME = savedEnv.OPENPALM_CONFIG_HOME;
    process.env.OPENPALM_DATA_HOME = savedEnv.OPENPALM_DATA_HOME;
    process.env.OPENPALM_STATE_HOME = savedEnv.OPENPALM_STATE_HOME;
    rmSync(tempBase, { recursive: true, force: true });
  });

  it("returns an error for invalid input", async () => {
    const result = await performSetup(
      { adminToken: "short" } as SetupInput,
      createStubAssetProvider()
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("writes secrets.env with the admin token", async () => {
    const result = await performSetup(makeValidInput(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    const secretsContent = readFileSync(join(configDir, "secrets.env"), "utf-8");
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

  it("writes connection profiles document", async () => {
    const result = await performSetup(makeValidInput(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    const profilesPath = join(configDir, "connections", "profiles.json");
    expect(existsSync(profilesPath)).toBe(true);

    const doc = JSON.parse(readFileSync(profilesPath, "utf-8"));
    expect(doc.version).toBe(1);
    expect(doc.profiles).toHaveLength(1);
    expect(doc.profiles[0].id).toBe("openai-main");
    expect(doc.assignments.llm.model).toBe("gpt-4o");
    expect(doc.assignments.embeddings.model).toBe("text-embedding-3-small");
  });

  it("creates staged artifacts directory", async () => {
    const result = await performSetup(makeValidInput(), createStubAssetProvider());
    expect(result.ok).toBe(true);

    // applyInstall should have staged the compose file
    const stagedCompose = join(stateDir, "artifacts", "docker-compose.yml");
    expect(existsSync(stagedCompose)).toBe(true);
  });

  it("uses Ollama in-stack URL when ollamaEnabled is true", async () => {
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

    // Connection profiles should use the in-stack URL
    const profilesPath = join(configDir, "connections", "profiles.json");
    const doc = JSON.parse(readFileSync(profilesPath, "utf-8"));
    expect(doc.profiles[0].baseUrl).toBe("http://ollama:11434");
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
});
