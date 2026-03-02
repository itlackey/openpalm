/**
 * Tests for secrets.ts — secrets/connections CRUD, masking, OpenCode config.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync
} from "node:fs";
import { join } from "node:path";

import {
  ensureSecrets,
  updateSecretsEnv,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  maskConnectionValue,
  ensureOpenCodeConfig,
  ALLOWED_CONNECTION_KEYS,
  REQUIRED_LLM_PROVIDER_KEYS,
  PLAIN_CONFIG_KEYS
} from "./secrets.js";
import type { ControlPlaneState } from "./types.js";
import { makeTempDir, trackDir, registerCleanup, seedSecretsEnv } from "./test-helpers.js";

registerCleanup();

// ── Secrets Management ──────────────────────────────────────────────────

describe("ensureSecrets", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("seeds secrets.env with empty ADMIN_TOKEN on first run", () => {
    const state = { configDir, adminToken: "preconfigured-token" } as ControlPlaneState;

    ensureSecrets(state);

    const secrets = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(secrets).toContain("ADMIN_TOKEN=\n");
    expect(secrets).not.toContain("ADMIN_TOKEN=preconfigured-token");
  });

  test("is idempotent — does not overwrite existing secrets.env", () => {
    const state = { configDir } as ControlPlaneState;
    const existingContent = "ADMIN_TOKEN=my-token\nOPENAI_API_KEY=sk-test\n";
    seedSecretsEnv(configDir, existingContent);

    ensureSecrets(state);

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toBe(existingContent);
  });

  test("includes LLM provider key placeholders", () => {
    const state = { configDir } as ControlPlaneState;
    ensureSecrets(state);

    const secrets = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(secrets).toContain("OPENAI_API_KEY=");
    expect(secrets).toContain("GROQ_API_KEY=");
    expect(secrets).toContain("MISTRAL_API_KEY=");
    expect(secrets).toContain("GOOGLE_API_KEY=");
  });

  test("creates config directory if missing", () => {
    const nestedDir = join(configDir, "deep", "nested");
    const state = { configDir: nestedDir } as ControlPlaneState;

    ensureSecrets(state);

    expect(existsSync(join(nestedDir, "secrets.env"))).toBe(true);
  });
});

describe("updateSecretsEnv", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("throws when secrets.env does not exist", () => {
    const state = { configDir } as ControlPlaneState;
    expect(() => updateSecretsEnv(state, { KEY: "val" })).toThrow(
      "secrets.env does not exist"
    );
  });

  test("updates existing key in-place", () => {
    seedSecretsEnv(configDir, "ADMIN_TOKEN=token\nOPENAI_API_KEY=old\n");
    const state = { configDir } as ControlPlaneState;

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-new" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-new");
    expect(result).not.toContain("old");
    expect(result).toContain("ADMIN_TOKEN=token");
  });

  test("uncomments and updates commented-out keys", () => {
    seedSecretsEnv(configDir, "ADMIN_TOKEN=token\n# OPENAI_API_KEY=\n");
    const state = { configDir } as ControlPlaneState;

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-uncommented" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-uncommented");
    expect(result).not.toContain("# OPENAI_API_KEY");
  });

  test("appends keys not found in file", () => {
    seedSecretsEnv(configDir, "ADMIN_TOKEN=token\n");
    const state = { configDir } as ControlPlaneState;

    updateSecretsEnv(state, { NEW_KEY: "new-value" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("NEW_KEY=new-value");
    expect(result).toContain("ADMIN_TOKEN=token");
  });

  test("empty updates leave file unchanged", () => {
    const original = "ADMIN_TOKEN=token\n";
    seedSecretsEnv(configDir, original);
    const state = { configDir } as ControlPlaneState;

    updateSecretsEnv(state, {});

    expect(readFileSync(join(configDir, "secrets.env"), "utf-8")).toBe(original);
  });
});

// ── Connection Key Management ───────────────────────────────────────────

describe("readSecretsEnvFile", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("returns empty object when file does not exist", () => {
    expect(readSecretsEnvFile(configDir)).toEqual({});
  });

  test("reads only ALLOWED_CONNECTION_KEYS", () => {
    seedSecretsEnv(
      configDir,
      "ADMIN_TOKEN=secret\nOPENAI_API_KEY=sk-test\nRANDOM_KEY=val\n"
    );

    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("sk-test");
    expect(result.ADMIN_TOKEN).toBeUndefined(); // ADMIN_TOKEN is not in ALLOWED_CONNECTION_KEYS
    expect(result.RANDOM_KEY).toBeUndefined();
  });

  test("skips comments and blank lines", () => {
    seedSecretsEnv(configDir, "# A comment\n\nOPENAI_API_KEY=sk-test\n# another\n");
    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("sk-test");
  });

  test("strips inline comments from values", () => {
    seedSecretsEnv(configDir, "OPENAI_API_KEY=sk-test # my key\n");
    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("sk-test");
  });

  test("unquotes single and double quoted values", () => {
    seedSecretsEnv(
      configDir,
      'OPENAI_API_KEY="sk-double"\nGROQ_API_KEY=\'sk-single\'\n'
    );
    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("sk-double");
    expect(result.GROQ_API_KEY).toBe("sk-single");
  });

  test("returns empty string for keys with no value", () => {
    seedSecretsEnv(configDir, "OPENAI_API_KEY=\n");
    const result = readSecretsEnvFile(configDir);
    expect(result.OPENAI_API_KEY).toBe("");
  });
});

describe("patchSecretsEnvFile", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = trackDir(makeTempDir());
  });

  test("only patches ALLOWED_CONNECTION_KEYS", () => {
    seedSecretsEnv(configDir, "ADMIN_TOKEN=token\nOPENAI_API_KEY=old\n");
    patchSecretsEnvFile(configDir, {
      OPENAI_API_KEY: "sk-new",
      ADMIN_TOKEN: "hacked", // NOT in ALLOWED_CONNECTION_KEYS
      RANDOM_KEY: "injected" // NOT in ALLOWED_CONNECTION_KEYS
    });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-new");
    expect(result).toContain("ADMIN_TOKEN=token"); // unchanged
    expect(result).not.toContain("RANDOM_KEY");
    expect(result).not.toContain("hacked");
  });

  test("appends new allowed keys when not in file", () => {
    seedSecretsEnv(configDir, "OPENAI_API_KEY=existing\n");
    patchSecretsEnvFile(configDir, { GROQ_API_KEY: "gsk-new" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=existing");
    expect(result).toContain("GROQ_API_KEY=gsk-new");
  });

  test("creates file if it does not exist", () => {
    patchSecretsEnvFile(configDir, { OPENAI_API_KEY: "sk-created" });
    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-created");
  });

  test("no-op when patches contain only disallowed keys", () => {
    const original = "ADMIN_TOKEN=keep\n";
    seedSecretsEnv(configDir, original);
    patchSecretsEnvFile(configDir, { ADMIN_TOKEN: "nope", RANDOM: "nope" });
    expect(readFileSync(join(configDir, "secrets.env"), "utf-8")).toBe(original);
  });

  test("preserves comments and non-allowed keys", () => {
    seedSecretsEnv(
      configDir,
      "# Config\nADMIN_TOKEN=secret\nOPENAI_API_KEY=old\nCUSTOM=val\n"
    );
    patchSecretsEnvFile(configDir, { OPENAI_API_KEY: "sk-updated" });

    const result = readFileSync(join(configDir, "secrets.env"), "utf-8");
    expect(result).toContain("# Config");
    expect(result).toContain("ADMIN_TOKEN=secret");
    expect(result).toContain("CUSTOM=val");
    expect(result).toContain("OPENAI_API_KEY=sk-updated");
  });
});

describe("maskConnectionValue", () => {
  test("returns empty string for empty value", () => {
    expect(maskConnectionValue("OPENAI_API_KEY", "")).toBe("");
  });

  test("masks secret keys, showing last 4 chars", () => {
    expect(maskConnectionValue("OPENAI_API_KEY", "sk-test-1234abcd")).toBe(
      "*".repeat("sk-test-1234abcd".length - 4) + "abcd"
    );
  });

  test("fully masks short values (<=4 chars)", () => {
    expect(maskConnectionValue("OPENAI_API_KEY", "abcd")).toBe("****");
    expect(maskConnectionValue("OPENAI_API_KEY", "ab")).toBe("****");
  });

  test("returns plain config keys unmasked (per api-spec.md)", () => {
    for (const key of PLAIN_CONFIG_KEYS) {
      expect(maskConnectionValue(key, "some-value")).toBe("some-value");
    }
  });

  test("GUARDIAN_LLM_PROVIDER is returned unmasked", () => {
    expect(maskConnectionValue("GUARDIAN_LLM_PROVIDER", "anthropic")).toBe("anthropic");
  });

  test("OPENMEMORY_OPENAI_BASE_URL is returned unmasked", () => {
    expect(maskConnectionValue("OPENMEMORY_OPENAI_BASE_URL", "http://localhost:11434")).toBe(
      "http://localhost:11434"
    );
  });
});

// ── Connection Key Sets ─────────────────────────────────────────────────

describe("ALLOWED_CONNECTION_KEYS", () => {
  test("includes all keys from api-spec.md", () => {
    const expectedKeys = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GROQ_API_KEY",
      "MISTRAL_API_KEY",
      "GOOGLE_API_KEY",
      "GUARDIAN_LLM_PROVIDER",
      "GUARDIAN_LLM_MODEL",
      "OPENMEMORY_OPENAI_BASE_URL",
      "OPENMEMORY_OPENAI_API_KEY"
    ];
    for (const key of expectedKeys) {
      expect(ALLOWED_CONNECTION_KEYS.has(key)).toBe(true);
    }
  });

  test("does not include ADMIN_TOKEN (security: separate from connection keys)", () => {
    expect(ALLOWED_CONNECTION_KEYS.has("ADMIN_TOKEN")).toBe(false);
  });
});

describe("REQUIRED_LLM_PROVIDER_KEYS", () => {
  test("includes all LLM provider API key names from api-spec.md", () => {
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("OPENAI_API_KEY");
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("ANTHROPIC_API_KEY");
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("GROQ_API_KEY");
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("MISTRAL_API_KEY");
    expect(REQUIRED_LLM_PROVIDER_KEYS).toContain("GOOGLE_API_KEY");
  });

  test("all required keys are subset of allowed connection keys", () => {
    for (const key of REQUIRED_LLM_PROVIDER_KEYS) {
      expect(ALLOWED_CONNECTION_KEYS.has(key)).toBe(true);
    }
  });
});

// ── OpenCode Config ─────────────────────────────────────────────────────

describe("ensureOpenCodeConfig", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
    process.env.OPENPALM_CONFIG_HOME = join(trackDir(makeTempDir()), "config");
  });

  afterEach(() => {
    process.env.OPENPALM_CONFIG_HOME = origEnv.OPENPALM_CONFIG_HOME;
  });

  test("seeds opencode.json with schema reference", () => {
    ensureOpenCodeConfig();

    const configFile = join(process.env.OPENPALM_CONFIG_HOME!, "opencode", "opencode.json");
    expect(existsSync(configFile)).toBe(true);
    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.$schema).toBe("https://opencode.ai/config.json");
  });

  test("creates tools, plugins, skills subdirs", () => {
    ensureOpenCodeConfig();
    const base = join(process.env.OPENPALM_CONFIG_HOME!, "opencode");
    expect(existsSync(join(base, "tools"))).toBe(true);
    expect(existsSync(join(base, "plugins"))).toBe(true);
    expect(existsSync(join(base, "skills"))).toBe(true);
  });

  test("does not overwrite existing opencode.json", () => {
    const configHome = process.env.OPENPALM_CONFIG_HOME!;
    const opencodePath = join(configHome, "opencode");
    mkdirSync(opencodePath, { recursive: true });
    const customConfig = '{"custom": true}\n';
    writeFileSync(join(opencodePath, "opencode.json"), customConfig);

    ensureOpenCodeConfig();

    expect(readFileSync(join(opencodePath, "opencode.json"), "utf-8")).toBe(customConfig);
  });
});
