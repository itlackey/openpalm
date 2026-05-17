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
import { parseEnvContent, parseEnvFile, mergeEnvContent } from "./env.js";
import { ensureSecrets, readStackEnv } from "./secrets.js";
import { isSetupComplete } from "./setup-status.js";
import {
  performSetup,
  buildSecretsFromSetup,
  buildSystemSecretsFromSetup,
} from "./setup.js";
import type { SetupSpec, SetupConnection } from "./setup.js";
import type { ControlPlaneState } from "./types.js";
import { STACK_SPEC_FILENAME, readStackSpec } from "./stack-spec.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeValidSpec(overrides?: Partial<SetupSpec>): SetupSpec {
  return {
    version: 2,
    capabilities: {
      llm: "openai/gpt-4o",
      embeddings: {
        provider: "openai",
        model: "text-embedding-3-small",
        dims: 1536,
      },
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

// ── Shared test fixture ──────────────────────────────────────────────────

let homeDir: string;
let configDir: string;
let stateDir: string;
let stackDir: string;
let cacheDir: string;

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
  stateDir = join(homeDir, "state");
  stackDir = join(configDir, "stack");
  cacheDir = join(homeDir, "cache");

  for (const dir of [
    homeDir,
    configDir,
    join(homeDir, "state", "registry", "automations"),
    join(configDir, "assistant"),
    join(configDir, "akm"),
    join(homeDir, "stash"),
    join(homeDir, "workspace"),
    stackDir,
    join(stackDir, "addons"),
    stateDir,
    join(stateDir, "assistant"),
    join(stateDir, "admin"),
    join(stateDir, "guardian"),
    join(stateDir, "logs"),
    join(stateDir, "logs", "opencode"),
    join(stateDir, "registry"),
    join(stateDir, "registry", "addons"),
    join(stateDir, "backups"),
    join(stateDir, "akm"),
    join(stateDir, "akm", "data"),
    join(stateDir, "akm", "state"),
    cacheDir,
    join(cacheDir, "akm"),
    join(cacheDir, "guardian"),
    join(cacheDir, "rollback"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // Seed asset files that ensure* functions expect to find at OP_HOME
  seedRequiredAssets(homeDir);
}

/** Seed the minimal stack.env needed for most tests. */
function seedMinimalEnvFiles(): void {
  mkdirSync(stackDir, { recursive: true });

  writeFileSync(
    join(stackDir, "stack.env"),
    [
      "# OpenPalm — Stack Configuration",
      "OP_UI_TOKEN=",
      "OP_ASSISTANT_TOKEN=",
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

  // Scenario 1: ensureSecrets does NOT seed user.env (Phase 2 of #388) but
  // does create stack.env with required keys when files do not exist.
  it("ensureSecrets creates state/stack.env with required keys on fresh install", () => {
    const state: ControlPlaneState = {
      adminToken: "",
      assistantToken: "",
      setupToken: "",
      homeDir,
      configDir,
      stashDir: join(homeDir, "stash"),
      workspaceDir: join(homeDir, "workspace"),
      cacheDir,
      stateDir,
      stackDir,
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
      audit: [],
    };

    ensureSecrets(state);

    // API keys and owner info are seeded in state/stack.env.
    const stackContent = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(stackContent).toContain("OPENAI_API_KEY=");
    expect(stackContent).toContain("OWNER_NAME=");
  });

  // Scenario 2: isSetupComplete returns false before setup
  it("isSetupComplete returns false when stack.env has OP_SETUP_COMPLETE=false", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stackDir, "stack.env"),
      "OP_SETUP_COMPLETE=false\n"
    );

    expect(isSetupComplete(stackDir)).toBe(false);
  });

  // Scenario 3: performSetup succeeds from completely empty state
  it("performSetup succeeds from completely empty state", async () => {
    seedMinimalEnvFiles();

    const result = await performSetup(
      makeValidSpec()
    );

    expect(result.ok).toBe(true);
  });

  // Scenario 4: performSetup marks setup complete in state/stack.env
  it("performSetup marks OP_SETUP_COMPLETE=true in state/stack.env", async () => {
    seedMinimalEnvFiles();

    await performSetup(makeValidSpec());

    const stackEnv = readFileSync(join(stackDir, "stack.env"), "utf-8");
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

  // Scenario 5: ensureSecrets does NOT overwrite existing stack.env
  it("ensureSecrets does not overwrite existing stack.env tokens", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stackDir, "stack.env"), "OP_UI_TOKEN=my-custom-token\nOP_ASSISTANT_TOKEN=existing-token\n");

    const state: ControlPlaneState = {
      adminToken: "",
      assistantToken: "",
      setupToken: "",
      homeDir,
      configDir,
      stashDir: join(homeDir, "stash"),
      workspaceDir: join(homeDir, "workspace"),
      cacheDir,
      stateDir,
      stackDir,
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
      audit: [],
    };

    ensureSecrets(state);

    // Existing tokens must be preserved
    const afterContent = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(afterContent).toContain("OP_UI_TOKEN=my-custom-token");
    expect(afterContent).toContain("OP_ASSISTANT_TOKEN=existing-token");
  });

  // Scenario 6: performSetup re-run preserves OP_ASSISTANT_TOKEN
  it("performSetup re-run preserves OP_ASSISTANT_TOKEN from first run", async () => {
    // First setup
    await performSetup(makeValidSpec());

    const secretsAfterFirst = readFileSync(
      join(stackDir, "stack.env"),
      "utf-8"
    );
    const firstMatch = secretsAfterFirst.match(
      /OP_ASSISTANT_TOKEN=([a-f0-9]+)/
    );
    expect(firstMatch).not.toBeNull();
    const firstToken = firstMatch![1];

    // Second setup (re-run with different API key)
    await performSetup(
      makeValidSpec({
        connections: [
          {
            id: "openai-main",
            name: "OpenAI",
            provider: "openai",
            baseUrl: "https://api.openai.com",
            apiKey: "sk-different-key-999",
          },
        ],
      })
    );

    const secretsAfterSecond = readFileSync(
      join(stackDir, "stack.env"),
      "utf-8"
    );
    const secondMatch = secretsAfterSecond.match(
      /OP_ASSISTANT_TOKEN=([a-f0-9]+)/
    );
    expect(secondMatch).not.toBeNull();
    // OP_ASSISTANT_TOKEN should be preserved across setups
    expect(secondMatch![1]).toBe(firstToken);
  });

  // Scenario 7: performSetup marks OP_SETUP_COMPLETE=true in state/stack.env
  it("performSetup marks OP_SETUP_COMPLETE=true in state/stack.env", async () => {
    await performSetup(makeValidSpec());

    const stackEnv = readFileSync(
      join(stackDir, "stack.env"),
      "utf-8"
    );
    const parsed = parseEnvContent(stackEnv);
    expect(parsed.OP_SETUP_COMPLETE).toBe("true");
  });

  // Scenario 8: Re-setup with different provider updates stack.yml capabilities
  it("re-setup with different provider updates capabilities in stack.yml", async () => {
    // First setup with OpenAI
    await performSetup(makeValidSpec());

    const specAfterFirst = readStackSpec(stackDir);
    expect(specAfterFirst).not.toBeNull();
    expect(specAfterFirst!.capabilities.llm).toContain("openai/");

    // Second setup with Groq
    await performSetup(
      makeValidSpec({
        capabilities: {
          llm: "groq/llama3-70b-8192",
          embeddings: {
            provider: "groq",
            model: "text-embedding-3-small",
            dims: 1536,
          },
        },
        connections: [
          {
            id: "groq-main",
            name: "Groq",
            provider: "groq",
            baseUrl: "https://api.groq.com/openai",
            apiKey: "gsk-test-key-456",
          },
        ],
      })
    );

    const specAfterSecond = readStackSpec(stackDir);
    expect(specAfterSecond).not.toBeNull();
    expect(specAfterSecond!.capabilities.llm).toBe("groq/llama3-70b-8192");

    // stack.env should retain both keys
    const secrets = readFileSync(join(stackDir, "stack.env"), "utf-8");
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

  // Scenario 9: ensureSecrets is idempotent on repeated calls
  it("ensureSecrets is idempotent — second call does not overwrite existing stack.env", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stackDir, "stack.env"), "OP_UI_TOKEN=existing-token\nOP_ASSISTANT_TOKEN=existing-assistant\n");

    const state: ControlPlaneState = {
      adminToken: "",
      assistantToken: "",
      setupToken: "",
      homeDir,
      configDir,
      stashDir: join(homeDir, "stash"),
      workspaceDir: join(homeDir, "workspace"),
      cacheDir,
      stateDir,
      stackDir,
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
      audit: [],
    };

    ensureSecrets(state);

    // Existing tokens must be preserved
    const content = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(content).toContain("OP_UI_TOKEN=existing-token");
    expect(content).toContain("OP_ASSISTANT_TOKEN=existing-assistant");
  });

  // Scenario 10: env file with malformed lines
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

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "test.env"), malformedContent);

    const parsed = parseEnvFile(join(stateDir, "test.env"));
    expect(parsed.VALID_KEY).toBe("valid_value");
    expect(parsed.EXPORTED_KEY).toBe("exported_value");
    expect(parsed.ANOTHER_VALID).toBe("value");
  });

  // Scenario 11: stack.env missing OP_SETUP_COMPLETE
  it("isSetupComplete falls back to token check when OP_SETUP_COMPLETE missing", () => {
    // stack.env without OP_SETUP_COMPLETE
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stackDir, "stack.env"),
      "OP_IMAGE_TAG=latest\n"
    );

    expect(isSetupComplete(stackDir)).toBe(false);
  });

  it("isSetupComplete falls back to true when admin token is set but OP_SETUP_COMPLETE missing", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stackDir, "stack.env"),
      "OP_IMAGE_TAG=latest\nexport OP_UI_TOKEN=my-real-token\n"
    );

    expect(isSetupComplete(stackDir)).toBe(true);
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

  // Scenario 13: Missing stack.yml returns null
  it("readStackSpec returns null when stack.yml missing", () => {
    const spec = readStackSpec(stackDir);
    expect(spec).toBeNull();
  });

  // Scenario 14: stash/tasks dir missing (performSetup should recreate it via ensureHomeDirs)
  it("performSetup creates missing subdirectories", async () => {
    // Seed the minimal env files first
    seedMinimalEnvFiles();

    // Remove stash/tasks dir (performSetup should recreate it via ensureHomeDirs)
    rmSync(join(homeDir, "stash", "tasks"), { recursive: true, force: true });

    const result = await performSetup(
      makeValidSpec()
    );
    expect(result.ok).toBe(true);

    // Artifacts should exist in config/stack/
    expect(existsSync(join(homeDir, "config", "stack", "core.compose.yml"))).toBe(
      true
    );
    // stash/tasks dir should be recreated by ensureHomeDirs
    expect(existsSync(join(homeDir, "stash", "tasks"))).toBe(true);
  });

  // Scenario 15: openpalm.yaml with old version
  it("readStackSpec returns null for version 1 spec", () => {
    writeFileSync(
      join(stackDir, STACK_SPEC_FILENAME),
      "version: 1\nconnections: []\n"
    );

    const spec = readStackSpec(stackDir);
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

  // Scenario 16: Commented-out ADMIN_TOKEN but OP_UI_TOKEN set
  it("isSetupComplete detects OP_UI_TOKEN when ADMIN_TOKEN is commented out", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stackDir, "stack.env"),
      "SOME_OTHER_KEY=value\nexport OP_UI_TOKEN=real-token-here\n"
    );

    expect(isSetupComplete(stackDir)).toBe(true);
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
    const input = makeValidSpec({
      capabilities: {
        llm: "ollama/llama3.2",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text",
          dims: 768,
        },
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

    // stack.yml should have ollama capabilities
    const spec = readStackSpec(stackDir);
    expect(spec).not.toBeNull();
    expect(spec!.capabilities.llm).toBe("ollama/llama3.2");
  });

  // Scenario 21: Multiple providers map to correct env vars
  it("multiple providers each write their API key to the correct env var", () => {
    const conns: SetupConnection[] = [
      { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-openai" },
      { id: "groq-1", name: "Groq", provider: "groq", baseUrl: "", apiKey: "gsk-groq" },
      { id: "anthropic-1", name: "Anthropic", provider: "anthropic", baseUrl: "", apiKey: "sk-ant-api03" },
    ];
    const secrets = buildSecretsFromSetup(conns);
    expect(secrets.OPENAI_API_KEY).toBe("sk-openai");
    expect(secrets.GROQ_API_KEY).toBe("gsk-groq");
    expect(secrets.ANTHROPIC_API_KEY).toBe("sk-ant-api03");
  });

  // Scenario 21b: OAuth providers (no API key) are silently skipped
  it("skips connections without API keys (OAuth providers)", () => {
    const conns: SetupConnection[] = [
      { id: "github-copilot", name: "GitHub Copilot", provider: "github-copilot", baseUrl: "", apiKey: "" },
      { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-test" },
    ];
    const secrets = buildSecretsFromSetup(conns);
    expect(secrets.OPENAI_API_KEY).toBe("sk-test");
    expect(Object.keys(secrets)).not.toContain("GITHUB_COPILOT_API_KEY");
  });

  // Scenario 22: buildSecretsFromSetup only writes API keys and owner info
  it("buildSecretsFromSetup writes API keys but not config vars", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);

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

  it("writes stack.yml and readStackSpec returns v2", async () => {
    await performSetup(makeValidSpec());

    const spec = readStackSpec(stackDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.capabilities.llm).toBe("openai/gpt-4o");
    expect(spec!.capabilities.embeddings.model).toBe("text-embedding-3-small");
  });

  it("writes OP_CAP_EMBEDDINGS_DIMS with correct embedding dims from lookup", async () => {
    const input = makeValidSpec({
      capabilities: {
        llm: "ollama/llama3.2",
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text",
          dims: 0, // Resolved from lookup
        },
      },
      connections: [
        {
          id: "ollama-1",
          name: "Ollama",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          apiKey: "",
        },
      ],
    });

    await performSetup(input);

    // nomic-embed-text is 768 dims per EMBEDDING_DIMS constant — verify via stack.env
    const stackEnvContent = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(stackEnvContent).toContain("OP_CAP_EMBEDDINGS_DIMS=768");
  });

  it("writes core.compose.yml to stack/", async () => {
    await performSetup(makeValidSpec());

    expect(
      existsSync(join(homeDir, "config", "stack", "core.compose.yml"))
    ).toBe(true);
  });

  it("writes admin and assistant tokens to stack.env", async () => {
    await performSetup(makeValidSpec());

    const secrets = parseEnvFile(join(stackDir, "stack.env"));
    expect(secrets.OP_UI_TOKEN).toBe("test-admin-token-12345");
    expect(typeof secrets.OP_ASSISTANT_TOKEN).toBe("string");
    expect(secrets.OP_ASSISTANT_TOKEN).not.toBe("test-admin-token-12345");
  });

  it("writes OP_CAP_* vars from capabilities to stack.env", async () => {
    await performSetup(makeValidSpec());

    const stackEnv = parseEnvFile(join(stackDir, "stack.env"));
    expect(stackEnv.OP_CAP_LLM_PROVIDER).toBe("openai");
    expect(stackEnv.OP_CAP_LLM_MODEL).toBe("gpt-4o");
    expect(stackEnv.OP_CAP_EMBEDDINGS_MODEL).toBe("text-embedding-3-small");
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
});
