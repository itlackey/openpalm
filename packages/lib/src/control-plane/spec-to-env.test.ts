import { describe, test, expect } from "bun:test";
import { deriveSystemEnvFromSpec, deriveMemoryEnv } from "./spec-to-env.js";
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

  test("does not include LLM provider in system env (now in deriveMemoryEnv)", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.SYSTEM_LLM_PROVIDER).toBeUndefined();
    expect(result.SYSTEM_LLM_MODEL).toBeUndefined();
  });

  test("does not include embedding config in system env (now in deriveMemoryEnv)", () => {
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

describe("deriveMemoryEnv", () => {
  test("derives LLM provider from capabilities", () => {
    const result = deriveMemoryEnv(makeSpec());
    expect(result.SYSTEM_LLM_PROVIDER).toBe("openai");
    expect(result.SYSTEM_LLM_MODEL).toBe("gpt-4o");
  });

  test("derives embedding config from capabilities", () => {
    const result = deriveMemoryEnv(makeSpec());
    expect(result.EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(result.EMBEDDING_DIMS).toBe("1536");
  });

  test("derives MEMORY_USER_ID from capabilities", () => {
    const result = deriveMemoryEnv(makeSpec());
    expect(result.MEMORY_USER_ID).toBe("default_user");
  });

  test("defaults MEMORY_USER_ID when empty", () => {
    const spec = makeSpec({
      capabilities: {
        llm: "openai/gpt-4o",
        embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
        memory: { userId: "" },
      },
    });
    const result = deriveMemoryEnv(spec);
    expect(result.MEMORY_USER_ID).toBe("default_user");
  });
});
