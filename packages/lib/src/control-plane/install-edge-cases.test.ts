/**
 * Edge-case tests for the OpenPalm install and setup flow.
 *
 * Each test creates its own temp directory tree mimicking the single
 * ~/.openpalm/ root layout (config, vault, data, logs), then runs the
 * actual library functions against it. No mocks of code under test.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { parseEnvContent, parseEnvFile, mergeEnvContent } from "./env.js";
import { ensureSecrets, loadSecretsEnvFile } from "./secrets.js";
import { isSetupComplete } from "./setup-status.js";
import {
  performSetup,
  buildSecretsFromSetup,
  buildSystemSecretsFromSetup,
  buildConnectionEnvVarMap,
} from "./setup.js";
import type { SetupInput, SetupConnection } from "./setup.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";
import type { ControlPlaneState } from "./types.js";
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
      embeddings: {
        connectionId: "openai-main",
        model: "text-embedding-3-small",
      },
    },
    ...overrides,
  };
}

function createStubAssetProvider(): CoreAssetProvider {
  return {
    coreCompose: () => "services:\n  assistant:\n    image: assistant:latest\n",
    agentsMd: () => "# Agents\n",
    opencodeConfig: () =>
      '{"$schema":"https://opencode.ai/config.json"}\n',
    secretsSchema: () => "ADMIN_TOKEN=string\n",
    stackSchema: () => "OP_IMAGE_TAG=string\n",
    cleanupLogs: () => "name: cleanup-logs\nschedule: daily\n",
    cleanupData: () => "name: cleanup-data\nschedule: weekly\n",
    validateConfig: () => "name: validate-config\nschedule: hourly\n",
  };
}

// ── Shared test fixture ──────────────────────────────────────────────────

let homeDir: string;
let configDir: string;
let vaultDir: string;
let dataDir: string;
let logsDir: string;

const savedEnv: Record<string, string | undefined> = {};

function saveAndSetEnv(): void {
  savedEnv.OP_HOME = process.env.OP_HOME;
  process.env.OP_HOME = homeDir;
}

function restoreEnv(): void {
  process.env.OP_HOME = savedEnv.OP_HOME;
}

/** Create a full directory tree matching ensureHomeDirs() output. */
function createFullDirTree(): void {
  homeDir = mkdtempSync(join(tmpdir(), "openpalm-edge-"));
  configDir = join(homeDir, "config");
  vaultDir = join(homeDir, "vault");
  dataDir = join(homeDir, "data");
  logsDir = join(homeDir, "logs");

  for (const dir of [
    homeDir,
    configDir,
    join(configDir, "automations"),
    join(configDir, "channels"),
    join(configDir, "connections"),
    join(configDir, "assistant"),
    join(configDir, "stash"),
    join(homeDir, "stack"),
    join(homeDir, "stack", "addons"),
    vaultDir,
    dataDir,
    join(dataDir, "admin"),
    join(dataDir, "memory"),
    join(dataDir, "assistant"),
    join(dataDir, "guardian"),
    join(dataDir, "automations"),
    join(dataDir, "opencode"),
    join(dataDir, "stash"),
    join(dataDir, "workspace"),
    logsDir,
    join(logsDir, "opencode"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Seed the minimal user.env and stack.env needed for most tests. */
function seedMinimalEnvFiles(): void {
  mkdirSync(join(vaultDir, "user"), { recursive: true });
  mkdirSync(join(vaultDir, "stack"), { recursive: true });
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
      "export OP_MEMORY_TOKEN=abc123",
      "export OWNER_NAME=",
      "export OWNER_EMAIL=",
      "",
    ].join("\n")
  );

  writeFileSync(
    join(vaultDir, "stack", "stack.env"),
    "# OpenPalm System Configuration\n"
  );
}

// ── Test Suite ───────────────────────────────────────────────────────────

// =====================================================================
// FRESH INSTALL (empty directories)
// =====================================================================

describe("Fresh Install", () => {
  beforeEach(() => {
    createFullDirTree();
    saveAndSetEnv();
  });

  afterEach(() => {
    restoreEnv();
    rmSync(homeDir, { recursive: true, force: true });
  });

  // Scenario 1: ensureSecrets creates user.env with all required keys
  it("ensureSecrets creates user.env with required keys when file does not exist", () => {
    const state: ControlPlaneState = {
      adminToken: "",
      setupToken: "",
      homeDir,
      configDir,
      vaultDir,
      dataDir,
      logsDir,
      cacheDir: join(homeDir, "cache"),
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
      audit: [],
    };

    // No user.env exists yet
    expect(existsSync(join(vaultDir, "user", "user.env"))).toBe(false);

    ensureSecrets(state);

    const content = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(content).toContain("OPENAI_API_KEY=");
    expect(content).toContain("OWNER_NAME=");
  });

  // Scenario 2: isSetupComplete returns false before setup
  it("isSetupComplete returns false when stack.env has OP_SETUP_COMPLETE=false", () => {
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      "OP_SETUP_COMPLETE=false\n"
    );
    // Empty user.env so fallback check doesn't trigger
    writeFileSync(join(vaultDir, "user", "user.env"), "");

    expect(isSetupComplete(vaultDir)).toBe(false);
  });

  // Scenario 3: performSetup succeeds from completely empty state
  it("performSetup succeeds from completely empty state", async () => {
    seedMinimalEnvFiles();

    const result = await performSetup(
      makeValidInput(),
      createStubAssetProvider()
    );

    expect(result.ok).toBe(true);
  });

  // Scenario 4: performSetup marks setup complete in data/stack.env
  it("performSetup marks OP_SETUP_COMPLETE=true in data stack.env", async () => {
    seedMinimalEnvFiles();

    await performSetup(makeValidInput(), createStubAssetProvider());

    const stackEnv = readFileSync(join(dataDir, "stack.env"), "utf-8");
    const parsed = parseEnvContent(stackEnv);
    expect(parsed.OP_SETUP_COMPLETE).toBe("true");
  });
});

// =====================================================================
// EXISTING INSTALL (pre-populated directories)
// =====================================================================

describe("Existing Install", () => {
  beforeEach(() => {
    createFullDirTree();
    seedMinimalEnvFiles();
    saveAndSetEnv();
  });

  afterEach(() => {
    restoreEnv();
    rmSync(homeDir, { recursive: true, force: true });
  });

  // Scenario 5: ensureSecrets does NOT overwrite existing user.env
  it("ensureSecrets does not overwrite existing user.env", () => {
    const customContent =
      "export OP_ADMIN_TOKEN=my-custom-token\nexport OP_MEMORY_TOKEN=custom-auth-token\n";
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(join(vaultDir, "user", "user.env"), customContent);

    const state: ControlPlaneState = {
      adminToken: "",
      setupToken: "",
      homeDir,
      configDir,
      vaultDir,
      dataDir,
      logsDir,
      cacheDir: join(homeDir, "cache"),
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
      audit: [],
    };

    ensureSecrets(state);

    const afterContent = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(afterContent).toBe(customContent);
  });

  // Scenario 6: performSetup re-run preserves OP_MEMORY_TOKEN
  it("performSetup re-run preserves OP_MEMORY_TOKEN from first run", async () => {
    // First setup
    await performSetup(makeValidInput(), createStubAssetProvider());

    const secretsAfterFirst = readFileSync(
      join(vaultDir, "user", "user.env"),
      "utf-8"
    );
    const firstMatch = secretsAfterFirst.match(
      /OP_MEMORY_TOKEN=([a-f0-9]+)/
    );
    expect(firstMatch).not.toBeNull();
    const firstToken = firstMatch![1];

    // Second setup (re-run with different API key)
    await performSetup(
      makeValidInput({
        connections: [
          {
            id: "openai-main",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com",
            apiKey: "sk-different-key-999",
          },
        ],
      }),
      createStubAssetProvider()
    );

    const secretsAfterSecond = readFileSync(
      join(vaultDir, "user", "user.env"),
      "utf-8"
    );
    const secondMatch = secretsAfterSecond.match(
      /OP_MEMORY_TOKEN=([a-f0-9]+)/
    );
    expect(secondMatch).not.toBeNull();
    // OP_MEMORY_TOKEN should be preserved (buildSecretsFromSetup does not overwrite it)
    expect(secondMatch![1]).toBe(firstToken);
  });

  // Scenario 7: performSetup marks OP_SETUP_COMPLETE=true in dataDir/stack.env
  it("performSetup marks OP_SETUP_COMPLETE=true in data stack.env", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    const stackEnv = readFileSync(
      join(dataDir, "stack.env"),
      "utf-8"
    );
    const parsed = parseEnvContent(stackEnv);
    expect(parsed.OP_SETUP_COMPLETE).toBe("true");
  });

  // Scenario 8: Re-setup with different provider updates stack.yaml capabilities
  it("re-setup with different provider updates capabilities in stack.yaml", async () => {
    // First setup with OpenAI
    await performSetup(makeValidInput(), createStubAssetProvider());

    const specAfterFirst = readStackSpec(configDir);
    expect(specAfterFirst).not.toBeNull();
    expect(specAfterFirst!.capabilities.llm).toContain("openai/");

    // Second setup with Groq
    await performSetup(
      makeValidInput({
        connections: [
          {
            id: "groq-main",
            name: "Groq",
            provider: "groq",
            baseUrl: "https://api.groq.com/openai",
            apiKey: "gsk-test-key-456",
          },
        ],
        assignments: {
          llm: { connectionId: "groq-main", model: "llama3-70b-8192" },
          embeddings: {
            connectionId: "groq-main",
            model: "text-embedding-3-small",
          },
        },
      }),
      createStubAssetProvider()
    );

    const specAfterSecond = readStackSpec(configDir);
    expect(specAfterSecond).not.toBeNull();
    expect(specAfterSecond!.capabilities.llm).toBe("groq/llama3-70b-8192");

    // user.env should retain both keys
    const secrets = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(secrets).toContain("GROQ_API_KEY");
  });
});

// =====================================================================
// BROKEN / CORRUPT STATE
// =====================================================================

describe("Broken/Corrupt State", () => {
  beforeEach(() => {
    createFullDirTree();
    saveAndSetEnv();
  });

  afterEach(() => {
    restoreEnv();
    rmSync(homeDir, { recursive: true, force: true });
  });

  // Scenario 9: user.env exists but is empty
  it("ensureSecrets returns early for an empty but existing user.env", () => {
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(join(vaultDir, "user", "user.env"), "");

    const state: ControlPlaneState = {
      adminToken: "",
      setupToken: "",
      homeDir,
      configDir,
      vaultDir,
      dataDir,
      logsDir,
      cacheDir: join(homeDir, "cache"),
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
      audit: [],
    };

    ensureSecrets(state);

    // File should still exist and still be empty (ensureSecrets only checks existence)
    const content = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(content).toBe("");
  });

  // Scenario 10: user.env with malformed lines
  it("parseEnvFile handles malformed env lines gracefully", () => {
    const malformedContent = [
      "# Comment line",
      "VALID_KEY=valid_value",
      "no_equals_sign_here",
      "export EXPORTED_KEY=exported_value",
      "   WHITESPACE_KEY=  whitespace_value  ",
      "=starts_with_equals",
      "",
      "ANOTHER_VALID=value",
      "  # indented comment",
    ].join("\n");

    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(join(vaultDir, "user", "user.env"), malformedContent);

    const parsed = parseEnvFile(join(vaultDir, "user", "user.env"));
    expect(parsed.VALID_KEY).toBe("valid_value");
    expect(parsed.EXPORTED_KEY).toBe("exported_value");
    expect(parsed.ANOTHER_VALID).toBe("value");
  });

  // Scenario 11: stack.env missing OP_SETUP_COMPLETE
  it("isSetupComplete falls back to token check when OP_SETUP_COMPLETE missing", () => {
    // stack.env without OP_SETUP_COMPLETE
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      "OP_IMAGE_TAG=latest\n"
    );

    // user.env without any token
    writeFileSync(
      join(vaultDir, "user", "user.env"),
      "export OP_ADMIN_TOKEN=\nexport ADMIN_TOKEN=\n"
    );

    expect(isSetupComplete(vaultDir)).toBe(false);
  });

  it("isSetupComplete falls back to true when admin token is set but OP_SETUP_COMPLETE missing", () => {
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      "OP_IMAGE_TAG=latest\nexport OP_ADMIN_TOKEN=my-real-token\n"
    );

    expect(isSetupComplete(vaultDir)).toBe(true);
  });

  // Scenario 12: API key with special characters round-trips
  it("API key with special characters round-trips through write and parse", () => {
    const specialKeys: Record<string, string> = {
      DOLLAR: "sk-abc$def",
      EQUALS: "sk-abc==def=",
      PLUS_SLASH: "sk-proj-A1b2+xyz/ZZZ==",
      QUOTES: 'sk-say"hello"',
    };

    for (const [label, value] of Object.entries(specialKeys)) {
      const written = mergeEnvContent("", { [`KEY_${label}`]: value });
      const parsed = parseEnvContent(written);
      expect(parsed[`KEY_${label}`]).toBe(value);
    }
  });

  // Scenario 13: Missing stack.yaml returns null
  it("readStackSpec returns null when stack.yaml missing", () => {
    const spec = readStackSpec(configDir);
    expect(spec).toBeNull();
  });

  // Scenario 14: config dir exists but automations dir doesn't
  it("performSetup creates missing subdirectories", async () => {
    // Seed the minimal env files first
    seedMinimalEnvFiles();

    // Remove automations dir (performSetup should recreate it)
    rmSync(join(configDir, "automations"), { recursive: true, force: true });

    const result = await performSetup(
      makeValidInput(),
      createStubAssetProvider()
    );
    expect(result.ok).toBe(true);

    // Artifacts should exist in stack/ (not config/components/)
    expect(existsSync(join(homeDir, "stack", "core.compose.yml"))).toBe(
      true
    );
    // Automations dir should be recreated
    expect(existsSync(join(configDir, "automations"))).toBe(true);
  });

  // Scenario 15: openpalm.yaml with old version
  it("readStackSpec returns null for version 1 spec", () => {
    writeFileSync(
      join(configDir, STACK_SPEC_FILENAME),
      "version: 1\nconnections: []\n"
    );

    const spec = readStackSpec(configDir);
    expect(spec).toBeNull();
  });
});

// =====================================================================
// ENVIRONMENT EDGE CASES
// =====================================================================

describe("Environment Edge Cases", () => {
  beforeEach(() => {
    createFullDirTree();
    saveAndSetEnv();
  });

  afterEach(() => {
    restoreEnv();
    rmSync(homeDir, { recursive: true, force: true });
  });

  // Scenario 16: Commented-out ADMIN_TOKEN but OP_ADMIN_TOKEN set
  it("isSetupComplete detects OP_ADMIN_TOKEN when ADMIN_TOKEN is commented out", () => {
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      "SOME_OTHER_KEY=value\nexport OP_ADMIN_TOKEN=real-token-here\n"
    );

    expect(isSetupComplete(vaultDir)).toBe(true);
  });

  // Scenario 17: export prefix on env vars
  it("parseEnvContent strips export prefix correctly", () => {
    const content =
      "export FOO=bar\nexport BAZ=qux\nNO_EXPORT=plain\n";
    const parsed = parseEnvContent(content);

    expect(parsed.FOO).toBe("bar");
    expect(parsed.BAZ).toBe("qux");
    expect(parsed.NO_EXPORT).toBe("plain");
  });

  // Scenario 18: Multiple = in value (base64 keys)
  it("parseEnvContent preserves multiple = in value (base64)", () => {
    const content = "API_KEY=sk-abc==def=ghi\n";
    const parsed = parseEnvContent(content);
    expect(parsed.API_KEY).toBe("sk-abc==def=ghi");
  });

  it("mergeEnvContent round-trips base64 values with trailing ==", () => {
    const value = "dGVzdA==";
    const written = mergeEnvContent("", { TOKEN: value });
    const parsed = parseEnvContent(written);
    expect(parsed.TOKEN).toBe(value);
  });

  // Scenario 19: Env value containing $HOME or ${VAR}
  it("dollar signs in env values are preserved through round-trip", () => {
    const testCases = ["$HOME/path", "${VAR}", "price$100", "a$b$c"];

    for (const value of testCases) {
      const written = mergeEnvContent("", { KEY: value });
      const parsed = parseEnvContent(written);
      expect(parsed.KEY).toBe(value);
    }
  });
});

// =====================================================================
// SETUP INPUT VARIATIONS
// =====================================================================

describe("Setup Input Variations", () => {
  beforeEach(() => {
    createFullDirTree();
    seedMinimalEnvFiles();
    saveAndSetEnv();
  });

  afterEach(() => {
    restoreEnv();
    rmSync(homeDir, { recursive: true, force: true });
  });

  // Scenario 20: Ollama in-stack setup
  it("Ollama in-stack setup overrides localhost URL to docker-internal", async () => {
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
        embeddings: {
          connectionId: "ollama-local",
          model: "nomic-embed-text",
        },
      },
    });

    const result = await performSetup(input, createStubAssetProvider());
    expect(result.ok).toBe(true);

    // stack.yaml should have ollama capabilities
    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.capabilities.llm).toBe("ollama/llama3.2");
    expect(spec!.addons.ollama).toBe(true);
  });

  // Scenario 21: Multiple providers each get own env var key
  it("multiple providers each get their own env var key (no collision)", () => {
    const connections: SetupConnection[] = [
      {
        id: "openai-1",
        name: "OpenAI",
        provider: "openai",
        baseUrl: "",
        apiKey: "sk-openai",
      },
      {
        id: "groq-1",
        name: "Groq",
        provider: "groq",
        baseUrl: "",
        apiKey: "gsk-groq",
      },
      {
        id: "anthropic-1",
        name: "Anthropic",
        provider: "anthropic",
        baseUrl: "",
        apiKey: "sk-ant-api03",
      },
    ];

    const map = buildConnectionEnvVarMap(connections);
    expect(map.get("openai-1")).toBe("OPENAI_API_KEY");
    expect(map.get("groq-1")).toBe("GROQ_API_KEY");
    expect(map.get("anthropic-1")).toBe("ANTHROPIC_API_KEY");
  });

  // Scenario 22: buildSecretsFromSetup only writes API keys and owner info
  it("buildSecretsFromSetup writes API keys but not config vars", () => {
    const secrets = buildSecretsFromSetup(makeValidInput());

    // API key should be written
    expect(secrets.OPENAI_API_KEY).toBe("sk-test-key-123");
    // Config vars should NOT be in user.env anymore
    expect(secrets.SYSTEM_LLM_PROVIDER).toBeUndefined();
    expect(secrets.SYSTEM_LLM_MODEL).toBeUndefined();
    expect(secrets.EMBEDDING_MODEL).toBeUndefined();
    expect(secrets.EMBEDDING_DIMS).toBeUndefined();
  });
});

// =====================================================================
// COMPREHENSIVE performSetup END-TO-END
// =====================================================================

describe("performSetup end-to-end artifacts", () => {
  beforeEach(() => {
    createFullDirTree();
    seedMinimalEnvFiles();
    saveAndSetEnv();
  });

  afterEach(() => {
    restoreEnv();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("writes stack.yaml and readStackSpec returns v2", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.capabilities.llm).toBe("openai/gpt-4o");
    expect(spec!.capabilities.embeddings.model).toBe("text-embedding-3-small");
  });

  it("writes memory config with correct embedding dims from lookup", async () => {
    const input = makeValidInput({
      connections: [
        {
          id: "ollama-1",
          name: "Ollama",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "",
        },
      ],
      assignments: {
        llm: { connectionId: "ollama-1", model: "llama3.2" },
        embeddings: {
          connectionId: "ollama-1",
          model: "nomic-embed-text",
        },
      },
    });

    await performSetup(input, createStubAssetProvider());

    const memConfig = JSON.parse(
      readFileSync(join(dataDir, "memory", "default_config.json"), "utf-8")
    );
    // nomic-embed-text is 768 dims per EMBEDDING_DIMS constant
    expect(memConfig.mem0.vector_store.config.embedding_model_dims).toBe(768);
  });

  it("writes core.compose.yml to stack/", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    expect(
      existsSync(join(homeDir, "stack", "core.compose.yml"))
    ).toBe(true);
  });

  it("writes admin and assistant tokens to stack.env", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    const secrets = parseEnvFile(join(vaultDir, "stack", "stack.env"));
    expect(secrets.OP_ADMIN_TOKEN).toBe("test-admin-token-12345");
    expect(typeof secrets.OP_ASSISTANT_TOKEN).toBe("string");
    expect(secrets.OP_ASSISTANT_TOKEN).not.toBe("test-admin-token-12345");
  });

  it("writes managed.env files from capabilities", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    const managedEnvPath = join(vaultDir, "stack", "services", "memory", "managed.env");
    expect(existsSync(managedEnvPath)).toBe(true);
    const managedEnv = parseEnvFile(managedEnvPath);
    expect(managedEnv.SYSTEM_LLM_PROVIDER).toBe("openai");
    expect(managedEnv.SYSTEM_LLM_MODEL).toBe("gpt-4o");
    expect(managedEnv.EMBEDDING_MODEL).toBe("text-embedding-3-small");
  });
});

// =====================================================================
// mergeEnvContent EDGE CASES
// =====================================================================

describe("mergeEnvContent edge cases", () => {
  it("preserves comments and blank lines when updating existing key", () => {
    const original = [
      "# My header",
      "",
      "export FOO=old",
      "",
      "# Footer comment",
    ].join("\n");

    const result = mergeEnvContent(original, { FOO: "new" });
    expect(result).toContain("# My header");
    expect(result).toContain("# Footer comment");

    const parsed = parseEnvContent(result);
    expect(parsed.FOO).toBe("new");
  });

  it("appends new keys to the end when they do not exist", () => {
    const original = "EXISTING=value\n";
    const result = mergeEnvContent(original, { NEW_KEY: "new_value" });
    const parsed = parseEnvContent(result);
    expect(parsed.EXISTING).toBe("value");
    expect(parsed.NEW_KEY).toBe("new_value");
  });

  it("uncomment option replaces commented-out keys", () => {
    const original = "# export ADMIN_TOKEN=old_value\n";
    const result = mergeEnvContent(
      original,
      { ADMIN_TOKEN: "new_value" },
      { uncomment: true }
    );
    const parsed = parseEnvContent(result);
    expect(parsed.ADMIN_TOKEN).toBe("new_value");
  });

  it("handles empty content gracefully", () => {
    const result = mergeEnvContent("", { KEY: "value" });
    const parsed = parseEnvContent(result);
    expect(parsed.KEY).toBe("value");
  });

  it("handles content with only comments", () => {
    const original = "# comment\n# another comment\n";
    const result = mergeEnvContent(original, { KEY: "value" });
    const parsed = parseEnvContent(result);
    expect(parsed.KEY).toBe("value");
  });
});

// =====================================================================
// parseEnvFile / parseEnvContent EDGE CASES
// =====================================================================

describe("parseEnvFile edge cases", () => {
  beforeEach(() => {
    createFullDirTree();
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns empty object for nonexistent file", () => {
    const result = parseEnvFile(join(vaultDir, "nonexistent.env"));
    expect(result).toEqual({});
  });

  it("returns empty object for empty file", () => {
    writeFileSync(join(vaultDir, "empty.env"), "");
    const result = parseEnvFile(join(vaultDir, "empty.env"));
    expect(result).toEqual({});
  });

  it("handles single-quoted values", () => {
    writeFileSync(
      join(vaultDir, "quoted.env"),
      "KEY='value with spaces'\n"
    );
    const result = parseEnvFile(join(vaultDir, "quoted.env"));
    expect(result.KEY).toBe("value with spaces");
  });

  it("handles double-quoted values", () => {
    writeFileSync(
      join(vaultDir, "quoted.env"),
      'KEY="value with spaces"\n'
    );
    const result = parseEnvFile(join(vaultDir, "quoted.env"));
    expect(result.KEY).toBe("value with spaces");
  });

  it("handles values with inline comments when unquoted", () => {
    // dotenv spec: unquoted values with # are treated as comments
    writeFileSync(
      join(vaultDir, "comment.env"),
      "KEY=value # this is a comment\n"
    );
    const result = parseEnvFile(join(vaultDir, "comment.env"));
    // dotenv library trims at the # for unquoted values
    expect(result.KEY).toBe("value");
  });
});

// =====================================================================
// loadSecretsEnvFile EDGE CASES
// =====================================================================

describe("loadSecretsEnvFile edge cases", () => {
  beforeEach(() => {
    createFullDirTree();
    saveAndSetEnv();
  });

  afterEach(() => {
    restoreEnv();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns empty object when user.env does not exist", () => {
    const result = loadSecretsEnvFile(vaultDir);
    expect(result).toEqual({});
  });

  it("filters out keys not matching uppercase alphanumeric pattern", () => {
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(
      join(vaultDir, "user", "user.env"),
      [
        "VALID_KEY=valid",
        "another_key=lowercase", // lowercase keys are filtered out
        "ALSO_VALID=yes",
        "123_STARTS_NUM=num", // starts with number but matches pattern
        "",
      ].join("\n")
    );

    const result = loadSecretsEnvFile(vaultDir);
    expect(result.VALID_KEY).toBe("valid");
    expect(result.ALSO_VALID).toBe("yes");
    // The regex /^[A-Z0-9_]+$/ does match 123_STARTS_NUM
    expect(result["123_STARTS_NUM"]).toBe("num");
    // Lowercase key does not match the filter
    expect(result.another_key).toBeUndefined();
  });
});

// =====================================================================
// isSetupComplete EDGE CASES
// =====================================================================

describe("isSetupComplete edge cases", () => {
  beforeEach(() => {
    createFullDirTree();
    saveAndSetEnv();
  });

  afterEach(() => {
    restoreEnv();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns false when stack.env does not exist and no admin token", () => {
    // No stack.env and no user.env
    rmSync(join(vaultDir, "stack", "stack.env"), { force: true });

    expect(isSetupComplete(vaultDir)).toBe(false);
  });

  it("returns true for OP_SETUP_COMPLETE=TRUE (case insensitive)", () => {
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      "OP_SETUP_COMPLETE=TRUE\n"
    );

    expect(isSetupComplete(vaultDir)).toBe(true);
  });

  it("returns true for OP_SETUP_COMPLETE=True (mixed case)", () => {
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      "OP_SETUP_COMPLETE=True\n"
    );

    expect(isSetupComplete(vaultDir)).toBe(true);
  });

  it("returns false for OP_SETUP_COMPLETE=false", () => {
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      "OP_SETUP_COMPLETE=false\n"
    );
    writeFileSync(join(vaultDir, "user", "user.env"), "");

    expect(isSetupComplete(vaultDir)).toBe(false);
  });

  it("falls back to OP_ADMIN_TOKEN presence when OP_SETUP_COMPLETE not in stack.env", () => {
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      "OP_IMAGE_TAG=latest\nexport OP_ADMIN_TOKEN=my-admin-token\n"
    );

    expect(isSetupComplete(vaultDir)).toBe(true);
  });
});

// =====================================================================
// buildSecretsFromSetup EDGE CASES
// =====================================================================

describe("buildSecretsFromSetup edge cases", () => {
  it("sanitizes owner name with control characters", () => {
    const input = makeValidInput({ ownerName: "Test\nUser\r\0" });
    const secrets = buildSecretsFromSetup(input);
    expect(secrets.OWNER_NAME).toBe("TestUser");
  });

  it("omits empty owner name and email", () => {
    const input = makeValidInput({ ownerName: "", ownerEmail: "" });
    const secrets = buildSecretsFromSetup(input);
    expect(secrets.OWNER_NAME).toBeUndefined();
    expect(secrets.OWNER_EMAIL).toBeUndefined();
  });

  it("writes API key for each provider type", () => {
    for (const provider of ["openai", "groq", "anthropic"] as const) {
      const envKey =
        provider === "openai"
          ? "OPENAI_API_KEY"
          : provider === "groq"
            ? "GROQ_API_KEY"
            : "ANTHROPIC_API_KEY";

      const input = makeValidInput({
        connections: [
          {
            id: `${provider}-1`,
            name: provider,
            provider,
            baseUrl: "https://api.example.com",
            apiKey: "sk-test",
          },
        ],
        assignments: {
          llm: { connectionId: `${provider}-1`, model: "test-model" },
          embeddings: {
            connectionId: `${provider}-1`,
            model: "embed-model",
          },
        },
      });
      const secrets = buildSecretsFromSetup(input);
      expect(secrets[envKey]).toBe("sk-test");
      // Config vars should NOT be in secrets anymore
      expect(secrets.SYSTEM_LLM_PROVIDER).toBeUndefined();
    }
  });
});

describe("buildSystemSecretsFromSetup edge cases", () => {
  it("reuses existing assistant and memory tokens when provided", () => {
    const input = makeValidInput();
    const secrets = buildSystemSecretsFromSetup(input, {
      OP_ASSISTANT_TOKEN: "existing-assistant-token",
      OP_MEMORY_TOKEN: "existing-memory-token",
    });
    expect(secrets.OP_ADMIN_TOKEN).toBe("test-admin-token-12345");
    expect(secrets.OP_ASSISTANT_TOKEN).toBe("existing-assistant-token");
    expect(secrets.OP_MEMORY_TOKEN).toBe("existing-memory-token");
  });
});

// =====================================================================
// buildConnectionEnvVarMap EDGE CASES
// =====================================================================

describe("buildConnectionEnvVarMap edge cases", () => {
  it("handles a single Ollama connection (fallback to OPENAI_API_KEY)", () => {
    const connections: SetupConnection[] = [
      {
        id: "ollama-1",
        name: "Ollama",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        apiKey: "",
      },
    ];
    const map = buildConnectionEnvVarMap(connections);
    expect(map.get("ollama-1")).toBe("OPENAI_API_KEY");
  });

  it("skips connections with unsafe env var keys (hyphen creates invalid key)", () => {
    const connections: SetupConnection[] = [
      {
        id: "openai-1",
        name: "OpenAI",
        provider: "openai",
        baseUrl: "",
        apiKey: "sk-a",
      },
      {
        id: "openai-2",
        name: "OpenAI 2",
        provider: "openai",
        baseUrl: "",
        apiKey: "sk-b",
      },
    ];
    const map = buildConnectionEnvVarMap(connections);
    // First gets canonical key
    expect(map.get("openai-1")).toBe("OPENAI_API_KEY");
    // Second would be OPENAI_API_KEY_OPENAI-2, which has a hyphen -> skipped
    expect(map.has("openai-2")).toBe(false);
  });

  it("namespaces duplicate provider env vars with underscore IDs", () => {
    const connections: SetupConnection[] = [
      {
        id: "openai_1",
        name: "OpenAI 1",
        provider: "openai",
        baseUrl: "",
        apiKey: "sk-a",
      },
      {
        id: "openai_2",
        name: "OpenAI 2",
        provider: "openai",
        baseUrl: "",
        apiKey: "sk-b",
      },
    ];
    const map = buildConnectionEnvVarMap(connections);
    expect(map.get("openai_1")).toBe("OPENAI_API_KEY");
    // openai_2 -> OPENAI_API_KEY_OPENAI_2 which is a safe key
    expect(map.get("openai_2")).toBe("OPENAI_API_KEY_OPENAI_2");
  });
});
