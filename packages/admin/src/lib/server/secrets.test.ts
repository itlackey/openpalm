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
  readStackEnv,
  patchSecretsEnvFile,
  maskConnectionValue,
  ensureOpenCodeConfig,
  PLAIN_CONFIG_KEYS
} from "./secrets.js";
import type { ControlPlaneState } from "./types.js";
import { makeTempDir, trackDir, registerCleanup, seedSecretsEnv } from "./test-helpers.js";

registerCleanup();

// ── Secrets Management ──────────────────────────────────────────────────

describe("ensureSecrets", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = trackDir(makeTempDir());
  });

  test("seeds stack.env with API key placeholders on first run", () => {
    const state = { vaultDir, adminToken: "preconfigured-token" } as ControlPlaneState;

    ensureSecrets(state);

    const secrets = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(secrets).toContain("OPENAI_API_KEY=");
    expect(secrets).toContain("OP_ADMIN_TOKEN=");
  });

  test("is idempotent — does not overwrite existing stack.env", () => {
    const state = { vaultDir } as ControlPlaneState;
    const existingContent = "OP_ADMIN_TOKEN=my-token\nOPENAI_API_KEY=sk-test\nOP_ASSISTANT_TOKEN=ast\nOP_MEMORY_TOKEN=mem\n";
    seedSecretsEnv(vaultDir, existingContent);

    ensureSecrets(state);

    const result = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(result).toBe(existingContent);
  });

  test("includes LLM provider key placeholders in stack.env", () => {
    const state = { vaultDir } as ControlPlaneState;
    ensureSecrets(state);

    const secrets = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(secrets).toContain("OPENAI_API_KEY=");
    expect(secrets).toContain("GROQ_API_KEY=");
    expect(secrets).toContain("MISTRAL_API_KEY=");
    expect(secrets).toContain("GOOGLE_API_KEY=");
  });

  test("creates vault directory if missing", () => {
    const nestedDir = join(vaultDir, "deep", "nested");
    const state = { vaultDir: nestedDir } as ControlPlaneState;

    ensureSecrets(state);

    expect(existsSync(join(nestedDir, "stack", "stack.env"))).toBe(true);
    expect(existsSync(join(nestedDir, "user", "user.env"))).toBe(true);
  });
});

describe("updateSecretsEnv", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = trackDir(makeTempDir());
  });

  test("throws when stack.env does not exist", () => {
    const state = { vaultDir } as ControlPlaneState;
    expect(() => updateSecretsEnv(state, { KEY: "val" })).toThrow(
      "stack.env does not exist"
    );
  });

  test("updates existing key in-place", () => {
    seedSecretsEnv(vaultDir, "ADMIN_TOKEN=token\nOPENAI_API_KEY=old\n");
    const state = { vaultDir } as ControlPlaneState;

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-new" });

    const result = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-new");
    expect(result).not.toContain("old");
    expect(result).toContain("ADMIN_TOKEN=token");
  });

  test("uncomments and updates commented-out keys", () => {
    seedSecretsEnv(vaultDir, "ADMIN_TOKEN=token\n# OPENAI_API_KEY=\n");
    const state = { vaultDir } as ControlPlaneState;

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-uncommented" });

    const result = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-uncommented");
    expect(result).not.toContain("# OPENAI_API_KEY");
  });

  test("appends keys not found in file", () => {
    seedSecretsEnv(vaultDir, "ADMIN_TOKEN=token\n");
    const state = { vaultDir } as ControlPlaneState;

    updateSecretsEnv(state, { NEW_KEY: "new-value" });

    const result = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(result).toContain("NEW_KEY=new-value");
    expect(result).toContain("ADMIN_TOKEN=token");
  });

  test("empty updates leave file unchanged", () => {
    const original = "ADMIN_TOKEN=token\n";
    seedSecretsEnv(vaultDir, original);
    const state = { vaultDir } as ControlPlaneState;

    updateSecretsEnv(state, {});

    expect(readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8")).toBe(original);
  });
});

// ── Connection Key Management ───────────────────────────────────────────

describe("readStackEnv", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = trackDir(makeTempDir());
  });

  test("returns empty object when file does not exist", () => {
    expect(readStackEnv(vaultDir)).toEqual({});
  });

  test("reads all keys from stack.env", () => {
    seedSecretsEnv(
      vaultDir,
      "ADMIN_TOKEN=secret\nOPENAI_API_KEY=sk-test\nCUSTOM_KEY=val\n"
    );

    const result = readStackEnv(vaultDir);
    expect(result.OPENAI_API_KEY).toBe("sk-test");
    expect(result.ADMIN_TOKEN).toBe("secret");
    expect(result.CUSTOM_KEY).toBe("val");
  });

  test("skips comments and blank lines", () => {
    seedSecretsEnv(vaultDir, "# A comment\n\nOPENAI_API_KEY=sk-test\n# another\n");
    const result = readStackEnv(vaultDir);
    expect(result.OPENAI_API_KEY).toBe("sk-test");
  });

  test("strips inline comments from values", () => {
    seedSecretsEnv(vaultDir, "OPENAI_API_KEY=sk-test # my key\n");
    const result = readStackEnv(vaultDir);
    expect(result.OPENAI_API_KEY).toBe("sk-test");
  });

  test("unquotes single and double quoted values", () => {
    seedSecretsEnv(
      vaultDir,
      'OPENAI_API_KEY="sk-double"\nGROQ_API_KEY=\'sk-single\'\n'
    );
    const result = readStackEnv(vaultDir);
    expect(result.OPENAI_API_KEY).toBe("sk-double");
    expect(result.GROQ_API_KEY).toBe("sk-single");
  });

  test("returns empty string for keys with no value", () => {
    seedSecretsEnv(vaultDir, "OPENAI_API_KEY=\n");
    const result = readStackEnv(vaultDir);
    expect(result.OPENAI_API_KEY).toBe("");
  });
});

describe("patchSecretsEnvFile", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = trackDir(makeTempDir());
  });

  test("patches any key passed to it", () => {
    seedSecretsEnv(vaultDir, "ADMIN_TOKEN=token\nOPENAI_API_KEY=old\n");
    patchSecretsEnvFile(vaultDir, {
      OPENAI_API_KEY: "sk-new",
      ADMIN_TOKEN: "updated",
      CUSTOM_KEY: "injected"
    });

    const result = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-new");
    expect(result).toContain("ADMIN_TOKEN=updated");
    expect(result).toContain("CUSTOM_KEY=injected");
  });

  test("appends new keys when not in file", () => {
    seedSecretsEnv(vaultDir, "OPENAI_API_KEY=existing\n");
    patchSecretsEnvFile(vaultDir, { GROQ_API_KEY: "gsk-new" });

    const result = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=existing");
    expect(result).toContain("GROQ_API_KEY=gsk-new");
  });

  test("creates file if it does not exist", () => {
    patchSecretsEnvFile(vaultDir, { OPENAI_API_KEY: "sk-created" });
    const result = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(result).toContain("OPENAI_API_KEY=sk-created");
  });

  test("no-op when patches is empty", () => {
    const original = "ADMIN_TOKEN=keep\n";
    seedSecretsEnv(vaultDir, original);
    patchSecretsEnvFile(vaultDir, {});
    expect(readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8")).toBe(original);
  });

  test("preserves comments and existing keys", () => {
    seedSecretsEnv(
      vaultDir,
      "# Config\nADMIN_TOKEN=secret\nOPENAI_API_KEY=old\nCUSTOM=val\n"
    );
    patchSecretsEnvFile(vaultDir, { OPENAI_API_KEY: "sk-updated" });

    const result = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
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

  test("OWNER_NAME is returned unmasked", () => {
    expect(maskConnectionValue("OWNER_NAME", "Test User")).toBe("Test User");
  });

});

// ── OpenCode Config ─────────────────────────────────────────────────────

describe("ensureOpenCodeConfig", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OP_HOME = process.env.OP_HOME;
    process.env.OP_HOME = trackDir(makeTempDir());
  });

  afterEach(() => {
    process.env.OP_HOME = origEnv.OP_HOME;
  });

  test("seeds opencode.json with schema reference", () => {
    ensureOpenCodeConfig();

    const configFile = join(process.env.OP_HOME!, "config", "assistant", "opencode.json");
    expect(existsSync(configFile)).toBe(true);
    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.$schema).toBe("https://opencode.ai/config.json");
  });

  test("creates tools, plugins, skills subdirs", () => {
    ensureOpenCodeConfig();
    const base = join(process.env.OP_HOME!, "config", "assistant");
    expect(existsSync(join(base, "tools"))).toBe(true);
    expect(existsSync(join(base, "plugins"))).toBe(true);
    expect(existsSync(join(base, "skills"))).toBe(true);
  });

  test("does not overwrite existing opencode.json", () => {
    const configHome = join(process.env.OP_HOME!, "config");
    const opencodePath = join(configHome, "assistant");
    mkdirSync(opencodePath, { recursive: true });
    const customConfig = '{"custom": true}\n';
    writeFileSync(join(opencodePath, "opencode.json"), customConfig);

    ensureOpenCodeConfig();

    expect(readFileSync(join(opencodePath, "opencode.json"), "utf-8")).toBe(customConfig);
  });
});
