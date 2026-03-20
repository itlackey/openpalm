import { describe, test, expect } from "bun:test";
import { deriveSystemEnvFromSpec } from "./spec-to-env.js";
import type { StackSpec } from "./stack-spec.js";

function makeSpec(overrides?: Partial<StackSpec>): StackSpec {
  return {
    version: 4,
    connections: [{ id: "openai", name: "OpenAI", provider: "openai", baseUrl: "" }],
    assignments: {
      llm: { connectionId: "openai", model: "gpt-4o" },
      embeddings: { connectionId: "openai", model: "text-embedding-3-small", dims: 1536 },
    },
    ...overrides,
  };
}

describe("deriveSystemEnvFromSpec", () => {
  test("produces OP_HOME", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.OP_HOME).toBe("/home/op");
    expect(result.OPENPALM_HOME).toBe("/home/op");
  });

  test("produces default port values", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.OP_INGRESS_PORT).toBe("3080");
    expect(result.OPENPALM_INGRESS_PORT).toBe("3080");
    expect(result.OP_ASSISTANT_PORT).toBe("3800");
    expect(result.OP_MEMORY_PORT).toBe("3898");
  });

  test("uses custom ports from spec", () => {
    const spec = makeSpec({ ports: { ingress: 8080, assistant: 4000 } });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.OP_INGRESS_PORT).toBe("8080");
    expect(result.OP_ASSISTANT_PORT).toBe("4000");
    // Unset ports get defaults
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

  test("uses custom image config", () => {
    const spec = makeSpec({ image: { namespace: "myrepo", tag: "v2.0" } });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.OP_IMAGE_NAMESPACE).toBe("myrepo");
    expect(result.OP_IMAGE_TAG).toBe("v2.0");
  });

  test("uses custom bind address", () => {
    const spec = makeSpec({ network: { bindAddress: "0.0.0.0" } });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.OP_INGRESS_BIND).toBe("0.0.0.0");
  });

  test("derives feature flags", () => {
    const spec = makeSpec({ features: { ollama: true, admin: false } });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.OP_OLLAMA_ENABLED).toBe("true");
    expect(result.OP_ADMIN_ENABLED).toBe("false");
  });

  test("derives memory userId", () => {
    const spec = makeSpec({ memory: { userId: "alice" } });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.MEMORY_USER_ID).toBe("alice");
  });

  test("defaults memory userId to default_user", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    expect(result.MEMORY_USER_ID).toBe("default_user");
  });

  test("uses custom runtime config", () => {
    const spec = makeSpec({ runtime: { uid: 1001, gid: 1001, dockerSock: "/run/docker.sock" } });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.OP_UID).toBe("1001");
    expect(result.OP_GID).toBe("1001");
    expect(result.OP_DOCKER_SOCK).toBe("/run/docker.sock");
  });

  test("handles empty LLM provider gracefully", () => {
    const spec = makeSpec({
      connections: [],
      assignments: {
        llm: { connectionId: "nonexistent", model: "gpt-4o" },
        embeddings: { connectionId: "nonexistent", model: "embed" },
      },
    });
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.SYSTEM_LLM_PROVIDER).toBe("");
  });
});
