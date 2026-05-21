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

// ── Helpers ──────────────────────────────────────────────────────────────

function makeValidSpec(overrides?: Partial<SetupSpec>): SetupSpec {
  return {
    version: 2,
    llm: { provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com/v1" },
    embedding: { provider: "openai", model: "text-embedding-3-small", dims: 1536, baseUrl: "https://api.openai.com/v1" },
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
  mkdirSync(join(homeDir, "config", "stack"), { recursive: true });
  writeFileSync(join(homeDir, "config", "stack", "core.compose.yml"), "services:\n  assistant:\n    image: assistant:latest\n");
  mkdirSync(join(homeDir, "state", "assistant"), { recursive: true });
  writeFileSync(join(homeDir, "state", "assistant", "opencode.jsonc"), '{"$schema":"https://opencode.ai/config.json"}\n');
  writeFileSync(join(homeDir, "state", "assistant", "AGENTS.md"), "# Agents\n");
  mkdirSync(join(homeDir, "state"), { recursive: true });
  // Automations live in state/registry/automations (shipped catalog) and stash/tasks (user tasks)
  mkdirSync(join(homeDir, "state", "registry", "automations"), { recursive: true });
  writeFileSync(join(homeDir, "state", "registry", "automations", "cleanup-logs.md"), "---\nschedule: \"0 4 * * 0\"\ndescription: cleanup logs\n---\n");
  writeFileSync(join(homeDir, "state", "registry", "automations", "cleanup-data.md"), "---\nschedule: \"0 5 * * 0\"\ndescription: cleanup data\n---\n");
  writeFileSync(join(homeDir, "state", "registry", "automations", "validate-config.md"), "---\nschedule: \"0 3 * * *\"\ndescription: validate config\n---\n");
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
  it("does not include admin token in user secrets", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OP_UI_TOKEN).toBeUndefined();
    expect(secrets.ADMIN_TOKEN).toBeUndefined();
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
    expect(secrets.OWNER_NAME).toBe("Test User");
    expect(secrets.OWNER_EMAIL).toBe("test@example.com");
  });

  it("omits owner info when empty", () => {
    const spec = makeValidSpec({ owner: { name: "", email: "" } });
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    expect(secrets.OWNER_NAME).toBeUndefined();
    expect(secrets.OWNER_EMAIL).toBeUndefined();
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
  it("includes distinct admin and assistant credentials", () => {
    const secrets = buildSystemSecretsFromSetup("test-admin-token-12345");
    expect(secrets.OP_UI_TOKEN).toBe("test-admin-token-12345");
    expect(typeof secrets.OP_ASSISTANT_TOKEN).toBe("string");
    expect(secrets.OP_ASSISTANT_TOKEN).not.toBe("test-admin-token-12345");
  });
});

// ── Tests: performSetup ──────────────────────────────────────────────────

describe("performSetup", () => {
  let homeDir: string;
  let configDir: string;
  let stateDir: string;
  let stackDir: string;

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-setup-"));
    configDir = join(homeDir, "config");
    stateDir = join(homeDir, "state");
    stackDir = join(configDir, "stack");

    // Create required directory structure
    for (const dir of [
      homeDir,
      configDir,
      join(homeDir, "state", "registry", "automations"),
      join(configDir, "assistant"),
      join(configDir, "akm"),
      stackDir,
      join(stackDir, "addons"),
      join(homeDir, "stash"),
      join(homeDir, "workspace"),
      join(homeDir, "cache"),
      join(homeDir, "cache", "akm"),
      stateDir,
      join(stateDir, "assistant"),
      join(stateDir, "admin"),
      join(stateDir, "guardian"),
      join(stateDir, "logs"),
      join(stateDir, "logs", "opencode"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // Create stub stack.env so isSetupComplete doesn't crash
    writeFileSync(
      join(stackDir, "stack.env"),
      [
        "OP_SETUP_COMPLETE=false",
        "OP_UI_TOKEN=",
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

    const secretsContent = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(secretsContent).toContain("test-admin-token-12345");
  });

  it("writes akm config.json with llm and embedding", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    const akmConfigPath = join(homeDir, "config", "akm", "config.json");
    expect(existsSync(akmConfigPath)).toBe(true);
    const config = JSON.parse(readFileSync(akmConfigPath, "utf-8"));
    expect(config.llm.model).toBe("gpt-4o");
    expect(config.llm.provider).toBe("openai");
    expect(config.embedding.model).toBe("text-embedding-3-small");
    expect(config.embedding.provider).toBe("openai");
    expect(config.embedding.dimension).toBe(1536);
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
    expect(config.llm.provider).toBe("ollama");
    expect(config.llm.model).toBe("llama3.2");
    expect(config.embedding.dimension).toBe(768);
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
  });

  it("writes channel credentials to stack.env when channelCredentials provided", async () => {
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

    const stackEnvContent = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(stackEnvContent).toContain("discord-bot-token-xyz");
    expect(stackEnvContent).toContain("discord-app-id-123");
  });
});
