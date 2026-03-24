import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSetupSpec,
  buildSecretsFromSetup,
  buildSystemSecretsFromSetup,
  performSetup,
} from "./setup.js";
import type { SetupSpec, SetupConnection } from "./setup.js";
import { STACK_SPEC_FILENAME, readStackSpec } from "./stack-spec.js";
import type { StackSpec } from "./stack-spec.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeValidSpec(overrides?: Partial<SetupSpec>): SetupSpec {
  return {
    spec: {
      version: 2,
      capabilities: {
        llm: "openai/gpt-4o",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          dims: 1536,
        },
        memory: {
          userId: "test_user",
          customInstructions: "",
        },
      },
      addons: {},
    },
    security: { adminToken: "test-admin-token-12345" },
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
  mkdirSync(join(homeDir, "stack"), { recursive: true });
  writeFileSync(join(homeDir, "stack", "core.compose.yml"), "services:\n  assistant:\n    image: assistant:latest\n");
  mkdirSync(join(homeDir, "data", "assistant"), { recursive: true });
  writeFileSync(join(homeDir, "data", "assistant", "opencode.jsonc"), '{"$schema":"https://opencode.ai/config.json"}\n');
  writeFileSync(join(homeDir, "data", "assistant", "AGENTS.md"), "# Agents\n");
  mkdirSync(join(homeDir, "vault", "user"), { recursive: true });
  writeFileSync(join(homeDir, "vault", "user", "user.env.schema"), "ADMIN_TOKEN=string\n");
  mkdirSync(join(homeDir, "vault", "stack"), { recursive: true });
  writeFileSync(join(homeDir, "vault", "stack", "stack.env.schema"), "OP_IMAGE_TAG=string\n");
  mkdirSync(join(homeDir, "config", "automations"), { recursive: true });
  writeFileSync(join(homeDir, "config", "automations", "cleanup-logs.yml"), "name: cleanup-logs\nschedule: daily\n");
  writeFileSync(join(homeDir, "config", "automations", "cleanup-data.yml"), "name: cleanup-data\nschedule: weekly\n");
  writeFileSync(join(homeDir, "config", "automations", "validate-config.yml"), "name: validate-config\nschedule: hourly\n");
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

  it("rejects missing security.adminToken", () => {
    const spec = makeValidSpec();
    spec.security.adminToken = "";
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("security.adminToken"))).toBe(true);
  });

  it("rejects short security.adminToken", () => {
    const spec = makeValidSpec();
    spec.security.adminToken = "short";
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

  it("rejects missing spec object", () => {
    const input = makeValidSpec();
    (input as Record<string, unknown>).spec = null;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("spec object is required"))).toBe(true);
  });

  it("rejects wrong spec version", () => {
    const input = makeValidSpec();
    (input.spec as Record<string, unknown>).version = 1;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("spec.version must be 2"))).toBe(true);
  });

  it("rejects missing capabilities.llm", () => {
    const input = makeValidSpec();
    (input.spec.capabilities as Record<string, unknown>).llm = "";
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("spec.capabilities.llm"))).toBe(true);
  });

  it("rejects missing capabilities.embeddings", () => {
    const input = makeValidSpec();
    (input.spec.capabilities as Record<string, unknown>).embeddings = null;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("spec.capabilities.embeddings"))).toBe(true);
  });

  it("rejects missing capabilities.memory", () => {
    const input = makeValidSpec();
    (input.spec.capabilities as Record<string, unknown>).memory = null;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("spec.capabilities.memory"))).toBe(true);
  });

  it("rejects non-integer embeddings.dims", () => {
    const input = makeValidSpec();
    input.spec.capabilities.embeddings.dims = 1.5;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("dims must be a positive integer"))).toBe(true);  // or 0 (auto-resolve)
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

  it("rejects memory.userId with dots", () => {
    const input = makeValidSpec();
    input.spec.capabilities.memory.userId = "user.name";
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("alphanumeric and underscores only"))).toBe(true);
  });

  it("rejects memory.userId with hyphens", () => {
    const input = makeValidSpec();
    input.spec.capabilities.memory.userId = "user-name";
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("alphanumeric and underscores only"))).toBe(true);
  });

  it("accepts memory.userId with underscores", () => {
    const input = makeValidSpec();
    input.spec.capabilities.memory.userId = "user_name_123";
    const result = validateSetupSpec(input);
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

  it("accepts valid memory section", () => {
    const spec = makeValidSpec();
    spec.spec.capabilities.memory.userId = "my_user";
    const result = validateSetupSpec(spec);
    expect(result.valid).toBe(true);
  });
});

// ── Tests: buildSecretsFromSetup ─────────────────────────────────────────

describe("buildSecretsFromSetup", () => {
  it("does not include admin token in user secrets", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OP_ADMIN_TOKEN).toBeUndefined();
    expect(secrets.ADMIN_TOKEN).toBeUndefined();
  });

  it("does not include SYSTEM_LLM_* in user secrets (now in capabilities)", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.SYSTEM_LLM_PROVIDER).toBeUndefined();
    expect(secrets.SYSTEM_LLM_MODEL).toBeUndefined();
    expect(secrets.SYSTEM_LLM_BASE_URL).toBeUndefined();
    expect(secrets.OPENAI_BASE_URL).toBeUndefined();
  });

  it("does not include MEMORY_USER_ID in user secrets (now in capabilities)", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.MEMORY_USER_ID).toBeUndefined();
  });

  it("sets owner info when provided", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OWNER_NAME).toBe("Test User");
    expect(secrets.OWNER_EMAIL).toBe("test@example.com");
  });

  it("omits owner info when empty", () => {
    const spec = makeValidSpec({ owner: { name: "", email: "" } });
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OWNER_NAME).toBeUndefined();
    expect(secrets.OWNER_EMAIL).toBeUndefined();
  });

  it("maps API key to correct env var", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OPENAI_API_KEY).toBe("sk-test-key-123");
  });

  it("does not include Ollama base URL in user secrets when ollamaEnabled (now in capabilities)", () => {
    const connections: SetupConnection[] = [
      { id: "ollama-1", name: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "" },
    ];
    const secrets = buildSecretsFromSetup(connections);
    // These are no longer written to user.env — they live in capabilities/managed.env
    expect(secrets.SYSTEM_LLM_BASE_URL).toBeUndefined();
    expect(secrets.OPENAI_BASE_URL).toBeUndefined();
  });
});

describe("buildSystemSecretsFromSetup", () => {
  it("includes distinct admin and assistant credentials", () => {
    const secrets = buildSystemSecretsFromSetup("test-admin-token-12345");
    expect(secrets.OP_ADMIN_TOKEN).toBe("test-admin-token-12345");
    expect(typeof secrets.OP_ASSISTANT_TOKEN).toBe("string");
    expect(secrets.OP_ASSISTANT_TOKEN).not.toBe("test-admin-token-12345");
    expect(typeof secrets.OP_MEMORY_TOKEN).toBe("string");
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
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      [
        "OP_SETUP_COMPLETE=false",
        "OP_ADMIN_TOKEN=",
        "OPENAI_API_KEY=",
        "OPENAI_BASE_URL=",
        "ANTHROPIC_API_KEY=",
        "GROQ_API_KEY=",
        "MISTRAL_API_KEY=",
        "GOOGLE_API_KEY=",
        "OWNER_NAME=",
        "OWNER_EMAIL=",
        "",
      ].join("\n")
    );

    // Seed a user.env placeholder
    writeFileSync(
      join(vaultDir, "user", "user.env"),
      [
        "# OpenPalm — User Extensions",
        "# Add any custom environment variables here.",
        "# These are loaded by compose alongside stack.env.",
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
      { security: { adminToken: "short" } } as SetupSpec
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("writes stack.env with the admin token", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    const secretsContent = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(secretsContent).toContain("test-admin-token-12345");
  });

  it("writes OP_CAP_* vars to stack.env for capabilities", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    const stackEnvContent = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(stackEnvContent).toContain("OP_CAP_LLM_MODEL=gpt-4o");
    expect(stackEnvContent).toContain("OP_CAP_EMBEDDINGS_MODEL=text-embedding-3-small");
  });

  it("writes capabilities to stack.yaml v2", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.capabilities.llm).toBe("openai/gpt-4o");
    expect(spec!.capabilities.embeddings.model).toBe("text-embedding-3-small");
    expect(spec!.capabilities.embeddings.provider).toBe("openai");
  });

  it("writes core compose file to stack/", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    // applyInstall should have written the compose file to stack/ (not config/components/)
    const stagedCompose = join(homeDir, "stack", "core.compose.yml");
    expect(existsSync(stagedCompose)).toBe(true);
  });

  it("writes ollama addon when ollama is in spec.addons", async () => {
    const input = makeValidSpec({
      spec: {
        version: 2,
        capabilities: {
          llm: "ollama/llama3.2",
          embeddings: {
            provider: "ollama",
            model: "nomic-embed-text",
            dims: 768,
          },
          memory: {
            userId: "test_user",
            customInstructions: "",
          },
        },
        addons: { ollama: true },
      },
      connections: [
        {
          id: "ollama-local",
          name: "Ollama",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "",
        },
      ],
    });

    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    // v2 spec should have ollama addon enabled and correct capabilities
    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.addons.ollama).toBe(true);
    expect(spec!.capabilities.llm).toBe("ollama/llama3.2");
  });

  it("resolves embedding dims from EMBEDDING_DIMS lookup", async () => {
    const input = makeValidSpec({
      spec: {
        version: 2,
        capabilities: {
          llm: "ollama/llama3.2",
          embeddings: {
            provider: "ollama",
            model: "nomic-embed-text",
            dims: 0, // Should be resolved from lookup
          },
          memory: {
            userId: "test_user",
            customInstructions: "",
          },
        },
        addons: {},
      },
      connections: [
        {
          id: "ollama-local",
          name: "Ollama",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "",
        },
      ],
    });

    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    // nomic-embed-text is 768 dims per EMBEDDING_DIMS — verify via stack.env OP_CAP_EMBEDDINGS_DIMS
    const stackEnvContent = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(stackEnvContent).toContain("OP_CAP_EMBEDDINGS_DIMS=768");
  });

  it("writes stack.yaml with correct v2 structure", async () => {
    const result = await performSetup(makeValidSpec());
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
    const input = makeValidSpec({
      connections: [
        { id: "openai_primary", name: "OpenAI Primary", provider: "openai", baseUrl: "https://api.openai.com", apiKey: "sk-primary" },
        { id: "openai-secondary", name: "OpenAI Secondary", provider: "openai", baseUrl: "https://api.openai.com", apiKey: "sk-secondary" },
      ],
    });

    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    // v2 spec should still have correct capabilities
    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.capabilities.llm).toBe("openai/gpt-4o");
  });

  it("writes channel credentials to stack.env when channelCredentials provided", async () => {
    const input = makeValidSpec({
      channelCredentials: {
        discord: {
          botToken: "discord-bot-token-xyz",
          applicationId: "discord-app-id-123",
        },
      },
      spec: {
        version: 2,
        capabilities: {
          llm: "openai/gpt-4o",
          embeddings: {
            provider: "openai",
            model: "text-embedding-3-small",
            dims: 1536,
          },
          memory: {
            userId: "test_user",
            customInstructions: "",
          },
        },
        addons: { discord: true },
      },
    });

    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    const stackEnvContent = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(stackEnvContent).toContain("discord-bot-token-xyz");
    expect(stackEnvContent).toContain("discord-app-id-123");
  });
});

