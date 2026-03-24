import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSystemEnvFromSpec, writeCapabilityVars } from "./spec-to-env.js";
import type { StackSpec } from "./stack-spec.js";

function makeSpec(overrides?: Partial<StackSpec>): StackSpec {
  return {
    version: 2,
    capabilities: {
      llm: "openai/gpt-4o",
      embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
      memory: { userId: "default_user" },
    },
    addons: {},
    ...overrides,
  };
}

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "openpalm-spec-env-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("deriveSystemEnvFromSpec", () => {
  test("produces OP_HOME", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.OP_HOME).toBe("/home/op");
  });

  test("produces default port values", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.OP_INGRESS_PORT).toBe("3080");
    expect(result.OP_ASSISTANT_PORT).toBe("3800");
    expect(result.OP_MEMORY_PORT).toBe("3898");
  });

  test("does not include LLM provider in system env (lives in OP_CAP_* vars in stack.env)", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.SYSTEM_LLM_PROVIDER).toBeUndefined();
    expect(result.SYSTEM_LLM_MODEL).toBeUndefined();
  });

  test("does not include embedding config in system env (lives in OP_CAP_* vars in stack.env)", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.EMBEDDING_MODEL).toBeUndefined();
    expect(result.EMBEDDING_DIMS).toBeUndefined();
  });

  test("derives feature flags from addons", () => {
    const spec = makeSpec({ addons: { ollama: true } });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.OP_OLLAMA_ENABLED).toBe("true");
    expect(result.OP_ADMIN_ENABLED).toBe("false");
  });
});

describe("writeCapabilityVars", () => {
  test("writes OP_CAP_* vars to stack.env", () => {
    const spec = makeSpec({
      capabilities: {
        llm: "openai/gpt-4o",
        embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
        memory: { userId: "default_user" },
      },
    });

    // Seed stack.env so writeCapabilityVars can read/merge it
    const vaultDir = join(tempDir, "vault");
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    writeFileSync(join(vaultDir, "stack", "stack.env"), "# stack env\n");

    writeCapabilityVars(spec, vaultDir);

    const stackEnvContent = readFileSync(join(vaultDir, "stack", "stack.env"), "utf-8");
    expect(stackEnvContent).toContain("OP_CAP_LLM_PROVIDER=openai");
    expect(stackEnvContent).toContain("OP_CAP_LLM_MODEL=gpt-4o");
    expect(stackEnvContent).toContain("OP_CAP_EMBEDDINGS_MODEL=text-embedding-3-small");
    expect(stackEnvContent).toContain("OP_CAP_EMBEDDINGS_DIMS=1536");
    expect(stackEnvContent).toContain("MEMORY_USER_ID=default_user");
  });

  test("does not create managed.env files", () => {
    const spec = makeSpec();

    const vaultDir = join(tempDir, "vault");
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    writeFileSync(join(vaultDir, "stack", "stack.env"), "# stack env\n");

    writeCapabilityVars(spec, vaultDir);

    const managedEnvPath = join(vaultDir, "stack", "services", "memory", "managed.env");
    expect(() => readFileSync(managedEnvPath)).toThrow();
  });
});
