import { describe, test, expect } from "bun:test";
import { deriveSystemEnvFromSpec } from "./spec-to-env.js";
import type { StackSpec } from "./stack-spec.js";

function makeSpec(overrides?: Partial<StackSpec>): StackSpec {
  return {
    version: 1,
    connections: [{ id: "openai", name: "OpenAI", kind: "openai_compatible_remote", provider: "openai", baseUrl: "", auth: { mode: "none" } }],
    assignments: {
      llm: { connectionId: "openai", model: "gpt-4o" },
      embeddings: { connectionId: "openai", model: "text-embedding-3-small", embeddingDims: 1536 },
      memory: {
        llm: { connectionId: "openai", model: "gpt-4o" },
        embeddings: { connectionId: "openai", model: "text-embedding-3-small" },
        vectorStore: { provider: "sqlite-vec", collectionName: "memory", dbPath: "/data/memory.db" },
      },
    },
    addons: [],
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

  test("derives LLM provider from assigned connection", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.SYSTEM_LLM_PROVIDER).toBe("openai");
    expect(result.SYSTEM_LLM_MODEL).toBe("gpt-4o");
  });

  test("derives embedding config", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.EMBEDDING_MODEL).toBe("text-embedding-3-small");
    expect(result.EMBEDDING_DIMS).toBe("1536");
  });

  test("derives feature flags from addons", () => {
    const spec = makeSpec({ addons: ["ollama"] });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.OP_OLLAMA_ENABLED).toBe("true");
    expect(result.OP_ADMIN_ENABLED).toBe("false");
  });

  test("handles empty LLM provider gracefully", () => {
    const spec = makeSpec({
      connections: [],
      assignments: {
        llm: { connectionId: "nonexistent", model: "gpt-4o" },
        embeddings: { connectionId: "nonexistent", model: "embed" },
        memory: {
          llm: { connectionId: "nonexistent", model: "gpt-4o" },
          embeddings: { connectionId: "nonexistent", model: "embed" },
          vectorStore: { provider: "sqlite-vec", collectionName: "memory", dbPath: "/data/memory.db" },
        },
      },
    });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.SYSTEM_LLM_PROVIDER).toBe("");
  });
});
