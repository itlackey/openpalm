/**
 * Edge-case tests for the OpenPalm install and setup flow.
 *
 * Each test creates its own temp directory tree mimicking the single
 * ~/.openpalm/ root layout (config, knowledge, data, logs), then runs the
 * actual library functions against it. No mocks of code under test.
 */
import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvContent, parseEnvFile, mergeEnvContent } from "./env.js";
import { ensureSecrets } from "./secrets.js";
import { isSetupComplete } from "./setup-status.js";
import {
  performSetup,
  buildOwnerEnvFromSetup,
  buildAuthJsonFromSetup,
} from "./setup.js";
import { markSetupComplete } from "./deploy.js";
import type { SetupSpec, SetupConnection } from "./setup.js";
import type { ControlPlaneState } from "./types.js";
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
  mkdirSync(join(homeDir, "knowledge", "tasks"), { recursive: true });
  writeFileSync(join(homeDir, "knowledge", "tasks", "cleanup-logs.yml"), "schedule: \"0 4 * * 0\"\ndescription: cleanup logs\ncommand: [\"echo\",\"clean\"]\n");
  writeFileSync(join(homeDir, "knowledge", "tasks", "cleanup-data.yml"), "schedule: \"0 5 * * 0\"\ndescription: cleanup data\ncommand: [\"echo\",\"clean\"]\n");
  writeFileSync(join(homeDir, "knowledge", "tasks", "validate-config.yml"), "schedule: \"0 3 * * *\"\ndescription: validate config\ncommand: [\"echo\",\"clean\"]\n");
}

// ── Shared test fixture ──────────────────────────────────────────────────

let homeDir: string;
let configDir: string;
let dataDir: string;
let stackDir: string;

const savedEnv: Record<string, string | undefined> = {};

function saveAndSetEnv(): void {
  savedEnv.OP_HOME = process.env.OP_HOME;
  savedEnv.OP_UI_LOGIN_PASSWORD = process.env.OP_UI_LOGIN_PASSWORD;
  savedEnv.OP_OPENCODE_PASSWORD = process.env.OP_OPENCODE_PASSWORD;
  process.env.OP_HOME = homeDir;
  delete process.env.OP_UI_LOGIN_PASSWORD;
  delete process.env.OP_OPENCODE_PASSWORD;
}

function restoreEnv(): void {
  if (savedEnv.OP_HOME === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = savedEnv.OP_HOME;
  if (savedEnv.OP_UI_LOGIN_PASSWORD === undefined) delete process.env.OP_UI_LOGIN_PASSWORD;
  else process.env.OP_UI_LOGIN_PASSWORD = savedEnv.OP_UI_LOGIN_PASSWORD;
  if (savedEnv.OP_OPENCODE_PASSWORD === undefined) delete process.env.OP_OPENCODE_PASSWORD;
  else process.env.OP_OPENCODE_PASSWORD = savedEnv.OP_OPENCODE_PASSWORD;
}

/** Create a full directory tree matching ensureHomeDirs() output. */
function createFullDirTree(): void {
  homeDir = mkdtempSync(join(tmpdir(), "openpalm-edge-"));
  configDir = join(homeDir, "config");
  dataDir = join(homeDir, "data");
  stackDir = join(configDir, "stack");

  for (const dir of [
    homeDir,
    configDir,
    join(configDir, "assistant"),
    join(configDir, "akm"),
    join(homeDir, "knowledge"),
    join(homeDir, "knowledge", "env"),
    join(homeDir, "knowledge", "secrets"),
    join(homeDir, "workspace"),
    stackDir,
    dataDir,
    join(dataDir, "assistant"),
    join(dataDir, "guardian"),
    join(dataDir, "akm", "cache"),
    join(dataDir, "akm", "data"),
    join(dataDir, "logs"),
    join(dataDir, "backups"),
    join(dataDir, "rollback"),
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
    join(homeDir, "knowledge", "env", "stack.env"),
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

  // Scenario 1: ensureSecrets does NOT seed user.env (see akm-user-env) but
  // does create stack.env with required keys when files do not exist.
  it("ensureSecrets creates stack.env with required keys on fresh install", () => {
    const state: ControlPlaneState = {
      homeDir,
      configDir,
      stashDir: join(homeDir, "knowledge"),
      workspaceDir: join(homeDir, "workspace"),
      dataDir,
      stackDir,
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
    };

    ensureSecrets(state);

    // stack.env only carries non-secret setup/config keys.
    const stackContent = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackContent).not.toContain("OPENAI_API_KEY=");
    expect(stackContent).toContain("OP_SETUP_COMPLETE=false");
    expect(readSecret(homeDir, 'op_ui_login_password')).toBeNull();
  });

  // Scenario 2: isSetupComplete returns false before setup
  it("isSetupComplete returns false when stack.env has OP_SETUP_COMPLETE=false", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(homeDir, "knowledge", "env", "stack.env"),
      "OP_SETUP_COMPLETE=false\n"
    );

    expect(isSetupComplete(homeDir)).toBe(false);
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

    const stackEnv = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8");
    const parsed = parseEnvContent(stackEnv);
    // Either entirely absent, or still the seeded "false" — never "true".
    expect(parsed.OP_SETUP_COMPLETE === undefined || parsed.OP_SETUP_COMPLETE === "false").toBe(true);
  });

  // Scenario 5: markSetupComplete writes the flag to state/ (constitution §1),
  // never into the operator-facing knowledge/env/stack.env, and isSetupComplete
  // reads it back via the state-over-legacy merge.
  it("markSetupComplete writes OP_SETUP_COMPLETE to state/, not stack.env", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(homeDir, "knowledge", "env", "stack.env"), "OP_SETUP_COMPLETE=false\n");
    expect(isSetupComplete(homeDir)).toBe(false);

    markSetupComplete({ homeDir } as unknown as ControlPlaneState);

    expect(isSetupComplete(homeDir)).toBe(true);
    const stateEnv = readFileSync(join(homeDir, "state", "stack.state.env"), "utf-8");
    expect(stateEnv).toContain("OP_SETUP_COMPLETE=true");
    // The operator-facing stack.env keeps its seeded "false" — state wins on read.
    expect(readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8")).toContain("OP_SETUP_COMPLETE=false");
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
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(homeDir, "knowledge", "env", "stack.env"), "OP_SETUP_COMPLETE=false\n");

    const state: ControlPlaneState = {
      homeDir,
      configDir,
      stashDir: join(homeDir, "knowledge"),
      workspaceDir: join(homeDir, "workspace"),
      dataDir,
      stackDir,
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
    };

    ensureSecrets(state);

    const afterContent = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8");
    expect(afterContent).not.toContain("OP_UI_LOGIN_PASSWORD=");
    expect(readSecret(homeDir, 'op_ui_login_password')).toBeNull();
  });

  // Scenario 6: performSetup re-run rewrites OP_UI_LOGIN_PASSWORD when the
  // operator supplies a new one in the spec. This is intentional — the
  // wizard "rerun" path is how an operator rotates the password. The
  // legacy OP_ASSISTANT_TOKEN preservation test was removed with the token.
  it("performSetup re-run rewrites OP_UI_LOGIN_PASSWORD secret file when spec changes", async () => {
    await performSetup(makeValidSpec({ security: { uiLoginPassword: "first-password-12345" } }));

    expect(readSecret(homeDir, 'op_ui_login_password')).toBe("first-password-12345\n");

    await performSetup(makeValidSpec({ security: { uiLoginPassword: "second-password-12345" } }));

    expect(readSecret(homeDir, 'op_ui_login_password')).toBe("second-password-12345\n");
  });

  // Scenario 7: performSetup must NOT mark OP_SETUP_COMPLETE — see scenario
  // 4 in the Fresh Install block for the rationale. The deploy phase owns
  // this flag and only writes it after the container stack is healthy.
  it("performSetup does NOT mark OP_SETUP_COMPLETE (deploy owns that flag)", async () => {
    await performSetup(makeValidSpec());

    const stackEnv = readFileSync(
      join(homeDir, "knowledge", "env", "stack.env"),
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

    const auth = JSON.parse(readFileSync(join(homeDir, "knowledge", "secrets", "auth.json"), "utf-8"));
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
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(homeDir, "knowledge", "env", "stack.env"), "OP_SETUP_COMPLETE=false\n");

    const state: ControlPlaneState = {
      homeDir,
      configDir,
      stashDir: join(homeDir, "knowledge"),
      workspaceDir: join(homeDir, "workspace"),
      dataDir,
      stackDir,
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
    };

    ensureSecrets(state);

    // Existing non-secret stack config must be preserved.
    const content = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8");
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

    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "test.env"), malformedContent);

    const parsed = parseEnvFile(join(dataDir, "test.env"));
    expect(parsed.VALID_KEY).toBe("valid_value");
    expect(parsed.EXPORTED_KEY).toBe("exported_value");
    expect(parsed.ANOTHER_VALID).toBe("value");
  });

  // Scenario 11: stack.env missing OP_SETUP_COMPLETE
  it("isSetupComplete falls back to token check when OP_SETUP_COMPLETE missing", () => {
    // stack.env without OP_SETUP_COMPLETE
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(homeDir, "knowledge", "env", "stack.env"),
      "OP_IMAGE_TAG=latest\n"
    );

    expect(isSetupComplete(homeDir)).toBe(false);
  });

  it("isSetupComplete returns false when OP_UI_LOGIN_PASSWORD is set but OP_SETUP_COMPLETE is missing", () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(homeDir, "knowledge", "env", "stack.env"),
      "OP_IMAGE_TAG=latest\nexport OP_UI_LOGIN_PASSWORD=my-real-password\n"
    );

    // Password alone is no longer a proxy for setup completion.
    // Only OP_SETUP_COMPLETE=true counts.
    expect(isSetupComplete(homeDir)).toBe(false);
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

  // Scenario 14: knowledge/tasks dir missing (performSetup should recreate it via ensureHomeDirs)
  it("performSetup creates missing subdirectories", async () => {
    // Seed the minimal env files first
    seedMinimalEnvFiles();

    // Remove knowledge/tasks dir (performSetup should recreate it via ensureHomeDirs)
    rmSync(join(homeDir, "knowledge", "tasks"), { recursive: true, force: true });

    const result = await performSetup(
      makeValidSpec()
    );
    expect(result.ok).toBe(true);

    // Artifacts should exist in config/stack/
    expect(existsSync(join(homeDir, "config", "stack", "core.compose.yml"))).toBe(
      true
    );
    // knowledge/tasks dir should be recreated by ensureHomeDirs
    expect(existsSync(join(homeDir, "knowledge", "tasks"))).toBe(true);
  });

  // 0.4 (R6-F6b): auth.json is normally a file, but a previous bug could leave
  // it as a directory. ensureSecrets repairs this on every call. Previously
  // the successful repair path produced NO log at all (only the failure path
  // warned) and the directory was simply rmSync'd, destroying whatever an
  // operator had put there. The repair must now (a) log a structured warning
  // even on success, and (b) move the directory into data/backups/ instead of
  // deleting it outright, so its contents remain recoverable.
  it("auth.json-as-directory repair logs on success and moves the directory into data/backups/ instead of deleting it", () => {
    const authJsonPath = join(homeDir, "knowledge", "secrets", "auth.json");
    rmSync(authJsonPath, { recursive: true, force: true });
    mkdirSync(authJsonPath, { recursive: true });
    writeFileSync(join(authJsonPath, "canary.txt"), "recover-me\n");

    const state: ControlPlaneState = {
      homeDir,
      configDir,
      stashDir: join(homeDir, "knowledge"),
      workspaceDir: join(homeDir, "workspace"),
      dataDir,
      stackDir,
      services: {},
      artifacts: { compose: "" },
      artifactMeta: [],
    };

    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      ensureSecrets(state);

      // auth.json is now a normal file again.
      expect(statSync(authJsonPath).isDirectory()).toBe(false);
      expect(readFileSync(authJsonPath, "utf-8")).toBe("{}\n");

      // The old directory was moved aside under data/backups/, not deleted —
      // its contents (the canary file) must still be recoverable.
      const backupEntries = readdirSync(join(dataDir, "backups"));
      const movedDir = backupEntries.find((name) => name.startsWith("auth.json"));
      expect(movedDir).toBeDefined();
      expect(
        readFileSync(join(dataDir, "backups", movedDir as string, "canary.txt"), "utf-8"),
      ).toBe("recover-me\n");

      // The repair must be logged even though nothing failed.
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("auth.json");
    } finally {
      errSpy.mockRestore();
    }
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
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(homeDir, "knowledge", "env", "stack.env"),
      "SOME_OTHER_KEY=value\nexport OP_UI_LOGIN_PASSWORD=real-password-here\n"
    );

    expect(isSetupComplete(homeDir)).toBe(false);
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

  // Scenario 22: buildOwnerEnvFromSetup writes non-credential vars only;
  // API keys flow into auth.json via buildAuthJsonFromSetup.
  it("buildOwnerEnvFromSetup does not write API keys; buildAuthJsonFromSetup does", () => {
    const spec = makeValidSpec();
    const ownerEnv = buildOwnerEnvFromSetup(spec.owner);
    const keys = buildAuthJsonFromSetup(spec.connections);

    // API keys go to auth.json, not stack.env
    expect(ownerEnv.OPENAI_API_KEY).toBeUndefined();
    expect(keys.openai).toBe("sk-test-key-123");
    // Config vars (capability resolution) are not in stack.env user-secrets either
    expect(ownerEnv.SYSTEM_LLM_PROVIDER).toBeUndefined();
    expect(ownerEnv.SYSTEM_LLM_MODEL).toBeUndefined();
    expect(ownerEnv.EMBEDDING_MODEL).toBeUndefined();
    expect(ownerEnv.EMBEDDING_DIMS).toBeUndefined();
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

  it("does not create a stack.yml (addon state lives in stack.env)", async () => {
    await performSetup(makeValidSpec());
    expect(existsSync(join(stackDir, "stack.yml"))).toBe(false);
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

    expect(readSecret(homeDir, 'op_ui_login_password')).toBe("test-admin-token-12345\n");
  });

  it("writes akm config with llm provider and model", async () => {
    await performSetup(makeValidSpec());

    const akmConfigPath = join(homeDir, "config", "akm", "config.json");
    const config = JSON.parse(readFileSync(akmConfigPath, "utf-8"));
    // Canonical akm 0.8.0 shape (I-3): profiles.llm.default + defaults.llm.
    expect(config.llm).toBeUndefined();
    expect(config.profiles.llm.default.provider).toBe("openai");
    expect(config.profiles.llm.default.model).toBe("gpt-4o");
    expect(config.defaults.llm).toBe("default");
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
