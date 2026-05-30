/**
 * Tests for updateSecretsEnv — stack.env + file-based secret patching used by
 * the capabilities API.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSecret, updateSecretsEnv, type ControlPlaneState } from '@openpalm/lib';

// ── Test helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeState(homeDir: string): ControlPlaneState {
  return {
    homeDir,
    configDir: join(homeDir, "config"),
    stashDir: join(homeDir, "stash"),
    workspaceDir: join(homeDir, "workspace"),
    dataDir: join(homeDir, "data"),
    stackDir: join(homeDir, "config", "stack"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
}

function seedStackEnv(stackDir: string, content: string): void {
  mkdirSync(stackDir, { recursive: true });
  writeFileSync(join(stackDir, "stack.env"), content);
}

function readStackEnv(stackDir: string): string {
  return readFileSync(join(stackDir, "stack.env"), "utf-8");
}

// ── Tests ──────────────────────────────────────────────────────────────

let state: ControlPlaneState;

beforeEach(() => {
  state = makeState(makeTempDir());
});

afterEach(() => {
  rmSync(state.homeDir, { recursive: true, force: true });
});

describe("updateSecretsEnv", () => {
  test("writes secret-like keys to file-based secrets", () => {
    seedStackEnv(state.stackDir, [
      "USER_SETTING=my-admin-value",
      ""
    ].join("\n"));

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-new-key" });

    const result = readStackEnv(state.stackDir);
    expect(result).not.toContain("OPENAI_API_KEY=");
    expect(result).toContain("USER_SETTING=my-admin-value");
    expect(readSecret(state.stackDir, "openai_api_key")).toBe("sk-new-key\n");
  });

  test("leaves commented secret placeholders untouched and writes a secret file", () => {
    seedStackEnv(state.stackDir, [
      "USER_SETTING=token",
      "# OPENAI_API_KEY=",
      ""
    ].join("\n"));

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-uncommented" });

    const result = readStackEnv(state.stackDir);
    expect(result).not.toContain("OPENAI_API_KEY=sk-uncommented");
    expect(result).toContain("# OPENAI_API_KEY=");
    expect(readSecret(state.stackDir, "openai_api_key")).toBe("sk-uncommented\n");
  });

  test("appends non-secret keys when not in stack.env", () => {
    seedStackEnv(state.stackDir, [
      "USER_SETTING=token",
      ""
    ].join("\n"));

    updateSecretsEnv(state, { OPENAI_BASE_URL: "http://localhost:11434/v1" });

    const result = readStackEnv(state.stackDir);
    expect(result).toContain("OPENAI_BASE_URL=http://localhost:11434/v1");
    expect(result).toContain("USER_SETTING=token");
  });

  test("splits mixed updates between stack.env and secret files", () => {
    seedStackEnv(state.stackDir, [
      "USER_SETTING=token",
      ""
    ].join("\n"));

    updateSecretsEnv(state, {
      CUSTOM_SECRET: "new-secure-token",
      OPENAI_API_KEY: "sk-legit"
    });

    const result = readStackEnv(state.stackDir);
    expect(result).not.toContain("CUSTOM_SECRET=new-secure-token");
    expect(result).not.toContain("OPENAI_API_KEY=sk-legit");
    expect(result).toContain("USER_SETTING=token");
    expect(readSecret(state.stackDir, "custom_secret")).toBe("new-secure-token\n");
    expect(readSecret(state.stackDir, "openai_api_key")).toBe("sk-legit\n");
  });

  test("handles multiple updates at once", () => {
    seedStackEnv(state.stackDir, [
      "USER_SETTING=token",
      "# GROQ_API_KEY=",
      ""
    ].join("\n"));

    updateSecretsEnv(state, {
      OPENAI_API_KEY: "sk-openai",
      GROQ_API_KEY: "gsk-groq",
      OP_OWNER_NAME: "alice"
    });

    const result = readStackEnv(state.stackDir);
    expect(result).not.toContain("OPENAI_API_KEY=");
    expect(result).not.toContain("GROQ_API_KEY=gsk-groq");
    expect(result).toContain("# GROQ_API_KEY=");
    expect(result).toContain("OP_OWNER_NAME=alice");
    expect(result).toContain("USER_SETTING=token");
    expect(readSecret(state.stackDir, "openai_api_key")).toBe("sk-openai\n");
    expect(readSecret(state.stackDir, "groq_api_key")).toBe("gsk-groq\n");
  });

  test("preserves comments and blank lines", () => {
    const original = [
      "# OpenPalm Secrets",
      "# Edit this file to update user vault keys.",
      "",
      "USER_SETTING=token123",
      "",
      "# LLM provider keys",
      ""
    ].join("\n");
    seedStackEnv(state.stackDir, original);

    updateSecretsEnv(state, { OPENAI_API_KEY: "sk-updated" });

    const result = readStackEnv(state.stackDir);
    expect(result).toContain("# OpenPalm Secrets");
    expect(result).toContain("# Edit this file to update user vault keys.");
    expect(result).toContain("USER_SETTING=token123");
    expect(result).not.toContain("OPENAI_API_KEY=sk-updated");
    expect(readSecret(state.stackDir, "openai_api_key")).toBe("sk-updated\n");
  });

  test("appends keys that don't exist in the file at all", () => {
    seedStackEnv(state.stackDir, "USER_SETTING=token\n");

    updateSecretsEnv(state, { CUSTOM_KEY: "value1", ANOTHER: "val2" });

    const result = readStackEnv(state.stackDir);
    expect(result).toContain("CUSTOM_KEY=value1");
    expect(result).toContain("ANOTHER=val2");
    expect(result).toContain("USER_SETTING=token");
  });

  test("empty updates leave file unchanged", () => {
    const original = "USER_SETTING=token\nOPENAI_BASE_URL=http://localhost:11434/v1\n";
    seedStackEnv(state.stackDir, original);

    updateSecretsEnv(state, {});

    const result = readStackEnv(state.stackDir);
    expect(result).toBe(original);
  });
});
