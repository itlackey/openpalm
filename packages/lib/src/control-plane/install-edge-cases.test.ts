/**
 * Edge-case tests for the OpenPalm install and setup flow.
 *
 * Each test creates its own temp directory tree mimicking the XDG layout
 * (CONFIG_HOME, DATA_HOME, STATE_HOME), then runs the actual library
 * functions against it. No mocks of code under test.
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
  buildConnectionEnvVarMap,
} from "./setup.js";
import type { SetupInput, SetupConnection } from "./setup.js";
import type { CoreAssetProvider } from "./core-asset-provider.js";
import type { ControlPlaneState } from "./types.js";
import { STACK_SPEC_FILENAME, readStackSpec } from "./stack-spec.js";
import { readConnectionProfilesDocument } from "./connection-profiles.js";

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
    coreCompose: () => "services:\n  caddy:\n    image: caddy:latest\n",
    caddyfile: () =>
      ":80 {\n  @denied not remote_ip 127.0.0.0/8 ::1\n  respond @denied 403\n}\n",
    ollamaCompose: () => "services:\n  ollama:\n    image: ollama/ollama\n",
    agentsMd: () => "# Agents\n",
    opencodeConfig: () =>
      '{"$schema":"https://opencode.ai/config.json"}\n',
    adminOpencodeConfig: () =>
      '{"$schema":"https://opencode.ai/config.json","plugin":["@openpalm/admin-tools"]}\n',
    secretsSchema: () => "ADMIN_TOKEN=string\n",
    stackSchema: () => "OPENPALM_IMAGE_TAG=string\n",
    cleanupLogs: () => "name: cleanup-logs\nschedule: daily\n",
    cleanupData: () => "name: cleanup-data\nschedule: weekly\n",
    validateConfig: () => "name: validate-config\nschedule: hourly\n",
  };
}

// ── Shared test fixture ──────────────────────────────────────────────────

let tempBase: string;
let configDir: string;
let dataDir: string;
let stateDir: string;

const savedEnv: Record<string, string | undefined> = {};

function saveAndSetEnv(): void {
  savedEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
  savedEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
  savedEnv.OPENPALM_STATE_HOME = process.env.OPENPALM_STATE_HOME;
  process.env.OPENPALM_CONFIG_HOME = configDir;
  process.env.OPENPALM_DATA_HOME = dataDir;
  process.env.OPENPALM_STATE_HOME = stateDir;
}

function restoreEnv(): void {
  process.env.OPENPALM_CONFIG_HOME = savedEnv.OPENPALM_CONFIG_HOME;
  process.env.OPENPALM_DATA_HOME = savedEnv.OPENPALM_DATA_HOME;
  process.env.OPENPALM_STATE_HOME = savedEnv.OPENPALM_STATE_HOME;
}

/** Create a full directory tree matching ensureXdgDirs() output. */
function createFullDirTree(): void {
  tempBase = mkdtempSync(join(tmpdir(), "openpalm-edge-"));
  configDir = join(tempBase, "config");
  dataDir = join(tempBase, "data");
  stateDir = join(tempBase, "state");

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
}

/** Seed the minimal secrets.env and stack.env needed for most tests. */
function seedMinimalEnvFiles(): void {
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

  writeFileSync(
    join(stateDir, "artifacts", "stack.env"),
    "OPENPALM_SETUP_COMPLETE=false\n"
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
    rmSync(tempBase, { recursive: true, force: true });
  });

  // Scenario 1: ensureSecrets creates secrets.env with all required keys
  it("ensureSecrets creates secrets.env with MEMORY_AUTH_TOKEN when file does not exist", () => {
    const state: ControlPlaneState = {
      adminToken: "",
      setupToken: "",
      stateDir,
      configDir,
      dataDir,
      services: {},
      artifacts: { compose: "", caddyfile: "" },
      artifactMeta: [],
      audit: [],
      channelSecrets: {},
    };

    // No secrets.env exists yet
    expect(existsSync(join(configDir, "secrets.env"))).toBe(false);

    ensureSecrets(state);

    const content = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(content).toContain("MEMORY_AUTH_TOKEN=");
    // Token should be a non-empty hex string (64 chars for 32 bytes)
    const match = content.match(/MEMORY_AUTH_TOKEN=([a-f0-9]+)/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(64);
  });

  // Scenario 2: isSetupComplete returns false before setup
  it("isSetupComplete returns false when stack.env has OPENPALM_SETUP_COMPLETE=false", () => {
    writeFileSync(
      join(stateDir, "artifacts", "stack.env"),
      "OPENPALM_SETUP_COMPLETE=false\n"
    );
    // Empty secrets.env so fallback check doesn't trigger
    writeFileSync(join(configDir, "secrets.env"), "");

    expect(isSetupComplete(stateDir, configDir)).toBe(false);
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

  // Scenario 4: isSetupComplete returns true after performSetup
  it("isSetupComplete returns true after performSetup", async () => {
    seedMinimalEnvFiles();

    await performSetup(makeValidInput(), createStubAssetProvider());

    expect(isSetupComplete(stateDir, configDir)).toBe(true);
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
    rmSync(tempBase, { recursive: true, force: true });
  });

  // Scenario 5: ensureSecrets does NOT overwrite existing secrets.env
  it("ensureSecrets does not overwrite existing secrets.env", () => {
    const customContent =
      "export OPENPALM_ADMIN_TOKEN=my-custom-token\nexport MEMORY_AUTH_TOKEN=custom-auth-token\n";
    writeFileSync(join(configDir, "secrets.env"), customContent);

    const state: ControlPlaneState = {
      adminToken: "",
      setupToken: "",
      stateDir,
      configDir,
      dataDir,
      services: {},
      artifacts: { compose: "", caddyfile: "" },
      artifactMeta: [],
      audit: [],
      channelSecrets: {},
    };

    ensureSecrets(state);

    const afterContent = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(afterContent).toBe(customContent);
  });

  // Scenario 6: performSetup re-run preserves MEMORY_AUTH_TOKEN
  it("performSetup re-run preserves MEMORY_AUTH_TOKEN from first run", async () => {
    // First setup
    await performSetup(makeValidInput(), createStubAssetProvider());

    const secretsAfterFirst = readFileSync(
      join(configDir, "secrets.env"),
      "utf-8"
    );
    const firstMatch = secretsAfterFirst.match(
      /MEMORY_AUTH_TOKEN=([a-f0-9]+)/
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
      join(configDir, "secrets.env"),
      "utf-8"
    );
    const secondMatch = secretsAfterSecond.match(
      /MEMORY_AUTH_TOKEN=([a-f0-9]+)/
    );
    expect(secondMatch).not.toBeNull();
    // MEMORY_AUTH_TOKEN should be preserved (buildSecretsFromSetup does not overwrite it)
    expect(secondMatch![1]).toBe(firstToken);
  });

  // Scenario 7: stageStackEnv preserves OPENPALM_SETUP_COMPLETE=true from existing stack.env
  it("performSetup marks OPENPALM_SETUP_COMPLETE=true in staged stack.env", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    const stagedStack = readFileSync(
      join(stateDir, "artifacts", "stack.env"),
      "utf-8"
    );
    const parsed = parseEnvContent(stagedStack);
    expect(parsed.OPENPALM_SETUP_COMPLETE).toBe("true");
  });

  // Scenario 8: Re-setup with different provider preserves existing connections
  it("re-setup with different provider writes new connection profiles", async () => {
    // First setup with OpenAI
    await performSetup(makeValidInput(), createStubAssetProvider());

    const profilesAfterFirst = readConnectionProfilesDocument(configDir);
    expect(profilesAfterFirst.profiles).toHaveLength(1);
    expect(profilesAfterFirst.profiles[0].provider).toBe("openai");

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

    const profilesAfterSecond = readConnectionProfilesDocument(configDir);
    // performSetup writes the full document, so second setup replaces profiles
    expect(profilesAfterSecond.profiles).toHaveLength(1);
    expect(profilesAfterSecond.profiles[0].provider).toBe("groq");

    // But secrets.env should retain both keys
    const secrets = readFileSync(join(configDir, "secrets.env"), "utf-8");
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
    rmSync(tempBase, { recursive: true, force: true });
  });

  // Scenario 9: secrets.env exists but is empty
  it("ensureSecrets returns early for an empty but existing secrets.env", () => {
    writeFileSync(join(configDir, "secrets.env"), "");

    const state: ControlPlaneState = {
      adminToken: "",
      setupToken: "",
      stateDir,
      configDir,
      dataDir,
      services: {},
      artifacts: { compose: "", caddyfile: "" },
      artifactMeta: [],
      audit: [],
      channelSecrets: {},
    };

    ensureSecrets(state);

    // File should still exist and still be empty (ensureSecrets only checks existence)
    const content = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(content).toBe("");
  });

  // Scenario 10: secrets.env with malformed lines
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

    writeFileSync(join(configDir, "secrets.env"), malformedContent);

    const parsed = parseEnvFile(join(configDir, "secrets.env"));
    expect(parsed.VALID_KEY).toBe("valid_value");
    expect(parsed.EXPORTED_KEY).toBe("exported_value");
    expect(parsed.ANOTHER_VALID).toBe("value");
  });

  // Scenario 11: stack.env missing OPENPALM_SETUP_COMPLETE
  it("isSetupComplete falls back to token check when OPENPALM_SETUP_COMPLETE missing", () => {
    // stack.env without OPENPALM_SETUP_COMPLETE
    writeFileSync(
      join(stateDir, "artifacts", "stack.env"),
      "OPENPALM_IMAGE_TAG=latest\n"
    );

    // secrets.env without any token
    writeFileSync(
      join(configDir, "secrets.env"),
      "export OPENPALM_ADMIN_TOKEN=\nexport ADMIN_TOKEN=\n"
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(false);
  });

  it("isSetupComplete falls back to true when admin token is set but OPENPALM_SETUP_COMPLETE missing", () => {
    writeFileSync(
      join(stateDir, "artifacts", "stack.env"),
      "OPENPALM_IMAGE_TAG=latest\n"
    );

    writeFileSync(
      join(configDir, "secrets.env"),
      "export OPENPALM_ADMIN_TOKEN=my-real-token\n"
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(true);
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

  // Scenario 13: Corrupt profiles.json
  it("readConnectionProfilesDocument throws on corrupt JSON", () => {
    writeFileSync(
      join(configDir, "connections", "profiles.json"),
      "NOT VALID JSON {{{{"
    );

    expect(() => readConnectionProfilesDocument(configDir)).toThrow(
      "invalid JSON"
    );
  });

  it("readConnectionProfilesDocument throws on valid JSON but wrong structure", () => {
    writeFileSync(
      join(configDir, "connections", "profiles.json"),
      JSON.stringify({ version: 1, profiles: [], assignments: {} })
    );

    expect(() => readConnectionProfilesDocument(configDir)).toThrow(
      "invalid"
    );
  });

  // Scenario 14: CONFIG_HOME exists but STATE_HOME/automations doesn't
  it("performSetup creates missing STATE_HOME subdirectories", async () => {
    // Seed the minimal env files first (needs artifacts dir to exist)
    seedMinimalEnvFiles();

    // Remove automations dir (performSetup should recreate it)
    rmSync(join(stateDir, "automations"), { recursive: true, force: true });

    const result = await performSetup(
      makeValidInput(),
      createStubAssetProvider()
    );
    expect(result.ok).toBe(true);

    // Artifacts should exist
    expect(existsSync(join(stateDir, "artifacts", "docker-compose.yml"))).toBe(
      true
    );
    expect(existsSync(join(stateDir, "artifacts", "Caddyfile"))).toBe(true);
    // Automations dir should be recreated
    expect(existsSync(join(stateDir, "automations"))).toBe(true);
  });

  // Scenario 15: openpalm.yaml with old version
  it("readStackSpec returns null for version 2 spec", () => {
    writeFileSync(
      join(configDir, STACK_SPEC_FILENAME),
      "version: 2\nservices: []\n"
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
    rmSync(tempBase, { recursive: true, force: true });
  });

  // Scenario 16: Commented-out ADMIN_TOKEN but OPENPALM_ADMIN_TOKEN set
  it("isSetupComplete detects OPENPALM_ADMIN_TOKEN when ADMIN_TOKEN is commented out", () => {
    writeFileSync(
      join(stateDir, "artifacts", "stack.env"),
      "SOME_OTHER_KEY=value\n"
    );

    writeFileSync(
      join(configDir, "secrets.env"),
      [
        "export OPENPALM_ADMIN_TOKEN=real-token-here",
        "# export ADMIN_TOKEN=",
        "",
      ].join("\n")
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(true);
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
    rmSync(tempBase, { recursive: true, force: true });
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

    // Connection profiles should use the in-stack URL
    const doc = readConnectionProfilesDocument(configDir);
    expect(doc.profiles[0].baseUrl).toBe("http://ollama:11434");

    // secrets.env should have in-stack URL
    const secrets = parseEnvFile(join(configDir, "secrets.env"));
    expect(secrets.SYSTEM_LLM_BASE_URL).toBe("http://ollama:11434");
    expect(secrets.OPENAI_BASE_URL).toBe("http://ollama:11434/v1");
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

  // Scenario 22: Provider URL already ending in /v1
  it("provider URL already ending in /v1 does not get double /v1/v1", () => {
    const secrets = buildSecretsFromSetup(
      makeValidInput({
        connections: [
          {
            id: "openai-compat",
            name: "OpenAI Compatible",
            provider: "openai",
            baseUrl: "https://example.com/v1",
            apiKey: "sk-test",
          },
        ],
        assignments: {
          llm: { connectionId: "openai-compat", model: "gpt-4o" },
          embeddings: {
            connectionId: "openai-compat",
            model: "text-embedding-3-small",
          },
        },
      })
    );

    expect(secrets.OPENAI_BASE_URL).toBe("https://example.com/v1");
    expect(secrets.OPENAI_BASE_URL).not.toContain("/v1/v1");
  });

  it("provider URL without /v1 gets /v1 appended to OPENAI_BASE_URL", () => {
    const secrets = buildSecretsFromSetup(
      makeValidInput({
        connections: [
          {
            id: "openai-main",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com",
            apiKey: "sk-test",
          },
        ],
        assignments: {
          llm: { connectionId: "openai-main", model: "gpt-4o" },
          embeddings: {
            connectionId: "openai-main",
            model: "text-embedding-3-small",
          },
        },
      })
    );

    expect(secrets.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });

  it("provider URL with trailing slash normalizes correctly", () => {
    const secrets = buildSecretsFromSetup(
      makeValidInput({
        connections: [
          {
            id: "openai-main",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com/",
            apiKey: "sk-test",
          },
        ],
        assignments: {
          llm: { connectionId: "openai-main", model: "gpt-4o" },
          embeddings: {
            connectionId: "openai-main",
            model: "text-embedding-3-small",
          },
        },
      })
    );

    expect(secrets.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
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
    rmSync(tempBase, { recursive: true, force: true });
  });

  it("writes openpalm.yaml with version 3", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    const spec = readStackSpec(configDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(3);
    expect(spec!.connections).toHaveLength(1);
    expect(spec!.assignments.llm.model).toBe("gpt-4o");
    expect(spec!.ollamaEnabled).toBe(false);
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

  it("writes docker-compose.yml and Caddyfile to STATE_HOME/artifacts", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    expect(
      existsSync(join(stateDir, "artifacts", "docker-compose.yml"))
    ).toBe(true);
    expect(existsSync(join(stateDir, "artifacts", "Caddyfile"))).toBe(true);
    expect(existsSync(join(stateDir, "artifacts", "manifest.json"))).toBe(
      true
    );
  });

  it("writes secrets.env with correct admin token to both OPENPALM_ADMIN_TOKEN and ADMIN_TOKEN", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    const secrets = parseEnvFile(join(configDir, "secrets.env"));
    expect(secrets.OPENPALM_ADMIN_TOKEN).toBe("test-admin-token-12345");
    expect(secrets.ADMIN_TOKEN).toBe("test-admin-token-12345");
  });

  it("creates connection profiles document with correct assignments", async () => {
    await performSetup(makeValidInput(), createStubAssetProvider());

    const doc = readConnectionProfilesDocument(configDir);
    expect(doc.version).toBe(1);
    expect(doc.profiles).toHaveLength(1);
    expect(doc.profiles[0].id).toBe("openai-main");
    expect(doc.profiles[0].provider).toBe("openai");
    expect(doc.assignments.llm.model).toBe("gpt-4o");
    expect(doc.assignments.embeddings.model).toBe("text-embedding-3-small");
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
    rmSync(tempBase, { recursive: true, force: true });
  });

  it("returns empty object for nonexistent file", () => {
    const result = parseEnvFile(join(configDir, "nonexistent.env"));
    expect(result).toEqual({});
  });

  it("returns empty object for empty file", () => {
    writeFileSync(join(configDir, "empty.env"), "");
    const result = parseEnvFile(join(configDir, "empty.env"));
    expect(result).toEqual({});
  });

  it("handles single-quoted values", () => {
    writeFileSync(
      join(configDir, "quoted.env"),
      "KEY='value with spaces'\n"
    );
    const result = parseEnvFile(join(configDir, "quoted.env"));
    expect(result.KEY).toBe("value with spaces");
  });

  it("handles double-quoted values", () => {
    writeFileSync(
      join(configDir, "quoted.env"),
      'KEY="value with spaces"\n'
    );
    const result = parseEnvFile(join(configDir, "quoted.env"));
    expect(result.KEY).toBe("value with spaces");
  });

  it("handles values with inline comments when unquoted", () => {
    // dotenv spec: unquoted values with # are treated as comments
    writeFileSync(
      join(configDir, "comment.env"),
      "KEY=value # this is a comment\n"
    );
    const result = parseEnvFile(join(configDir, "comment.env"));
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
    rmSync(tempBase, { recursive: true, force: true });
  });

  it("returns empty object when secrets.env does not exist", () => {
    const result = loadSecretsEnvFile(configDir);
    expect(result).toEqual({});
  });

  it("filters out keys not matching uppercase alphanumeric pattern", () => {
    writeFileSync(
      join(configDir, "secrets.env"),
      [
        "VALID_KEY=valid",
        "another_key=lowercase", // lowercase keys are filtered out
        "ALSO_VALID=yes",
        "123_STARTS_NUM=num", // starts with number but matches pattern
        "",
      ].join("\n")
    );

    const result = loadSecretsEnvFile(configDir);
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
    rmSync(tempBase, { recursive: true, force: true });
  });

  it("returns false when stack.env does not exist and no admin token", () => {
    // No stack.env and no secrets.env
    rmSync(join(stateDir, "artifacts", "stack.env"), { force: true });

    expect(isSetupComplete(stateDir, configDir)).toBe(false);
  });

  it("returns true for OPENPALM_SETUP_COMPLETE=TRUE (case insensitive)", () => {
    writeFileSync(
      join(stateDir, "artifacts", "stack.env"),
      "OPENPALM_SETUP_COMPLETE=TRUE\n"
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(true);
  });

  it("returns true for OPENPALM_SETUP_COMPLETE=True (mixed case)", () => {
    writeFileSync(
      join(stateDir, "artifacts", "stack.env"),
      "OPENPALM_SETUP_COMPLETE=True\n"
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(true);
  });

  it("returns false for OPENPALM_SETUP_COMPLETE=false", () => {
    writeFileSync(
      join(stateDir, "artifacts", "stack.env"),
      "OPENPALM_SETUP_COMPLETE=false\n"
    );
    writeFileSync(join(configDir, "secrets.env"), "");

    expect(isSetupComplete(stateDir, configDir)).toBe(false);
  });

  it("falls back to ADMIN_TOKEN presence when OPENPALM_SETUP_COMPLETE not in stack.env", () => {
    writeFileSync(
      join(stateDir, "artifacts", "stack.env"),
      "OPENPALM_IMAGE_TAG=latest\n"
    );
    writeFileSync(
      join(configDir, "secrets.env"),
      "export ADMIN_TOKEN=my-admin-token\n"
    );

    expect(isSetupComplete(stateDir, configDir)).toBe(true);
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

  it("defaults memoryUserId to default_user when empty", () => {
    const input = makeValidInput({ memoryUserId: "" });
    const secrets = buildSecretsFromSetup(input);
    expect(secrets.MEMORY_USER_ID).toBe("default_user");
  });

  it("sets SYSTEM_LLM_PROVIDER correctly for each provider", () => {
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
      expect(secrets.SYSTEM_LLM_PROVIDER).toBe(provider);
      expect(secrets[envKey]).toBe("sk-test");
    }
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
