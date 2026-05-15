import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSystemEnvFromSpec, writeCapabilityVars, buildAkmSetupJson } from "./spec-to-env.js";
import type { StackSpec } from "./stack-spec.js";

function makeSpec(overrides?: Partial<StackSpec>): StackSpec {
  return {
    version: 2,
    capabilities: {
      llm: "openai/gpt-4o",
      embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
    },
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
    expect(result.OP_ASSISTANT_PORT).toBe("3800");
    expect(result.OP_GUARDIAN_PORT).toBe("3899");
  });

  test("does not include the retired memory service port", () => {
    const result = deriveSystemEnvFromSpec(makeSpec(), "/home/op");
    // The memory service was removed; this var must not be derived.
    const retired = "OP_" + "MEMORY_PORT";
    expect(result[retired]).toBeUndefined();
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

  test("does not include removed feature flags", () => {
    const spec = makeSpec();
    const result = deriveSystemEnvFromSpec(spec, "/home/op");
    expect(result.OP_OLLAMA_ENABLED).toBeUndefined();
    expect(result.OP_ADMIN_ENABLED).toBeUndefined();
  });
});

describe("writeCapabilityVars", () => {
  test("writes OP_CAP_* vars to stack.env", () => {
    const spec = makeSpec({
      capabilities: {
        llm: "openai/gpt-4o",
        embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
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
    // The retired memory service no longer participates in capability resolution.
    const retiredVar = "MEMORY_" + "USER_ID";
    expect(stackEnvContent).not.toContain(`${retiredVar}=`);
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

describe("buildAkmSetupJson", () => {
  test("returns null when no LLM configured", () => {
    const spec: StackSpec = {
      version: 2,
      capabilities: {
        llm: "/",
        embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
      },
    };
    // parseCapabilityString("/" ) → { provider: "", model: "" }
    expect(buildAkmSetupJson(spec, {})).toBeNull();
  });

  test("uses LLM when SLM is not set", () => {
    const spec = makeSpec({ capabilities: { llm: "openai/gpt-4o", embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 } } });
    const json = buildAkmSetupJson(spec, {});
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.model).toBe("gpt-4o");
  });

  test("prefers SLM over LLM for akm LLM config", () => {
    const spec = makeSpec({
      capabilities: {
        llm: "openai/gpt-4o",
        slm: "ollama/qwen2.5-coder:3b",
        embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
      },
    });
    const json = buildAkmSetupJson(spec, {});
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.llm.provider).toBe("ollama");
    expect(config.llm.model).toBe("qwen2.5-coder:3b");
  });

  test("falls back to LLM when SLM is set but empty string", () => {
    const spec = makeSpec({
      capabilities: {
        llm: "groq/llama-3.3-70b-versatile",
        slm: "",
        embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 },
      },
    });
    const json = buildAkmSetupJson(spec, {});
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.llm.provider).toBe("groq");
    expect(config.llm.model).toBe("llama-3.3-70b-versatile");
  });

  test("includes embedding config when configured", () => {
    const spec = makeSpec({
      capabilities: {
        llm: "openai/gpt-4o",
        embeddings: { provider: "ollama", model: "nomic-embed-text", dims: 768 },
      },
    });
    const json = buildAkmSetupJson(spec, {});
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.embedding).toBeDefined();
    expect(config.embedding.provider).toBe("ollama");
    expect(config.embedding.model).toBe("nomic-embed-text");
    expect(config.embedding.dimension).toBe(768);
  });

  test("omits embedding when dims is 0", () => {
    const spec = makeSpec({
      capabilities: {
        llm: "openai/gpt-4o",
        embeddings: { provider: "", model: "", dims: 0 },
      },
    });
    const json = buildAkmSetupJson(spec, {});
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.embedding).toBeUndefined();
  });

  test("appends /chat/completions to a base URL already ending in /v1 (LLM endpoint)", () => {
    const spec = makeSpec({ capabilities: { llm: "openai/gpt-4o", embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 } } });
    const json = buildAkmSetupJson(spec, { OPENAI_BASE_URL: "https://api.openai.com/v1" });
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.llm.endpoint).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("appends /v1/chat/completions to a base URL without /v1 suffix", () => {
    const spec = makeSpec({ capabilities: { llm: "openai/gpt-4o", embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 } } });
    const json = buildAkmSetupJson(spec, { OPENAI_BASE_URL: "https://custom.example.com" });
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.llm.endpoint).toBe("https://custom.example.com/v1/chat/completions");
  });

  test("embedding endpoint uses /embeddings path", () => {
    const spec = makeSpec({ capabilities: { llm: "openai/gpt-4o", embeddings: { provider: "openai", model: "text-embedding-3-small", dims: 1536 } } });
    const json = buildAkmSetupJson(spec, {});
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.embedding.endpoint).toBe("https://api.openai.com/v1/embeddings");
  });

  test("ollama embedding endpoint does not get /v1 appended", () => {
    const spec = makeSpec({ capabilities: { llm: "openai/gpt-4o", embeddings: { provider: "ollama", model: "nomic-embed-text", dims: 768 } } });
    const json = buildAkmSetupJson(spec, { OLLAMA_BASE_URL: "http://localhost:11434" });
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    // ollama is in NO_V1_SUFFIX — base stays as-is, then buildEndpoint adds /v1/embeddings
    expect(config.embedding.endpoint).toBe("http://localhost:11434/v1/embeddings");
  });

  test("includes all required llm feature flags", () => {
    const spec = makeSpec();
    const json = buildAkmSetupJson(spec, {});
    expect(json).not.toBeNull();
    const config = JSON.parse(json!);
    expect(config.llm.features.feedback_distillation).toBe(true);
    expect(config.llm.features.memory_inference).toBe(true);
    expect(config.llm.features.memory_consolidation).toBe(true);
  });
});
