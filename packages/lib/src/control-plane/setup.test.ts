import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
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

  // ── #563 T19-T22: network preset validation ─────────────────────────────

  it("T19 (pin): accepts a spec without network (backward compatible)", () => {
    const input = makeValidSpec();
    delete (input as Record<string, unknown>).network;
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("T20: accepts network {preset:'this-pc'}", () => {
    const input = makeValidSpec({ network: { preset: "this-pc" } });
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(true);
  });

  it("T20: rejects an unknown preset", () => {
    const input = makeValidSpec();
    (input as Record<string, unknown>).network = { preset: "bogus-preset" };
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("network"))).toBe(true);
  });

  it("T20: rejects a non-object network", () => {
    const input = makeValidSpec();
    (input as Record<string, unknown>).network = "this-pc";
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("network"))).toBe(true);
  });

  it("T21: home-password requires opencodePassword (min 8 chars) — missing", () => {
    const input = makeValidSpec();
    (input as Record<string, unknown>).network = { preset: "home-password" };
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("network.opencodePassword"))).toBe(true);
  });

  it("T21: home-password requires opencodePassword (min 8 chars) — empty", () => {
    const input = makeValidSpec();
    (input as Record<string, unknown>).network = { preset: "home-password", opencodePassword: "" };
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("network.opencodePassword"))).toBe(true);
  });

  it("T21: home-password requires opencodePassword (min 8 chars) — 7-char", () => {
    const input = makeValidSpec();
    (input as Record<string, unknown>).network = { preset: "home-password", opencodePassword: "1234567" };
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("network.opencodePassword"))).toBe(true);
  });

  it("T21: an 8-char opencodePassword on home-password is valid", () => {
    const input = makeValidSpec();
    (input as Record<string, unknown>).network = { preset: "home-password", opencodePassword: "12345678" };
    const result = validateSetupSpec(input);
    expect(result.valid).toBe(true);
  });

  it("T22: rejects opencodePassword on non-password presets, naming the preset", () => {
    for (const preset of ["this-pc", "home-open", "shared-guardian"]) {
      const input = makeValidSpec();
      (input as Record<string, unknown>).network = { preset, opencodePassword: "12345678" };
      const result = validateSetupSpec(input);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes(preset))).toBe(true);
    }
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
    writeFileSync(
      join(homeDir, "knowledge", "env", "stack.env"),
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
  });

  afterEach(() => {
    process.env.OP_HOME = savedEnv.OP_HOME;
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
  // state/stack.state.env is the SOLE pin location (1.4): setup must never write
  // OP_*_VERSION into the legacy knowledge/env/stack.env, only into state/.
  const legacyStackEnvPath = () => join(homeDir, "knowledge", "env", "stack.env");
  const stateEnvPath = () => join(homeDir, "state", "stack.state.env");

  it("blank imageTag RESETS stale per-image version pins to the moving default (latest)", async () => {
    // Simulate an old OP_HOME whose legacy stack.env pinned now-stale per-image
    // versions (pre-1.4 installs wrote pins there).
    writeFileSync(
      legacyStackEnvPath(),
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

  it("never writes OP_*_VERSION into the legacy knowledge/env/stack.env (state/ is the sole pin authority)", async () => {
    const result = await performSetup(makeValidSpec({ imageTag: "v0.11.1" }));
    expect(result.ok).toBe(true);
    const legacy = readFileSync(legacyStackEnvPath(), 'utf-8');
    expect(legacy).not.toMatch(/OP_(ASSISTANT|GUARDIAN|PORTAL|VOICE)_VERSION=/);
  });

  it("writes the UI login password to knowledge/secrets", async () => {
    const result = await performSetup(makeValidSpec());
    expect(result.ok).toBe(true);

    expect(readSecret(homeDir, 'op_ui_login_password')).toBe("test-admin-token-12345\n");
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
      expect(readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8")).toContain(
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
      expect(readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8")).toContain("OP_HOST_AKM_STASH=");
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

    const stackEnv = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), 'utf-8');
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
    const stackEnv = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), 'utf-8');
    expect(stackEnv).toContain('DISCORD_APPLICATION_ID=discord-app-id-123');
    expect(stackEnv).not.toContain('DISCORD_BOT_TOKEN=');
  });

  // ── #563 T23-T27: network preset plumbing through performSetup ───────────

  const secretPathFor = (name: string) => join(homeDir, "knowledge", "secrets", name);

  it("T23: home-password writes the full managed row to stack.env and the password to the secret file", async () => {
    const result = await performSetup(
      makeValidSpec({ network: { preset: "home-password", opencodePassword: "lan-secret-123" } }),
    );
    expect(result.ok).toBe(true);

    const stackEnv = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackEnv).toMatch(/^OP_ASSISTANT_BIND_ADDRESS=0\.0\.0\.0$/m);
    expect(stackEnv).toMatch(/^OPENCODE_AUTH=true$/m);
    expect(stackEnv).toMatch(/^OP_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(stackEnv).toMatch(/^OP_CLIENT_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(stackEnv).toMatch(/^OP_VOICE_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(stackEnv).not.toContain("lan-secret-123");

    expect(readSecret(homeDir, "op_opencode_password")).toBe("lan-secret-123\n");
  });

  it("T24: shared-guardian writes the guardian row with the assistant hard-pin", async () => {
    const result = await performSetup(makeValidSpec({ network: { preset: "shared-guardian" } }));
    expect(result.ok).toBe(true);

    const stackEnv = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8");
    expect(stackEnv).toMatch(/^OP_BIND_ADDRESS=0\.0\.0\.0$/m);
    expect(stackEnv).toMatch(/^OP_ASSISTANT_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(stackEnv).toMatch(/^OP_CLIENT_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(stackEnv).toMatch(/^OP_VOICE_BIND_ADDRESS=127\.0\.0\.1$/m);
    expect(stackEnv).toMatch(/^OPENCODE_AUTH=false$/m);
  });

  it("T24b: shared-guardian auto-enables the chat portal so a guardian actually deploys (PR #564 review)", async () => {
    // The guardian service is profile-gated behind guardian-ingress addons;
    // binds alone deploy no guardian. The preset's promise ("guardian
    // protected front door", pairing) requires one, so a shared-guardian
    // setup with no guardian-ingress addon enables the built-in chat portal.
    const result = await performSetup(makeValidSpec({ network: { preset: "shared-guardian" } }));
    expect(result.ok).toBe(true);

    const stateEnv = readFileSync(join(homeDir, "state", "stack.state.env"), "utf-8");
    expect(stateEnv).toMatch(/^OP_ENABLED_ADDONS=.*\bchat\b/m);
  });

  it("T24c: shared-guardian does NOT add chat when another guardian-ingress addon is already requested", async () => {
    const result = await performSetup(
      makeValidSpec({ network: { preset: "shared-guardian" }, addons: { discord: true } }),
    );
    expect(result.ok).toBe(true);

    const stateEnv = readFileSync(join(homeDir, "state", "stack.state.env"), "utf-8");
    expect(stateEnv).toMatch(/^OP_ENABLED_ADDONS=.*\bdiscord\b/m);
    expect(stateEnv).not.toMatch(/^OP_ENABLED_ADDONS=.*\bchat\b/m);
  });

  it("T24d: non-guardian presets do not auto-enable any addon", async () => {
    const result = await performSetup(makeValidSpec({ network: { preset: "home-open" } }));
    expect(result.ok).toBe(true);

    const stateEnvPath = join(homeDir, "state", "stack.state.env");
    const stateEnv = existsSync(stateEnvPath) ? readFileSync(stateEnvPath, "utf-8") : "";
    expect(stateEnv).not.toMatch(/^OP_ENABLED_ADDONS=.*\bchat\b/m);
  });

  it("T25: a spec without network leaves pre-seeded bind values untouched", async () => {
    // Seed a pre-existing OP_ASSISTANT_BIND_ADDRESS before running a
    // network-less setup — it must survive (D7: absent network = don't touch).
    const stackEnvPath = join(homeDir, "knowledge", "env", "stack.env");
    writeFileSync(
      stackEnvPath,
      `${readFileSync(stackEnvPath, "utf-8")}\nOP_ASSISTANT_BIND_ADDRESS=10.0.0.5\n`,
    );

    const input = makeValidSpec();
    delete (input as Record<string, unknown>).network;
    const result = await performSetup(input);
    expect(result.ok).toBe(true);

    const stackEnv = readFileSync(stackEnvPath, "utf-8");
    expect(stackEnv).toMatch(/^OP_ASSISTANT_BIND_ADDRESS=10\.0\.0\.5$/m);
  });

  it("T26: shared-guardian fails closed when process.env exposes the assistant", async () => {
    const saved = process.env.OP_ASSISTANT_BIND_ADDRESS;
    process.env.OP_ASSISTANT_BIND_ADDRESS = "0.0.0.0";
    try {
      const result = await performSetup(makeValidSpec({ network: { preset: "shared-guardian" } }));
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error ?? "").toContain("OP_ASSISTANT_BIND_ADDRESS");

      // Never wrote the shared-guardian row over the fail-closed rejection.
      const stackEnv = readFileSync(join(homeDir, "knowledge", "env", "stack.env"), "utf-8");
      expect(stackEnv).not.toMatch(/^OP_BIND_ADDRESS=0\.0\.0\.0$/m);
    } finally {
      if (saved === undefined) delete process.env.OP_ASSISTANT_BIND_ADDRESS;
      else process.env.OP_ASSISTANT_BIND_ADDRESS = saved;
    }
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
