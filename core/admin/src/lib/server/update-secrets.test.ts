/**
 * Tests for updateSecretsEnv — the setup wizard's secrets file updater.
 *
 * Verifies:
 * 1. All provided keys are written
 * 2. Existing lines are updated in-place
 * 3. Commented-out lines are uncommented and updated
 * 4. New keys are appended when not present in file
 * 5. Throws when secrets.env does not exist
 * 6. Comments and blank lines are preserved
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeEnvContent } from "@openpalm/lib/shared/env";

// ── Inline implementation (mirrors control-plane.ts) ────────────────────
// Uses mergeEnvContent from the shared env utility. We keep the file I/O
// inline to avoid importing control-plane.ts (which has Vite-specific deps).

type TestState = { configDir: string };

function updateSecretsEnv(
  state: TestState,
  updates: Record<string, string>
): void {
  const secretsPath = `${state.configDir}/secrets.env`;
  if (!existsSync(secretsPath)) {
    throw new Error("secrets.env does not exist — run setup first");
  }

  const raw = readFileSync(secretsPath, "utf-8");
  writeFileSync(secretsPath, mergeEnvContent(raw, updates, { uncomment: true }));
}

// ── Test helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedSecrets(configDir: string, content: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "secrets.env"), content);
}

function readSecrets(configDir: string): string {
  return readFileSync(join(configDir, "secrets.env"), "utf-8");
}

// ── Tests ──────────────────────────────────────────────────────────────

let configDir: string;

beforeEach(() => {
  configDir = makeTempDir();
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("updateSecretsEnv", () => {
  test("throws when secrets.env does not exist", () => {
    const state: TestState = { configDir };
    expect(() => updateSecretsEnv(state, { OPENAI_API_KEY: "sk-test" })).toThrow(
      "secrets.env does not exist"
    );
  });

  test("updates existing key in-place", () => {
    seedSecrets(configDir, [
      "ADMIN_TOKEN=my-admin-token",
      "OPENAI_API_KEY=old-key",
      ""
    ].join("\n"));

    const state: TestState = { configDir };
    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-new-key" });

    const result = readSecrets(configDir);
    expect(result).toContain("OPENAI_API_KEY=sk-new-key");
    expect(result).not.toContain("old-key");
    expect(result).toContain("ADMIN_TOKEN=my-admin-token");
  });

  test("uncomments commented-out key and sets value", () => {
    seedSecrets(configDir, [
      "ADMIN_TOKEN=token",
      "# OPENAI_API_KEY=",
      ""
    ].join("\n"));

    const state: TestState = { configDir };
    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-uncommented" });

    const result = readSecrets(configDir);
    expect(result).toContain("OPENAI_API_KEY=sk-uncommented");
    expect(result).not.toContain("# OPENAI_API_KEY");
  });

  test("appends new key when not in file", () => {
    seedSecrets(configDir, [
      "ADMIN_TOKEN=token",
      "OPENAI_API_KEY=existing",
      ""
    ].join("\n"));

    const state: TestState = { configDir };
    updateSecretsEnv(state, { OPENAI_BASE_URL: "http://localhost:11434/v1" });

    const result = readSecrets(configDir);
    expect(result).toContain("OPENAI_BASE_URL=http://localhost:11434/v1");
    expect(result).toContain("ADMIN_TOKEN=token");
    expect(result).toContain("OPENAI_API_KEY=existing");
  });

  test("writes any key including ADMIN_TOKEN", () => {
    seedSecrets(configDir, [
      "ADMIN_TOKEN=",
      ""
    ].join("\n"));

    const state: TestState = { configDir };
    updateSecretsEnv(state, {
      ADMIN_TOKEN: "new-secure-token",
      OPENAI_API_KEY: "sk-legit"
    });

    const result = readSecrets(configDir);
    expect(result).toContain("ADMIN_TOKEN=new-secure-token");
    expect(result).toContain("OPENAI_API_KEY=sk-legit");
  });

  test("handles multiple updates at once", () => {
    seedSecrets(configDir, [
      "ADMIN_TOKEN=token",
      "OPENAI_API_KEY=",
      "# GROQ_API_KEY=",
      ""
    ].join("\n"));

    const state: TestState = { configDir };
    updateSecretsEnv(state, {
      OPENAI_API_KEY: "sk-openai",
      GROQ_API_KEY: "gsk-groq",
      OPENMEMORY_USER_ID: "alice"
    });

    const result = readSecrets(configDir);
    expect(result).toContain("OPENAI_API_KEY=sk-openai");
    expect(result).toContain("GROQ_API_KEY=gsk-groq");
    expect(result).toContain("OPENMEMORY_USER_ID=alice");
    expect(result).toContain("ADMIN_TOKEN=token");
  });

  test("preserves comments and blank lines", () => {
    const original = [
      "# OpenPalm Secrets",
      "# Edit this file to update admin token and LLM keys.",
      "",
      "ADMIN_TOKEN=token123",
      "",
      "# LLM provider keys",
      "OPENAI_API_KEY=old",
      ""
    ].join("\n");
    seedSecrets(configDir, original);

    const state: TestState = { configDir };
    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-updated" });

    const result = readSecrets(configDir);
    expect(result).toContain("# OpenPalm Secrets");
    expect(result).toContain("# Edit this file to update admin token and LLM keys.");
    expect(result).toContain("ADMIN_TOKEN=token123");
    expect(result).toContain("OPENAI_API_KEY=sk-updated");
  });

  test("appends keys that don't exist in the file at all", () => {
    seedSecrets(configDir, "ADMIN_TOKEN=token\n");

    const state: TestState = { configDir };
    updateSecretsEnv(state, { CUSTOM_KEY: "value1", ANOTHER: "val2" });

    const result = readSecrets(configDir);
    expect(result).toContain("CUSTOM_KEY=value1");
    expect(result).toContain("ANOTHER=val2");
    expect(result).toContain("ADMIN_TOKEN=token");
  });

  test("empty updates leave file unchanged", () => {
    const original = "ADMIN_TOKEN=token\nOPENAI_API_KEY=sk-key\n";
    seedSecrets(configDir, original);

    const state: TestState = { configDir };
    updateSecretsEnv(state, {});

    const result = readSecrets(configDir);
    expect(result).toBe(original);
  });
});
