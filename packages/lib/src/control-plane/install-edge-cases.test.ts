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
  buildAuthJsonFromSetup,
  buildSystemSecretsFromSetup,
} from "./setup.js";
import type { SetupSpec, SetupConnection } from "./setup.js";
import type { ControlPlaneState } from "./types.js";
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
  mkdirSync(join(homeDir, "state", "assistant"), { recursive: true });
  writeFileSync(join(homeDir, "state", "assistant", "opencode.jsonc"), '{"$schema":"https://opencode.ai/config.json"}\n');
  writeFileSync(join(homeDir, "state", "assistant", "AGENTS.md"), "# Agents\n");
  mkdirSync(join(homeDir, "state"), { recursive: true });
  // Automations live in state/registry/automations (shipped catalog) and stash/tasks (user tasks)
  mkdirSync(join(homeDir, "state", "registry", "automations"), { recursive: true });
  writeFileSync(join(homeDir, "state", "registry", "automations", "cleanup-logs.yml"), "schedule: \"0 4 * * 0\"\ndescription: cleanup logs\ncommand: [\"echo\",\"clean\"]\n");
  writeFileSync(join(homeDir, "state", "registry", "automations", "cleanup-data.yml"), "schedule: \"0 5 * * 0\"\ndescription: cleanup data\ncommand: [\"echo\",\"clean\"]\n");
  writeFileSync(join(homeDir, "state", "registry", "automations", "validate-config.yml"), "schedule: \"0 3 * * *\"\ndescription: validate config\ncommand: [\"echo\",\"clean\"]\n");
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
      "OPENAI_BASE_URL=",
      "OP_OWNER_NAME=",
      "OP_OWNER_EMAIL=",
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

  // Scenario 1: ensureSecrets does NOT seed user.env (see akm-vault) but
  // does create stack.env with required keys when files do not exist.
  it("ensureSecrets creates state/stack.env with required keys on fresh install", () => {
    const state: ControlPlaneState = {
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
    };

    ensureSecrets(state);

    // stack.env only carries non-secret setup/config keys.
    const stackContent = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(stackContent).not.toContain("OPENAI_API_KEY=");
    expect(stackContent).toContain("OP_SETUP_COMPLETE=false");
    expect(readSecret(stackDir, 'op_ui_login_password')).toBeTruthy();
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

  // Scenario 4: performSetup must NOT mark OP_SETUP_COMPLETE.
  //
  // The flag is set by setup-deploy.ts:startDeploy AFTER the Docker stack is
  // confirmed healthy. If performSetup wrote it eagerly, a deploy failure
  // would leave the wizard convinced setup was complete and bounce the user
  // into a broken admin UI.
  it("performSetup does NOT mark OP_SETUP_COMPLETE (deploy owns that flag)", async () => {
    seedMinimalEnvFiles();

    await performSetup(makeValidSpec());

    const stackEnv = readFileSync(join(stackDir, "stack.env"), "utf-8");
    const parsed = parseEnvContent(stackEnv);
    // Either entirely absent, or still the seeded "false" — never "true".
    expect(parsed.OP_SETUP_COMPLETE === undefined || parsed.OP_SETUP_COMPLETE === "false").toBe(true);
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

  // Scenario 5: ensureSecrets creates file-based secrets without stack.env tokens
  it("ensureSecrets creates file-based system secrets", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stackDir, "stack.env"), "OP_SETUP_COMPLETE=false\n");

    const state: ControlPlaneState = {
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
    };

    ensureSecrets(state);

    const afterContent = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(afterContent).not.toContain("OP_UI_LOGIN_PASSWORD=");
    expect(readSecret(stackDir, 'op_ui_login_password')).toBeTruthy();
  });

  // Scenario 6: performSetup re-run rewrites OP_UI_LOGIN_PASSWORD when the
  // operator supplies a new one in the spec. This is intentional — the
  // wizard "rerun" path is how an operator rotates the password. The
  // legacy OP_ASSISTANT_TOKEN preservation test was removed with the token.
  it("performSetup re-run rewrites OP_UI_LOGIN_PASSWORD secret file when spec changes", async () => {
    await performSetup(makeValidSpec({ security: { uiLoginPassword: "first-password-12345" } }));

    expect(readSecret(stackDir, 'op_ui_login_password')).toBe("first-password-12345\n");

    await performSetup(makeValidSpec({ security: { uiLoginPassword: "second-password-12345" } }));

    expect(readSecret(stackDir, 'op_ui_login_password')).toBe("second-password-12345\n");
  });

  // Scenario 7: performSetup must NOT mark OP_SETUP_COMPLETE — see scenario
  // 4 in the Fresh Install block for the rationale. The deploy phase owns
  // this flag and only writes it after the container stack is healthy.
  it("performSetup does NOT mark OP_SETUP_COMPLETE (deploy owns that flag)", async () => {
    await performSetup(makeValidSpec());

    const stackEnv = readFileSync(
      join(stackDir, "stack.env"),
      "utf-8"
    );
    const parsed = parseEnvContent(stackEnv);
    expect(parsed.OP_SETUP_COMPLETE === undefined || parsed.OP_SETUP_COMPLETE === "false").toBe(true);
  });

  // Scenario 8: Re-setup with different provider updates akm config
  it("re-setup with different provider updates akm config", async () => {
    // First setup with OpenAI
    await performSetup(makeValidSpec());

    // Second setup with Groq
    await performSetup(
      makeValidSpec({
        llm: { provider: "groq", model: "llama3-70b-8192", baseUrl: "https://api.groq.com/openai/v1" },
        embedding: { provider: "groq", model: "text-embedding-3-small", dims: 1536, baseUrl: "https://api.groq.com/openai/v1" },
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

    // stack.yml is just a version marker now
    const specAfterSecond = readStackSpec(stackDir);
    expect(specAfterSecond).not.toBeNull();
    expect(specAfterSecond!.version).toBe(2);

    const auth = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf-8"));
    expect(auth.groq.key).toBe("gsk-test-key-456");
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
    writeFileSync(join(stackDir, "stack.env"), "OP_SETUP_COMPLETE=false\n");

    const state: ControlPlaneState = {
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
    };

    ensureSecrets(state);

    // Existing non-secret stack config must be preserved.
    const content = readFileSync(join(stackDir, "stack.env"), "utf-8");
    expect(content).toContain("OP_SETUP_COMPLETE=false");
    expect(content).not.toContain("OP_UI_LOGIN_PASSWORD=");
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

  it("isSetupComplete returns false when OP_UI_LOGIN_PASSWORD is set but OP_SETUP_COMPLETE is missing", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stackDir, "stack.env"),
      "OP_IMAGE_TAG=latest\nexport OP_UI_LOGIN_PASSWORD=my-real-password\n"
    );

    // Password alone is no longer a proxy for setup completion.
    // Only OP_SETUP_COMPLETE=true counts.
    expect(isSetupComplete(stackDir)).toBe(false);
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

  // Scenario 16: isSetupComplete requires explicit OP_SETUP_COMPLETE=true
  it("isSetupComplete returns false when only OP_UI_LOGIN_PASSWORD is set", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stackDir, "stack.env"),
      "SOME_OTHER_KEY=value\nexport OP_UI_LOGIN_PASSWORD=real-password-here\n"
    );

    expect(isSetupComplete(stackDir)).toBe(false);
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

  // Scenario 20: Ollama setup
  it("Ollama setup writes akm config with ollama provider", async () => {
    const input = makeValidSpec({
      llm: { provider: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434/v1" },
      embedding: { provider: "ollama", model: "nomic-embed-text", dims: 768, baseUrl: "http://localhost:11434/v1" },
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

    const spec = readStackSpec(stackDir);
    expect(spec).not.toBeNull();
    expect(spec!.version).toBe(2);
  });

  // Scenario 21: Multiple providers map to correct env vars
  it("multiple providers each write their API key into auth.json keyed by providerId", () => {
    const conns: SetupConnection[] = [
      { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-openai" },
      { id: "groq-1", name: "Groq", provider: "groq", baseUrl: "", apiKey: "gsk-groq" },
      { id: "anthropic-1", name: "Anthropic", provider: "anthropic", baseUrl: "", apiKey: "sk-ant-api03" },
    ];
    const keys = buildAuthJsonFromSetup(conns);
    expect(keys.openai).toBe("sk-openai");
    expect(keys.groq).toBe("gsk-groq");
    expect(keys.anthropic).toBe("sk-ant-api03");
  });

  // Scenario 21b: OAuth providers (no API key) are silently skipped
  it("skips connections without API keys (OAuth providers)", () => {
    const conns: SetupConnection[] = [
      { id: "github-copilot", name: "GitHub Copilot", provider: "github-copilot", baseUrl: "", apiKey: "" },
      { id: "openai-1", name: "OpenAI", provider: "openai", baseUrl: "", apiKey: "sk-test" },
    ];
    const keys = buildAuthJsonFromSetup(conns);
    expect(keys.openai).toBe("sk-test");
    expect(keys["github-copilot"]).toBeUndefined();
  });

  // Scenario 22: buildSecretsFromSetup writes non-credential vars only;
  // API keys flow into auth.json via buildAuthJsonFromSetup.
  it("buildSecretsFromSetup does not write API keys; buildAuthJsonFromSetup does", () => {
    const spec = makeValidSpec();
    const secrets = buildSecretsFromSetup(spec.connections, spec.owner);
    const keys = buildAuthJsonFromSetup(spec.connections);

    // API keys go to auth.json, not stack.env
    expect(secrets.OPENAI_API_KEY).toBeUndefined();
    expect(keys.openai).toBe("sk-test-key-123");
    // Config vars (capability resolution) are not in stack.env user-secrets either
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
  });

  it("writes akm config with embedding dims from setup spec", async () => {
    const input = makeValidSpec({
      llm: { provider: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434/v1" },
      embedding: { provider: "ollama", model: "nomic-embed-text", dims: 768, baseUrl: "http://localhost:11434/v1" },
      connections: [
        { id: "ollama-1", name: "Ollama", provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "" },
      ],
    });

    await performSetup(input);

    const akmConfigPath = join(homeDir, "config", "akm", "config.json");
    const config = JSON.parse(readFileSync(akmConfigPath, "utf-8"));
    expect(config.embedding.dimension).toBe(768);
  });

  it("writes core.compose.yml to stack/", async () => {
    await performSetup(makeValidSpec());

    expect(
      existsSync(join(homeDir, "config", "stack", "core.compose.yml"))
    ).toBe(true);
  });

  it("writes the UI login password to a secret file", async () => {
    await performSetup(makeValidSpec());

    expect(readSecret(stackDir, 'op_ui_login_password')).toBe("test-admin-token-12345\n");
  });

  it("writes akm config with llm provider and model", async () => {
    await performSetup(makeValidSpec());

    const akmConfigPath = join(homeDir, "config", "akm", "config.json");
    const config = JSON.parse(readFileSync(akmConfigPath, "utf-8"));
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.model).toBe("gpt-4o");
    expect(config.embedding.model).toBe("text-embedding-3-small");
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
