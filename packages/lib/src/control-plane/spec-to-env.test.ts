import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSystemEnvFromSpec, deriveMemoryEnv, deriveAddonEnv, writeManagedEnvFiles } from "./spec-to-env.js";
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

describe("deriveAddonEnv", () => {
  test("ignores non-string addon env values from malformed stack specs", () => {
    const spec = makeSpec({
      addons: {
        memory: {
          env: {
            GOOD: "@secret:OPENAI_API_KEY",
            BAD_NUMBER: 123 as unknown as string,
            BAD_NULL: null as unknown as string,
          },
        },
      },
    });

    expect(deriveAddonEnv(spec, "memory")).toEqual({
      GOOD: "${OPENAI_API_KEY}",
    });
  });
});

describe("writeManagedEnvFiles", () => {
  test("quotes special characters and writes secure managed env files", () => {
    const spec = makeSpec({
      capabilities: {
        llm: "openai/gpt-4o",
        embeddings: { provider: "openai", model: "text embedding #1", dims: 1536 },
        memory: { userId: "default user" },
      },
      addons: {
        demo: {
          env: {
            SECRET_REF: "@secret:OPENAI_API_KEY",
            PLAIN: "value with spaces #comment",
          },
        },
      },
    });

    writeManagedEnvFiles(spec, join(tempDir, "vault"));

    const memoryPath = join(tempDir, "vault", "stack", "services", "memory", "managed.env");
    const addonPath = join(tempDir, "vault", "stack", "addons", "demo", "managed.env");

    const memoryContent = readFileSync(memoryPath, "utf-8");
    const addonContent = readFileSync(addonPath, "utf-8");

    expect(memoryContent).toContain("EMBEDDING_MODEL='text embedding #1'");
    expect(memoryContent).toContain("MEMORY_USER_ID=default user");
    expect(addonContent).toContain("SECRET_REF='${OPENAI_API_KEY}'");
    expect(addonContent).toContain("PLAIN='value with spaces #comment'");
    expect(statSync(memoryPath).mode & 0o777).toBe(0o600);
    expect(statSync(addonPath).mode & 0o777).toBe(0o600);
  });
});
