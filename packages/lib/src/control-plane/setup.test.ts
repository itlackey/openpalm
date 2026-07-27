import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateSetupSpec,
  buildOwnerEnvFromSetup,
  buildAuthJsonFromSetup,
  performSetup,
  persistAkmConfig,
  seedDefaultAutomation,
} from "./setup.js";
import type { SetupSpec, SetupConnection } from "./setup.js";
import type { ControlPlaneState } from "./types.js";
import { readSecret, secretPath } from './secrets-files.js';
import { PLATFORM_VERSION } from './versioning.js';

/** Escape regex metacharacters (PLATFORM_VERSION contains `.` and `-`). */
function reEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * E1: a fake `docker` binary (wired via OP_DOCKER_BIN, same knob docker.ts's
 * dockerBin() reads) so `dockerManifestExists` never hits a real registry.
 * `docker manifest inspect <ref>` "succeeds" (exit 0) only for refs listed in
 * FAKE_DOCKER_EXISTS_REFS (colon-separated) — unset/empty means "nothing is
 * published", matching the pre-E1 test fixtures' expectation that a blank
 * imageTag resolves to `latest` unless a test opts a ref in.
 */
function writeFakeDockerBin(dir: string): string {
  const scriptPath = join(dir, "fake-docker.sh");
  writeFileSync(
    scriptPath,
    [
      "#!/bin/sh",
      'if [ "$1" = "manifest" ] && [ "$2" = "inspect" ]; then',
      '  ref="$3"',
      '  case ":${FAKE_DOCKER_EXISTS_REFS}:" in',
      '    *":$ref:"*) exit 0 ;;',
      "    *) exit 1 ;;",
      "  esac",
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

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

  // ── Network access toggle validation ────────────────────────────────────

  it("accepts a spec with no access field — a rerun must not rewrite exposure", () => {
    const input = makeValidSpec();
    delete (input as Record<string, unknown>).access;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts a complete toggle record", () => {
    const input = makeValidSpec({
      access: {
        networkAccess: true,
        assistantDirect: false,
        guardianNetwork: false,
        guardianOpenaiApi: false,
      },
    });
    expect(validateSetupSpec(input).valid).toBe(true);
  });

  it("accepts a PARTIAL record — anything absent is closed, so there is nothing to reject", () => {
    expect(validateSetupSpec(makeValidSpec({ access: { networkAccess: true } })).valid).toBe(true);
    expect(validateSetupSpec(makeValidSpec({ access: {} })).valid).toBe(true);
  });

  it("rejects a non-object access", () => {
    const result = validateSetupSpec(makeValidSpec({ access: "home" }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("access must be an object");
  });

  it("rejects a non-boolean toggle", () => {
    const result = validateSetupSpec(makeValidSpec({ access: { networkAccess: "yes" } }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("access.networkAccess must be a boolean");
  });

  it("rejects an unknown toggle rather than silently ignoring it", () => {
    // A typo must not read as "closed" — that would silently under-expose.
    const result = validateSetupSpec(makeValidSpec({ access: { netwrokAccess: true } }));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("netwrokAccess");
  });

});

// ── Tests: buildOwnerEnvFromSetup ─────────────────────────────────────────

describe("buildOwnerEnvFromSetup", () => {
  it("does not include UI login password", () => {
    const spec = makeValidSpec();
    const env = buildOwnerEnvFromSetup(spec.owner);
    expect(env.OP_UI_LOGIN_PASSWORD).toBeUndefined();
    expect(env.OP_UI_TOKEN).toBeUndefined();
  });

  it("does not include SYSTEM_LLM_* vars", () => {
    const spec = makeValidSpec();
    const env = buildOwnerEnvFromSetup(spec.owner);
    expect(env.SYSTEM_LLM_PROVIDER).toBeUndefined();
    expect(env.SYSTEM_LLM_MODEL).toBeUndefined();
    expect(env.SYSTEM_LLM_BASE_URL).toBeUndefined();
  });

  it("sets owner info when provided", () => {
    const spec = makeValidSpec();
    const env = buildOwnerEnvFromSetup(spec.owner);
    expect(env.OP_OWNER_NAME).toBe("Test User");
    expect(env.OP_OWNER_EMAIL).toBe("test@example.com");
  });

  it("omits owner info when empty", () => {
    const env = buildOwnerEnvFromSetup({ name: "", email: "" });
    expect(env.OP_OWNER_NAME).toBeUndefined();
    expect(env.OP_OWNER_EMAIL).toBeUndefined();
  });

  it("does NOT include provider API keys", () => {
    // Provider API keys now live in OpenCode's auth.json — buildOwnerEnvFromSetup
    // returns only non-credential vars. See buildAuthJsonFromSetup for the key flow.
    const spec = makeValidSpec();
    const env = buildOwnerEnvFromSetup(spec.owner);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
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


// ── Tests: persistAkmConfig (typed merge) ─────────────────────────────────

describe("persistAkmConfig", () => {
  let dir: string;
  let configDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openpalm-akmcfg-"));
    configDir = join(dir, "config");
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const stateFor = (): ControlPlaneState => ({ configDir } as unknown as ControlPlaneState);
  const cfgPath = () => join(configDir, "akm", "config.json");

  it("writes the canonical typed shape for llm + embedding", () => {
    persistAkmConfig(stateFor(), {
      llm: { provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com" },
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dims: 1536,
        baseUrl: "https://api.openai.com",
      },
    });
    const cfg = JSON.parse(readFileSync(cfgPath(), "utf-8"));
    expect(cfg.profiles.llm.default).toEqual({
      endpoint: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o",
      provider: "openai",
    });
    expect(cfg.defaults.llm).toBe("default");
    expect(cfg.embedding).toEqual({
      endpoint: "https://api.openai.com/v1/embeddings",
      model: "text-embedding-3-small",
      provider: "openai",
      dimension: 1536,
    });
    expect(cfg.stashDir).toBe("/stash");
    expect(cfg.llm).toBeUndefined();
  });

  it("round-trips: re-running over its own output is idempotent", () => {
    const opts = {
      llm: { provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com" },
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dims: 1536,
        baseUrl: "https://api.openai.com",
      },
    };
    persistAkmConfig(stateFor(), opts);
    const first = readFileSync(cfgPath(), "utf-8");
    persistAkmConfig(stateFor(), opts);
    expect(readFileSync(cfgPath(), "utf-8")).toBe(first);
  });

  it("preserves existing user keys and nested profile/defaults fields", () => {
    mkdirSync(join(configDir, "akm"), { recursive: true });
    writeFileSync(
      cfgPath(),
      JSON.stringify({
        customUserKey: "keep-me",
        sources: [{ name: "host-akm" }],
        profiles: { llm: { default: { temperature: 0.7 }, alt: { model: "x" } } },
        defaults: { embedding: "myembed" },
      }),
    );
    persistAkmConfig(stateFor(), {
      llm: { provider: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434" },
    });
    const cfg = JSON.parse(readFileSync(cfgPath(), "utf-8"));
    // Untouched user keys survive the merge.
    expect(cfg.customUserKey).toBe("keep-me");
    expect(cfg.sources).toEqual([{ name: "host-akm" }]);
    // Sibling profile and pre-existing default fields are preserved.
    expect(cfg.profiles.llm.alt).toEqual({ model: "x" });
    expect(cfg.profiles.llm.default.temperature).toBe(0.7);
    // New llm values merge into profiles.llm.default.
    expect(cfg.profiles.llm.default.model).toBe("llama3.2");
    expect(cfg.profiles.llm.default.provider).toBe("ollama");
    // Existing defaults key survives; defaults.llm is added.
    expect(cfg.defaults.embedding).toBe("myembed");
    expect(cfg.defaults.llm).toBe("default");
  });

  it("does nothing when neither llm nor embedding is provided", () => {
    persistAkmConfig(stateFor(), {});
    expect(existsSync(cfgPath())).toBe(false);
  });

  it("drops a legacy top-level llm key on write", () => {
    mkdirSync(join(configDir, "akm"), { recursive: true });
    writeFileSync(cfgPath(), JSON.stringify({ llm: { endpoint: "legacy", model: "old" } }));
    persistAkmConfig(stateFor(), {
      llm: { provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com" },
    });
    const cfg = JSON.parse(readFileSync(cfgPath(), "utf-8"));
    expect(cfg.llm).toBeUndefined();
  });
});

// ── Tests: seedDefaultAutomation ──────────────────────────────────────────

describe("seedDefaultAutomation", () => {
  let dir: string;
  let skeletonDir: string;
  let opHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openpalm-seed-"));
    skeletonDir = join(dir, "skeleton");
    opHome = join(dir, "ophome");
    mkdirSync(skeletonDir, { recursive: true });
    mkdirSync(join(opHome, "knowledge"), { recursive: true });

    saved.OPENPALM_SKELETON_DIR = process.env.OPENPALM_SKELETON_DIR;
    saved.OPENPALM_REPO_ROOT = process.env.OPENPALM_REPO_ROOT;
    saved.OP_HOME = process.env.OP_HOME;
    // Pin the registry lookup at our temp skeleton so the real repo skeleton
    // (source-relative fallback) can't leak a real akm-improve.yml into tests.
    delete process.env.OPENPALM_REPO_ROOT;
    process.env.OPENPALM_SKELETON_DIR = skeletonDir;
    process.env.OP_HOME = opHome;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const stateFor = (stash: string): ControlPlaneState =>
    ({ stashDir: stash } as unknown as ControlPlaneState);

  const seedRegistry = (content: string) => {
    mkdirSync(join(skeletonDir, "knowledge", "tasks"), { recursive: true });
    writeFileSync(join(skeletonDir, "knowledge", "tasks", "akm-improve.yml"), content);
  };

  it("writes akm-improve.yml when it is missing", () => {
    seedRegistry("schedule: daily\n");
    const stash = join(dir, "stash1");
    mkdirSync(stash, { recursive: true });
    seedDefaultAutomation(stateFor(stash));
    expect(readFileSync(join(stash, "tasks", "akm-improve.yml"), "utf-8")).toBe("schedule: daily\n");
  });

  it("does NOT overwrite an existing akm-improve.yml (user edits survive)", () => {
    seedRegistry("schedule: from-registry\n");
    const stash = join(dir, "stash2");
    mkdirSync(join(stash, "tasks"), { recursive: true });
    writeFileSync(join(stash, "tasks", "akm-improve.yml"), "schedule: user-edited\n");
    seedDefaultAutomation(stateFor(stash));
    expect(readFileSync(join(stash, "tasks", "akm-improve.yml"), "utf-8")).toBe(
      "schedule: user-edited\n",
    );
  });

  it("does nothing when the registry has no akm-improve automation", () => {
    const stash = join(dir, "stash3");
    mkdirSync(stash, { recursive: true });
    seedDefaultAutomation(stateFor(stash));
    expect(existsSync(join(stash, "tasks", "akm-improve.yml"))).toBe(false);
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
    mkdirSync(join(homeDir, "state"), { recursive: true });
    writeFileSync(
      join(homeDir, "state", "stack.env"),
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

    // E1: point OP_DOCKER_BIN at a fake docker so the blank-imageTag pin's
    // `dockerManifestExists` probe never hits a real registry. Unset
    // FAKE_DOCKER_EXISTS_REFS (the default) means "nothing published" — the
    // pre-E1 behavior every existing test below still expects.
    savedEnv.OP_DOCKER_BIN = process.env.OP_DOCKER_BIN;
    savedEnv.OP_IMAGE_NAMESPACE = process.env.OP_IMAGE_NAMESPACE;
    savedEnv.FAKE_DOCKER_EXISTS_REFS = process.env.FAKE_DOCKER_EXISTS_REFS;
    delete process.env.OP_IMAGE_NAMESPACE;
    delete process.env.FAKE_DOCKER_EXISTS_REFS;
    process.env.OP_DOCKER_BIN = writeFakeDockerBin(homeDir);
  });

  afterEach(() => {
    process.env.OP_HOME = savedEnv.OP_HOME;
    if (savedEnv.OP_DOCKER_BIN === undefined) delete process.env.OP_DOCKER_BIN;
    else process.env.OP_DOCKER_BIN = savedEnv.OP_DOCKER_BIN;
    if (savedEnv.OP_IMAGE_NAMESPACE === undefined) delete process.env.OP_IMAGE_NAMESPACE;
    else process.env.OP_IMAGE_NAMESPACE = savedEnv.OP_IMAGE_NAMESPACE;
    if (savedEnv.FAKE_DOCKER_EXISTS_REFS === undefined) delete process.env.FAKE_DOCKER_EXISTS_REFS;
    else process.env.FAKE_DOCKER_EXISTS_REFS = savedEnv.FAKE_DOCKER_EXISTS_REFS;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("returns an error for invalid input", async () => {
    const result = await performSetup(
      { security: { uiLoginPassword: "short" } } as SetupSpec
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  // ── Per-image version reconcile (A1: stop preserving a stale pinned tag) ──
  // state/stack.env is the one env file, and the sole pin location.
  const stateEnvPath = () => join(homeDir, "state", "stack.env");

  it("blank imageTag RESETS stale per-image version pins to the moving default (latest)", async () => {
    // Simulate an OP_HOME carrying now-stale per-image version pins.
    writeFileSync(
      stateEnvPath(),
      [
        "OP_SETUP_COMPLETE=false",
        "OP_ASSISTANT_VERSION=v0.11.1",
        "OP_GUARDIAN_VERSION=v0.11.1",
        "",
      ].join("\n"),
    );
    const result = await performSetup(makeValidSpec()); // no imageTag => blank
    expect(result.ok).toBe(true);
    const env = readFileSync(stateEnvPath(), "utf-8");
    // Each image rides its own OP_*_VERSION var (no single OP_IMAGE_TAG cascade).
    expect(env).toMatch(/^OP_ASSISTANT_VERSION=latest$/m);
    expect(env).toMatch(/^OP_GUARDIAN_VERSION=latest$/m);
    expect(env).not.toMatch(/_VERSION=v0\.11\.1/);
  });

  it("a non-empty imageTag pins every per-image version deliberately (kept verbatim)", async () => {
    const result = await performSetup(makeValidSpec({ imageTag: "v0.11.1" }));
    expect(result.ok).toBe(true);
    const env = readFileSync(stateEnvPath(), 'utf-8');
    expect(env).toMatch(/^OP_ASSISTANT_VERSION=v0\.11\.1$/m);
    expect(env).toMatch(/^OP_GUARDIAN_VERSION=v0\.11\.1$/m);
    expect(env).toMatch(/^OP_PORTAL_VERSION=v0\.11\.1$/m);
    expect(env).toMatch(/^OP_VOICE_VERSION=v0\.11\.1$/m);
  });

  it("imageTag is trimmed before writing", async () => {
    const result = await performSetup(makeValidSpec({ imageTag: "  dev  " }));
    expect(result.ok).toBe(true);
    const env = readFileSync(stateEnvPath(), 'utf-8');
    expect(env).toMatch(/^OP_ASSISTANT_VERSION=dev$/m);
  });

  it("fresh install with blank imageTag writes per-image versions = latest", async () => {
    // beforeEach's stub stack.env has no per-image version pins.
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);
    const env = readFileSync(stateEnvPath(), 'utf-8');
    expect(env).toMatch(/^OP_ASSISTANT_VERSION=latest$/m);
  });

  it("records an explicit imageTag as a pin on every per-image key", async () => {
    const result = await performSetup(makeValidSpec({ imageTag: "v0.11.1" }));
    expect(result.ok).toBe(true);
    const env = readFileSync(stateEnvPath(), 'utf-8');
    for (const key of ["ASSISTANT", "GUARDIAN", "PORTAL", "VOICE"]) {
      expect(env).toMatch(new RegExp(`^OP_${key}_VERSION=v0\\.11\\.1$`, 'm'));
    }
  });

  // ── E1: blank imageTag pins to PLATFORM_VERSION when the image is
  // actually published, guarded by dockerManifestExists, excluding voice. ──

  it("blank imageTag pins assistant/guardian/portal to PLATFORM_VERSION when the image exists (voice excluded)", async () => {
    process.env.FAKE_DOCKER_EXISTS_REFS = `openpalm/assistant:${PLATFORM_VERSION}`;
    const result = await performSetup(makeValidSpec()); // no imageTag => blank
    expect(result.ok).toBe(true);
    const env = readFileSync(stateEnvPath(), "utf-8");
    expect(env).toMatch(new RegExp(`^OP_ASSISTANT_VERSION=${reEscape(PLATFORM_VERSION)}$`, "m"));
    expect(env).toMatch(new RegExp(`^OP_GUARDIAN_VERSION=${reEscape(PLATFORM_VERSION)}$`, "m"));
    expect(env).toMatch(new RegExp(`^OP_PORTAL_VERSION=${reEscape(PLATFORM_VERSION)}$`, "m"));
    // Voice tags are latest-cpu/vX.Y.Z-cu121, not platform semver — never pinned by this path.
    expect(env).toMatch(/^OP_VOICE_VERSION=latest$/m);
  });

  it("blank imageTag falls back to latest when dockerManifestExists reports the image absent", async () => {
    // FAKE_DOCKER_EXISTS_REFS left unset by beforeEach => manifest never found
    // (e.g. a host-only "unit=platform" release with no matching image tag).
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);
    const env = readFileSync(stateEnvPath(), "utf-8");
    expect(env).toMatch(/^OP_ASSISTANT_VERSION=latest$/m);
    expect(env).toMatch(/^OP_GUARDIAN_VERSION=latest$/m);
    expect(env).toMatch(/^OP_PORTAL_VERSION=latest$/m);
    expect(env).toMatch(/^OP_VOICE_VERSION=latest$/m);
  });

  it("blank imageTag pin check honors OP_IMAGE_NAMESPACE (does not hardcode openpalm/)", async () => {
    process.env.OP_IMAGE_NAMESPACE = "customns";
    // Only the customns-namespaced ref "exists" — if the check hardcoded
    // "openpalm/" it would miss this and wrongly fall back to latest.
    process.env.FAKE_DOCKER_EXISTS_REFS = `customns/assistant:${PLATFORM_VERSION}`;
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);
    const env = readFileSync(stateEnvPath(), "utf-8");
    expect(env).toMatch(new RegExp(`^OP_ASSISTANT_VERSION=${reEscape(PLATFORM_VERSION)}$`, "m"));
  });

  it("writes the UI login password to its secret file (private/secrets — §G1 delegated)", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    expect(readSecret(homeDir, 'op_ui_login_password')).toBe("test-admin-token-12345\n");
  });

  it("P1-1: an omitted uiLoginPassword on a rerun PRESERVES the existing secret byte-identically", async () => {
    // First install sets the password.
    expect((await performSetup(makeValidSpec())).ok).toBe(true);
    const before = readSecret(homeDir, 'op_ui_login_password');
    expect(before).toBe("test-admin-token-12345\n");

    // Rerun with the password omitted (unchanged rerun) must not rotate it.
    const rerun = makeValidSpec();
    (rerun as { security: { uiLoginPassword?: string } }).security = {};
    const result = await performSetup(rerun);
    expect(result.ok).toBe(true);
    expect(readSecret(homeDir, 'op_ui_login_password')).toBe(before);
  });

  it("P1-1: an omitted uiLoginPassword with NO existing secret fails closed", async () => {
    const fresh = makeValidSpec();
    (fresh as { security: { uiLoginPassword?: string } }).security = {};
    const result = await performSetup(fresh);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/uiLoginPassword/);
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

  it("writes core compose file to stack/", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    // applyInstall should have written the compose file to stack/ (not config/components/)
    const stagedCompose = join(homeDir, "config", "stack", "core.compose.yml");
    expect(existsSync(stagedCompose)).toBe(true);
  });

  it("writes akm config.json with ollama llm settings", async () => {
    const input = makeValidSpec({
      llm: { provider: "ollama", model: "llama3.2", baseUrl: "http://localhost:11434" },
      embedding: { provider: "ollama", model: "nomic-embed-text", dims: 768, baseUrl: "http://localhost:11434" },
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
    expect(config.embedding.endpoint).toBe("http://localhost:11434/v1/embeddings");
    expect(config.embedding.dimension).toBe(768);
  });

  it("canonicalizes OpenAI-style setup base URLs to v1 endpoints", async () => {
    const input = makeValidSpec({
      llm: { provider: "openai", model: "gpt-4o", baseUrl: "https://api.openai.com" },
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dims: 1536,
        baseUrl: "https://api.openai.com",
      },
    });

    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    const akmConfigPath = join(homeDir, "config", "akm", "config.json");
    const config = JSON.parse(readFileSync(akmConfigPath, "utf-8"));
    expect(config.profiles.llm.default.endpoint).toBe("https://api.openai.com/v1/chat/completions");
    expect(config.embedding.endpoint).toBe("https://api.openai.com/v1/embeddings");
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
      expect(readFileSync(join(homeDir, "state", "stack.env"), "utf-8")).toContain(
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

  it("enables sharing even when host has no akm config (profile import silently skipped)", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "openpalm-fakehome-"));
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      // ~/akm and ~/.config/akm/config.json both absent on host — profile import skipped.
      const result = await performSetup(makeValidSpec({ hostAkm: true }));
      expect(result.ok).toBe(true);
      // Source entry always present (written unconditionally).
      const opCfg = JSON.parse(readFileSync(join(homeDir, "config", "akm", "config.json"), "utf-8"));
      expect((opCfg.sources ?? []).some((s: { name?: string }) => s.name === "host-akm")).toBe(true);
      // OP_HOST_AKM_STASH set (compose mount active; falls back to empty dir since ~/akm absent).
      expect(readFileSync(join(homeDir, "state", "stack.env"), "utf-8")).toContain("OP_HOST_AKM_STASH=");
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("does not create a stack.yml (addon state lives in stack.env)", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);
    expect(existsSync(join(stackDir, "stack.yml"))).toBe(false);
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

    const stackEnv = readFileSync(join(homeDir, "state", "stack.env"), 'utf-8');
    expect(stackEnv).not.toContain('OPENAI_API_KEY=');
    expect(readSecret(homeDir, 'openai_api_key')).toBeNull();

    const authJson = JSON.parse(readFileSync(join(homeDir, "knowledge", "secrets", "auth.json"), 'utf-8')) as Record<string, { key: string }>;
    expect(authJson.openai.key).toBe('sk-secondary');
  });

  it("splits channel credentials between secret files and stack.env", async () => {
    const input = makeValidSpec({
      portalCredentials: {
        discord: {
          botToken: "discord-bot-token-xyz",
          applicationId: "discord-app-id-123",
        },
      },
    });

    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    expect(readSecret(homeDir, 'discord_bot_token')).toBe("discord-bot-token-xyz\n");
    expect(readSecret(homeDir, 'discord_application_id')).toBeNull();
    const stackEnv = readFileSync(join(homeDir, "state", "stack.env"), 'utf-8');
    expect(stackEnv).toContain('DISCORD_APPLICATION_ID=discord-app-id-123');
    expect(stackEnv).not.toContain('DISCORD_BOT_TOKEN=');
  });

  // PR #564 second retest R6: an EXPLICIT {addon:false} must disable an existing
  // addon — the old `if (enabled)` loop skipped false, leaving it enabled.
  it("disables an existing addon when the rerun spec sets it false", async () => {
    const enabledAddonsLine = (): string =>
      readFileSync(join(homeDir, "state", "stack.env"), 'utf-8')
        .split('\n')
        .find((l) => l.startsWith('OP_ENABLED_ADDONS=')) ?? '';

    // First enable discord.
    const enable = await performSetup(makeValidSpec({
      addons: { discord: true },
      portalCredentials: { discord: { botToken: "discord-bot-token-xyz" } },
    }));
    expect(enable.ok).toBe(true);
    expect(enabledAddonsLine()).toContain('discord');

    // Rerun with discord:false — it must be removed from the enabled set.
    const disable = await performSetup(makeValidSpec({ addons: { discord: false } }));
    expect(disable.ok).toBe(true);
    expect(enabledAddonsLine()).not.toContain('discord');
  });

  // PR #564 second retest P1-3: setup must NOT consume ambient host env vars as
  // portal credentials — a leftover DISCORD_BOT_TOKEN in the operator's shell
  // used to be silently written into the secret store, overriding keep-existing.
  it("does not consume an ambient DISCORD_BOT_TOKEN when the spec omits it", async () => {
    const saved = process.env.DISCORD_BOT_TOKEN;
    process.env.DISCORD_BOT_TOKEN = "ambient-token-should-be-ignored";
    try {
      const input = makeValidSpec(); // no portalCredentials in the spec
      const result = await performSetup(input);
      expect(result.ok).toBe(true);
      // The ambient value must NOT have been written to the secret store.
      expect(readSecret(homeDir, 'discord_bot_token')).toBeNull();
    } finally {
      if (saved !== undefined) process.env.DISCORD_BOT_TOKEN = saved;
      else delete process.env.DISCORD_BOT_TOKEN;
    }
  });

  // ── #563 T23-T27: network preset plumbing through performSetup ───────────

  // §G1: op_opencode_password is a delegated secret — secretPath() routes it
  // (and every other delegated name) to private/secrets/, not knowledge/secrets/.
  const secretPathFor = (name: string) => secretPath(homeDir, name);

  it("networkAccess publishes ONLY the UI — OpenCode stays loopback", async () => {
    const result = await performSetup(makeValidSpec({ access: { networkAccess: true } }));
    expect(result.ok).toBe(true);

    const stackEnv = readFileSync(join(homeDir, "state", "stack.env"), "utf-8");
    expect(stackEnv).toMatch(/^OP_UI_BIND_ADDRESS=0\.0\.0\.0$/m);
    expect(stackEnv).toMatch(/^OP_ASSISTANT_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(stackEnv).toMatch(/^OPENCODE_AUTH=false$/m);
  });

  it("assistantDirect turns auth on and GENERATES the key — never asks for one", async () => {
    const result = await performSetup(makeValidSpec({ access: { assistantDirect: true } }));
    expect(result.ok).toBe(true);

    const stackEnv = readFileSync(join(homeDir, "state", "stack.env"), "utf-8");
    expect(stackEnv).toMatch(/^OP_ASSISTANT_BIND_ADDRESS=0\.0\.0\.0$/m);
    expect(stackEnv).toMatch(/^OPENCODE_AUTH=true$/m);

    const key = readSecret(homeDir, "op_opencode_password")?.trim();
    expect(key).toBeTruthy();
    expect((key ?? "").length).toBeGreaterThanOrEqual(32);
    // The generated key never lands in the non-secret env file.
    expect(stackEnv).not.toContain(key ?? "unreachable");
  });

  it("preserves an existing assistant key across a rerun — rotating it would break every client", async () => {
    expect((await performSetup(makeValidSpec({ access: { assistantDirect: true } }))).ok).toBe(true);
    const first = readSecret(homeDir, "op_opencode_password");
    expect((await performSetup(makeValidSpec({ access: { assistantDirect: true } }))).ok).toBe(true);
    expect(readSecret(homeDir, "op_opencode_password")).toBe(first);
  });

  it("writes every managed bind explicitly, so switching combinations always converges", async () => {
    expect((await performSetup(makeValidSpec({ access: { networkAccess: true, guardianNetwork: true } }))).ok).toBe(true);
    // Now turn everything back off — the previously-open binds must close.
    expect((await performSetup(makeValidSpec({ access: {} }))).ok).toBe(true);

    const stackEnv = readFileSync(join(homeDir, "state", "stack.env"), "utf-8");
    for (const key of ["OP_UI_BIND_ADDRESS", "OP_ASSISTANT_BIND_ADDRESS", "OP_GUARDIAN_BIND_ADDRESS", "OP_API_BIND_ADDRESS"]) {
      expect(stackEnv).toMatch(new RegExp(`^${key}=127\\.0\\.0\\.1$`, "m"));
    }
  });

  it("publishing the guardian auto-enables the chat portal, so the front door actually exists", async () => {
    // The guardian is profile-gated behind ingress addons; a bind alone
    // deploys nothing for the published port to reach.
    const result = await performSetup(makeValidSpec({ access: { guardianNetwork: true } }));
    expect(result.ok).toBe(true);

    const stateEnv = readFileSync(stateEnvPath(), "utf-8");
    expect(stateEnv).toMatch(/^OP_ENABLED_ADDONS=.*\bchat\b/m);
  });

  it("does NOT add chat when another guardian-ingress addon is already requested", async () => {
    const result = await performSetup(
      makeValidSpec({ access: { guardianNetwork: true }, addons: { discord: true } }),
    );
    expect(result.ok).toBe(true);

    const stateEnv = readFileSync(stateEnvPath(), "utf-8");
    expect(stateEnv).not.toMatch(/^OP_ENABLED_ADDONS=.*\bchat\b/m);
  });

  it("publishing the OpenAI edge enables the api portal that serves it", async () => {
    // `guardianOpenaiApi` publishes :8182 specifically, which only exists when
    // the `api` addon is on. The api portal used to be pinned enabled, so this
    // could never be wrong; it is an ordinary capability toggle now.
    const result = await performSetup(makeValidSpec({ access: { guardianOpenaiApi: true } }));
    expect(result.ok).toBe(true);

    const stateEnv = readFileSync(stateEnvPath(), "utf-8");
    expect(stateEnv).toMatch(/^OP_ENABLED_ADDONS=.*\bapi\b/m);
    // The generic guardian fallback must not ALSO fire — `api` is ingress.
    expect(stateEnv).not.toMatch(/^OP_ENABLED_ADDONS=.*\bchat\b/m);
  });

  it("does not resurrect an api portal the same run explicitly turned off", async () => {
    const result = await performSetup(
      makeValidSpec({ access: { guardianOpenaiApi: true }, addons: { api: true } }),
    );
    expect(result.ok).toBe(true);
    expect(readFileSync(stateEnvPath(), "utf-8")).toMatch(/^OP_ENABLED_ADDONS=.*\bapi\b/m);
  });

  it("a UI-only toggle does not auto-enable any addon", async () => {
    const result = await performSetup(makeValidSpec({ access: { networkAccess: true } }));
    expect(result.ok).toBe(true);

    const stateEnv = existsSync(stateEnvPath()) ? readFileSync(stateEnvPath(), "utf-8") : "";
    expect(stateEnv).not.toMatch(/^OP_ENABLED_ADDONS=.*\bchat\b/m);
    expect(stateEnv).not.toMatch(/^OP_ENABLED_ADDONS=.*\bapi\b/m);
  });

  it("a spec without access leaves pre-seeded bind values untouched", async () => {
    const stackEnvPath = join(homeDir, "state", "stack.env");
    writeFileSync(
      stackEnvPath,
      `${readFileSync(stackEnvPath, "utf-8")}\nOP_ASSISTANT_BIND_ADDRESS=10.0.0.5\n`,
    );

    const input = makeValidSpec();
    delete (input as Record<string, unknown>).access;
    expect((await performSetup(input)).ok).toBe(true);

    expect(readFileSync(stackEnvPath, "utf-8")).toMatch(/^OP_ASSISTANT_BIND_ADDRESS=10\.0\.0\.5$/m);
  });

  it("T27: every setup materializes the op_opencode_password secret file", async () => {
    const input = makeValidSpec();
    delete (input as Record<string, unknown>).network;
    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    const path = secretPathFor("op_opencode_password");
    expect(existsSync(path)).toBe(true);
    expect((statSync(path).mode & 0o777)).toBe(0o600);
    expect(readFileSync(path, "utf-8").trim().length).toBeGreaterThan(0);
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
