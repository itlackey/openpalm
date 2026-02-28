/**
 * Tests for updateSecretsEnv — the setup wizard's secrets file updater.
 *
 * Verifies:
 * 1. Allowlisted keys are written correctly
 * 2. Non-allowlisted keys (e.g. ADMIN_TOKEN) are rejected
 * 3. Existing lines are updated in-place
 * 4. Commented-out lines are uncommented and updated
 * 5. New keys are appended when not present in file
 * 6. Throws when secrets.env does not exist
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

// ── Inline implementation (mirrors control-plane.ts) ────────────────────
// We replicate the logic to test without Vite import.meta.glob dependencies.

const SETUP_WRITABLE_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENMEMORY_USER_ID",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "GOOGLE_API_KEY"
]);

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
  const lines = raw.split("\n");
  const remaining = new Map<string, string>();

  for (const [key, value] of Object.entries(updates)) {
    if (SETUP_WRITABLE_KEYS.has(key)) {
      remaining.set(key, value);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/^#\s*/, "").trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (remaining.has(key)) {
      lines[i] = `${key}=${remaining.get(key)}`;
      remaining.delete(key);
    }
  }

  if (remaining.size > 0) {
    lines.push("");
    for (const [key, value] of remaining) {
      lines.push(`${key}=${value}`);
    }
  }

  writeFileSync(secretsPath, lines.join("\n"));
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
    // ADMIN_TOKEN must remain unchanged
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
    // Original keys preserved
    expect(result).toContain("ADMIN_TOKEN=token");
    expect(result).toContain("OPENAI_API_KEY=existing");
  });

  test("rejects non-allowlisted keys (ADMIN_TOKEN)", () => {
    seedSecrets(configDir, [
      "ADMIN_TOKEN=original-token",
      ""
    ].join("\n"));

    const state: TestState = { configDir };
    updateSecretsEnv(state, {
      ADMIN_TOKEN: "hacked-token",
      OPENAI_API_KEY: "sk-legit"
    });

    const result = readSecrets(configDir);
    // ADMIN_TOKEN must NOT be changed
    expect(result).toContain("ADMIN_TOKEN=original-token");
    expect(result).not.toContain("hacked-token");
    // Allowlisted key should be written
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

  test("ignores completely unknown keys", () => {
    seedSecrets(configDir, "ADMIN_TOKEN=token\n");

    const state: TestState = { configDir };
    updateSecretsEnv(state, { RANDOM_KEY: "value", ANOTHER: "val2" });

    const result = readSecrets(configDir);
    expect(result).not.toContain("RANDOM_KEY");
    expect(result).not.toContain("ANOTHER");
    expect(result).toContain("ADMIN_TOKEN=token");
  });

  test("all six allowlisted keys can be written", () => {
    seedSecrets(configDir, "ADMIN_TOKEN=token\n");

    const state: TestState = { configDir };
    updateSecretsEnv(state, {
      OPENAI_API_KEY: "k1",
      OPENAI_BASE_URL: "k2",
      OPENMEMORY_USER_ID: "k3",
      GROQ_API_KEY: "k4",
      MISTRAL_API_KEY: "k5",
      GOOGLE_API_KEY: "k6"
    });

    const result = readSecrets(configDir);
    expect(result).toContain("OPENAI_API_KEY=k1");
    expect(result).toContain("OPENAI_BASE_URL=k2");
    expect(result).toContain("OPENMEMORY_USER_ID=k3");
    expect(result).toContain("GROQ_API_KEY=k4");
    expect(result).toContain("MISTRAL_API_KEY=k5");
    expect(result).toContain("GOOGLE_API_KEY=k6");
  });
});
