/**
 * Tests for secrets.ts — secrets/capabilities CRUD, masking, OpenCode config.
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
  readSecret,
  patchSecretsEnvFile,
  maskSecretValue,
  ensureOpenCodeConfig,
  PLAIN_CONFIG_KEYS
} from "@openpalm/lib";
import type { ControlPlaneState } from "@openpalm/lib";
import { makeTempDir, trackDir, registerCleanup, seedSecretsEnv , stackEnvFor} from "./test-helpers.js";

registerCleanup();

// ── Secrets Management ──────────────────────────────────────────────────

describe("ensureSecrets", () => {
  let homeDir: string;
  let stackDir: string;
  let configDir: string;

  beforeEach(() => {
    homeDir = trackDir(makeTempDir());
    configDir = join(homeDir, "config");
    stackDir = join(homeDir, "system", "stack");
    mkdirSync(stackDir, { recursive: true });
  });

  test("seeds stack.env without secret placeholders on first run", () => {
    const state = { homeDir, stackDir, configDir, stashDir: join(homeDir, "knowledge") } as ControlPlaneState;

    ensureSecrets(state);

    const secrets = readFileSync(stackEnvFor(homeDir), "utf-8");
    expect(secrets).toContain("OP_SETUP_COMPLETE=false");
    expect(secrets).not.toContain("OPENAI_API_KEY=");
    expect(secrets).not.toContain("OP_UI_LOGIN_PASSWORD=");
    expect(readSecret(homeDir, "op_ui_login_password")).toBeNull();
  });

  test("is idempotent — does not overwrite existing non-secret stack.env", () => {
    const state = { homeDir, stackDir, configDir, stashDir: join(homeDir, "knowledge") } as ControlPlaneState;
    const existingContent = "OP_SETUP_COMPLETE=false\nOP_OWNER_NAME=alice\n";
    seedSecretsEnv(homeDir, existingContent);

    ensureSecrets(state);

    const result = readFileSync(stackEnvFor(homeDir), "utf-8");
    expect(result).toBe(existingContent);
  });

  test("does not include LLM provider key placeholders in stack.env", () => {
    const state = { homeDir, stackDir, configDir, stashDir: join(homeDir, "knowledge") } as ControlPlaneState;
    ensureSecrets(state);

    const secrets = readFileSync(stackEnvFor(homeDir), "utf-8");
    expect(secrets).not.toContain("OPENAI_API_KEY=");
    expect(secrets).not.toContain("GROQ_API_KEY=");
    expect(secrets).not.toContain("MISTRAL_API_KEY=");
    expect(secrets).not.toContain("GOOGLE_API_KEY=");
  });

  test("creates dirs and stack.env if missing", () => {
    const nestedDir = join(stackDir, "deep", "nested");
    const stashDir = join(homeDir, "knowledge");
    const state = { homeDir, stackDir: nestedDir, configDir, stashDir } as ControlPlaneState;

    ensureSecrets(state);

    // ensureSecrets enforces the stackDir mode (creates it) and writes the
    // env file under the stash (state/stack.env).
    expect(existsSync(nestedDir)).toBe(true);
    expect(existsSync(join(stashDir, "env", "stack.env"))).toBe(true);
  });
});

describe("updateSecretsEnv", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = trackDir(makeTempDir());
  });

  test("creates stack.env when stack.env does not exist", () => {
    const state = { homeDir } as ControlPlaneState;
    updateSecretsEnv(state, { KEY: "val" });
    expect(readFileSync(stackEnvFor(homeDir), "utf-8")).toContain("KEY=val");
  });

  test("routes secret keys to file-based secrets", () => {
    seedSecretsEnv(homeDir, "OP_OWNER_NAME=alice\n");
    const state = { homeDir } as ControlPlaneState;

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-new" });

    const result = readFileSync(stackEnvFor(homeDir), "utf-8");
    expect(result).not.toContain("OPENAI_API_KEY=");
    expect(result).toContain("OP_OWNER_NAME=alice");
    expect(readSecret(homeDir, "openai_api_key")).toBe("sk-new\n");
  });

  test("ignores commented-out secret keys in stack.env", () => {
    seedSecretsEnv(homeDir, "OP_OWNER_NAME=alice\n# OPENAI_API_KEY=\n");
    const state = { homeDir } as ControlPlaneState;

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-uncommented" });

    const result = readFileSync(stackEnvFor(homeDir), "utf-8");
    expect(result).not.toContain("OPENAI_API_KEY=sk-uncommented");
    expect(result).toContain("# OPENAI_API_KEY=");
    expect(readSecret(homeDir, "openai_api_key")).toBe("sk-uncommented\n");
  });

  test("appends keys not found in file", () => {
    seedSecretsEnv(homeDir, "OP_OWNER_NAME=alice\n");
    const state = { homeDir } as ControlPlaneState;

    updateSecretsEnv(state, { NEW_KEY: "new-value" });

    const result = readFileSync(stackEnvFor(homeDir), "utf-8");
    expect(result).toContain("NEW_KEY=new-value");
    expect(result).toContain("OP_OWNER_NAME=alice");
  });

  test("empty updates leave file unchanged", () => {
    const original = "OP_OWNER_NAME=alice\n";
    seedSecretsEnv(homeDir, original);
    const state = { homeDir } as ControlPlaneState;

    updateSecretsEnv(state, {});

    expect(readFileSync(stackEnvFor(homeDir), "utf-8")).toBe(original);
  });
});

// ── Connection Key Management ───────────────────────────────────────────

describe("readStackEnv", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = trackDir(makeTempDir());
  });

  test("returns empty object when file does not exist", () => {
    expect(readStackEnv(homeDir)).toEqual({});
  });

  test("reads only non-secret keys from stack.env", () => {
    seedSecretsEnv(
      homeDir,
      "OP_UI_LOGIN_PASSWORD=secret\nOPENAI_API_KEY=sk-test\nCUSTOM_KEY=val\n"
    );

    const result = readStackEnv(homeDir);
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.OP_UI_LOGIN_PASSWORD).toBeUndefined();
    expect(result.CUSTOM_KEY).toBe("val");
  });

  test("skips comments and blank lines", () => {
    seedSecretsEnv(homeDir, "# A comment\n\nOP_OWNER_NAME=alice\n# another\n");
    const result = readStackEnv(homeDir);
    expect(result.OP_OWNER_NAME).toBe("alice");
  });

  test("strips inline comments from values", () => {
    seedSecretsEnv(homeDir, "OP_OWNER_NAME=alice # owner\n");
    const result = readStackEnv(homeDir);
    expect(result.OP_OWNER_NAME).toBe("alice");
  });

  test("unquotes single and double quoted values", () => {
    seedSecretsEnv(
      homeDir,
      'OP_OWNER_NAME="Alice"\nOPENAI_BASE_URL=\'http://localhost:11434/v1\'\n'
    );
    const result = readStackEnv(homeDir);
    expect(result.OP_OWNER_NAME).toBe("Alice");
    expect(result.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
  });

  test("returns empty string for keys with no value", () => {
    seedSecretsEnv(homeDir, "OPENAI_BASE_URL=\n");
    const result = readStackEnv(homeDir);
    expect(result.OPENAI_BASE_URL).toBe("");
  });
});

describe("patchSecretsEnvFile", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = trackDir(makeTempDir());
  });

  test("routes secret-like patches to files and writes non-secrets to stack.env", () => {
    seedSecretsEnv(homeDir, "OP_OWNER_NAME=alice\n");
    patchSecretsEnvFile(homeDir, {
      OPENAI_API_KEY: "sk-new",
      OP_UI_LOGIN_PASSWORD: "updated",
      CUSTOM_KEY: "injected"
    });

    const result = readFileSync(stackEnvFor(homeDir), "utf-8");
    expect(result).not.toContain("OPENAI_API_KEY=");
    expect(result).not.toContain("OP_UI_LOGIN_PASSWORD=");
    expect(result).toContain("CUSTOM_KEY=injected");
    expect(readSecret(homeDir, "openai_api_key")).toBe("sk-new\n");
    expect(readSecret(homeDir, "op_ui_login_password")).toBe("updated\n");
  });

  test("appends new non-secret keys when not in file", () => {
    seedSecretsEnv(homeDir, "OP_OWNER_NAME=alice\n");
    patchSecretsEnvFile(homeDir, { GROQ_API_KEY: "gsk-new" });

    const result = readFileSync(stackEnvFor(homeDir), "utf-8");
    expect(result).toContain("OP_OWNER_NAME=alice");
    expect(result).not.toContain("GROQ_API_KEY=");
    expect(readSecret(homeDir, "groq_api_key")).toBe("gsk-new\n");
  });

  test("creates file if it does not exist", () => {
    patchSecretsEnvFile(homeDir, { OPENAI_API_KEY: "sk-created" });
    expect(existsSync(stackEnvFor(homeDir))).toBe(false);
    expect(readSecret(homeDir, "openai_api_key")).toBe("sk-created\n");
  });

  test("no-op when patches is empty", () => {
    const original = "OP_OWNER_NAME=alice\n";
    seedSecretsEnv(homeDir, original);
    patchSecretsEnvFile(homeDir, {});
    expect(readFileSync(stackEnvFor(homeDir), "utf-8")).toBe(original);
  });

  test("preserves comments and existing keys", () => {
    seedSecretsEnv(
      homeDir,
      "# Config\nOP_OWNER_NAME=alice\nCUSTOM=val\n"
    );
    patchSecretsEnvFile(homeDir, { OP_OWNER_EMAIL: "alice@example.com" });

    const result = readFileSync(stackEnvFor(homeDir), "utf-8");
    expect(result).toContain("# Config");
    expect(result).toContain("OP_OWNER_NAME=alice");
    expect(result).toContain("CUSTOM=val");
    expect(result).toContain("OP_OWNER_EMAIL=alice@example.com");
  });
});

describe("maskSecretValue", () => {
  test("returns empty string for empty value", () => {
    expect(maskSecretValue("OPENAI_API_KEY", "")).toBe("");
  });

  test("masks secret keys, showing last 4 chars", () => {
    expect(maskSecretValue("OPENAI_API_KEY", "sk-test-1234abcd")).toBe(
      `${"*".repeat("sk-test-1234abcd".length - 4)}abcd`
    );
  });

  test("fully masks short values (<=4 chars)", () => {
    expect(maskSecretValue("OPENAI_API_KEY", "abcd")).toBe("****");
    expect(maskSecretValue("OPENAI_API_KEY", "ab")).toBe("****");
  });

  test("returns plain config keys unmasked (per api-spec.md)", () => {
    for (const key of PLAIN_CONFIG_KEYS) {
      expect(maskSecretValue(key, "some-value")).toBe("some-value");
    }
  });

  test("OP_OWNER_NAME is returned unmasked", () => {
    expect(maskSecretValue("OP_OWNER_NAME", "Test User")).toBe("Test User");
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

    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    const configFile = join(process.env.OP_HOME!, "config", "assistant", "opencode.json");
    expect(existsSync(configFile)).toBe(true);
    const content = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(content.$schema).toBe("https://opencode.ai/config.json");
  });

  test("creates tools, plugins, skills subdirs", () => {
    ensureOpenCodeConfig();
    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    const base = join(process.env.OP_HOME!, "config", "assistant");
    expect(existsSync(join(base, "tools"))).toBe(true);
    expect(existsSync(join(base, "plugins"))).toBe(true);
    expect(existsSync(join(base, "skills"))).toBe(true);
  });

  test("does not overwrite existing opencode.json", () => {
    // biome-ignore lint/style/noNonNullAssertion: OP_HOME is assigned in beforeEach, so it is defined for every test in this suite.
    const configHome = join(process.env.OP_HOME!, "config");
    const opencodePath = join(configHome, "assistant");
    mkdirSync(opencodePath, { recursive: true });
    const customConfig = '{"custom": true}\n';
    writeFileSync(join(opencodePath, "opencode.json"), customConfig);

    ensureOpenCodeConfig();

    expect(readFileSync(join(opencodePath, "opencode.json"), "utf-8")).toBe(customConfig);
  });
});
