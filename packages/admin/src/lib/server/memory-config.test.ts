/**
 * Tests for memory-config.ts — Memory LLM & embedding config management.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  getDefaultConfig,
  readMemoryConfig,
  writeMemoryConfig,
  ensureMemoryConfig,
  resolveApiKey,
  resolveConfigForPush,
  fetchProviderModels,
  checkVectorDimensions,
  resetVectorStore,
  provisionMemoryUser,
  LLM_PROVIDERS,
  EMBED_PROVIDERS,
  EMBEDDING_DIMS,
  type MemoryConfig,
} from "./memory-config.js";
import { makeTempDir, trackDir, seedSecretsEnv, registerCleanup } from "./test-helpers.js";

registerCleanup();

// ── Constants ────────────────────────────────────────────────────────────

describe("LLM_PROVIDERS", () => {
  test("includes expected providers", () => {
    expect(LLM_PROVIDERS).toContain("openai");
    expect(LLM_PROVIDERS).toContain("anthropic");
    expect(LLM_PROVIDERS).toContain("ollama");
    expect(LLM_PROVIDERS).toContain("groq");
    expect(LLM_PROVIDERS).toContain("lmstudio");
  });

  test("has at least 5 providers", () => {
    expect(LLM_PROVIDERS.length).toBeGreaterThanOrEqual(5);
  });
});

describe("EMBED_PROVIDERS", () => {
  test("includes expected providers", () => {
    expect(EMBED_PROVIDERS).toContain("openai");
    expect(EMBED_PROVIDERS).toContain("ollama");
    expect(EMBED_PROVIDERS).toContain("huggingface");
  });
});

describe("EMBEDDING_DIMS", () => {
  test("has correct dimensions for known models", () => {
    expect(EMBEDDING_DIMS["openai/text-embedding-3-small"]).toBe(1536);
    expect(EMBEDDING_DIMS["openai/text-embedding-3-large"]).toBe(3072);
    expect(EMBEDDING_DIMS["ollama/nomic-embed-text"]).toBe(768);
    expect(EMBEDDING_DIMS["ollama/all-minilm"]).toBe(384);
  });
});

// ── Default Config ───────────────────────────────────────────────────────

describe("getDefaultConfig", () => {
  test("returns config with openai LLM provider", () => {
    const config = getDefaultConfig();
    expect(config.mem0.llm.provider).toBe("openai");
    expect(config.mem0.llm.config.model).toBe("gpt-4o-mini");
  });

  test("returns config with openai embedding provider", () => {
    const config = getDefaultConfig();
    expect(config.mem0.embedder.provider).toBe("openai");
    expect(config.mem0.embedder.config.model).toBe("text-embedding-3-small");
  });

  test("returns config with sqlite-vec vector store", () => {
    const config = getDefaultConfig();
    expect(config.mem0.vector_store.provider).toBe("sqlite-vec");
    expect(config.mem0.vector_store.config.db_path).toBe("/data/memory.db");
    expect(config.mem0.vector_store.config.embedding_model_dims).toBe(1536);
  });

  test("uses env: syntax for API key references", () => {
    const config = getDefaultConfig();
    expect(config.mem0.llm.config.api_key).toBe("env:OPENAI_API_KEY");
    expect(config.mem0.embedder.config.api_key).toBe("env:OPENAI_API_KEY");
  });

  test("returns empty custom instructions", () => {
    const config = getDefaultConfig();
    expect(config.memory.custom_instructions).toBe("");
  });

  test("returns a fresh copy on each call", () => {
    const a = getDefaultConfig();
    const b = getDefaultConfig();
    expect(a).toEqual(b);
    a.mem0.llm.provider = "changed";
    expect(b.mem0.llm.provider).toBe("openai");
  });
});

// ── File I/O ─────────────────────────────────────────────────────────────

describe("readMemoryConfig", () => {
  test("returns default config when file does not exist", () => {
    const dataDir = trackDir(makeTempDir());
    const config = readMemoryConfig(dataDir);
    expect(config).toEqual(getDefaultConfig());
  });

  test("reads existing config file", () => {
    const dataDir = trackDir(makeTempDir());
    const custom: MemoryConfig = {
      ...getDefaultConfig(),
      mem0: {
        ...getDefaultConfig().mem0,
        llm: { provider: "ollama", config: { model: "llama3" } },
      },
    };
    writeMemoryConfig(dataDir, custom);

    const result = readMemoryConfig(dataDir);
    expect(result.mem0.llm.provider).toBe("ollama");
    expect(result.mem0.llm.config.model).toBe("llama3");
  });

  test("returns default config on malformed JSON", () => {
    const dataDir = trackDir(makeTempDir());
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    writeFileSync(
      join(dataDir, "memory", "default_config.json"),
      "not valid json {"
    );

    const config = readMemoryConfig(dataDir);
    expect(config).toEqual(getDefaultConfig());
  });
});

describe("writeMemoryConfig", () => {
  test("creates memory directory and writes JSON file", () => {
    const dataDir = trackDir(makeTempDir());
    const config = getDefaultConfig();
    config.mem0.llm.provider = "anthropic";

    writeMemoryConfig(dataDir, config);

    const path = join(dataDir, "memory", "default_config.json");
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as MemoryConfig;
    expect(parsed.mem0.llm.provider).toBe("anthropic");
  });

  test("overwrites existing config file", () => {
    const dataDir = trackDir(makeTempDir());
    const configA = getDefaultConfig();
    configA.mem0.llm.config.model = "model-a";
    writeMemoryConfig(dataDir, configA);

    const configB = getDefaultConfig();
    configB.mem0.llm.config.model = "model-b";
    writeMemoryConfig(dataDir, configB);

    const result = readMemoryConfig(dataDir);
    expect(result.mem0.llm.config.model).toBe("model-b");
  });

  test("writes pretty-printed JSON with trailing newline", () => {
    const dataDir = trackDir(makeTempDir());
    writeMemoryConfig(dataDir, getDefaultConfig());

    const raw = readFileSync(
      join(dataDir, "memory", "default_config.json"),
      "utf-8"
    );
    expect(raw).toContain("  ");
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("ensureMemoryConfig", () => {
  test("creates default config when file does not exist", () => {
    const dataDir = trackDir(makeTempDir());
    ensureMemoryConfig(dataDir);

    const path = join(dataDir, "memory", "default_config.json");
    expect(existsSync(path)).toBe(true);
    const config = JSON.parse(readFileSync(path, "utf-8")) as MemoryConfig;
    expect(config.mem0.llm.provider).toBe("openai");
  });

  test("does not overwrite existing config (seed-once)", () => {
    const dataDir = trackDir(makeTempDir());
    const custom = getDefaultConfig();
    custom.mem0.llm.provider = "ollama";
    writeMemoryConfig(dataDir, custom);

    ensureMemoryConfig(dataDir);

    const result = readMemoryConfig(dataDir);
    expect(result.mem0.llm.provider).toBe("ollama");
  });

  test("is idempotent — safe to call multiple times", () => {
    const dataDir = trackDir(makeTempDir());
    ensureMemoryConfig(dataDir);
    ensureMemoryConfig(dataDir);

    const config = readMemoryConfig(dataDir);
    expect(config).toEqual(getDefaultConfig());
  });
});

// ── API Key Resolution ────────────────────────────────────────────────────

describe("resolveApiKey", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env after each test
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("returns empty string for empty input", () => {
    const configDir = trackDir(makeTempDir());
    expect(resolveApiKey("", configDir)).toBe("");
  });

  test("returns raw value when not using env: prefix", () => {
    const configDir = trackDir(makeTempDir());
    expect(resolveApiKey("sk-1234567890", configDir)).toBe("sk-1234567890");
  });

  test("resolves env: reference from process.env", () => {
    const configDir = trackDir(makeTempDir());
    process.env.TEST_API_KEY_RESOLVE = "from-process-env";
    expect(resolveApiKey("env:TEST_API_KEY_RESOLVE", configDir)).toBe("from-process-env");
  });

  test("falls back to secrets.env when not in process.env", () => {
    const configDir = trackDir(makeTempDir());
    delete process.env.TEST_SECRET_KEY;
    seedSecretsEnv(configDir, "TEST_SECRET_KEY=from-secrets-file\n");
    expect(resolveApiKey("env:TEST_SECRET_KEY", configDir)).toBe("from-secrets-file");
  });

  test("prefers process.env over secrets.env", () => {
    const configDir = trackDir(makeTempDir());
    process.env.PRIORITY_KEY = "from-env";
    seedSecretsEnv(configDir, "PRIORITY_KEY=from-secrets\n");
    expect(resolveApiKey("env:PRIORITY_KEY", configDir)).toBe("from-env");
  });

  test("returns empty string when env: var not found anywhere", () => {
    const configDir = trackDir(makeTempDir());
    delete process.env.NONEXISTENT_KEY;
    expect(resolveApiKey("env:NONEXISTENT_KEY", configDir)).toBe("");
  });
});

// ── Provider Model Listing ────────────────────────────────────────────────

describe("fetchProviderModels", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(response: Response | Error) {
    mockFetch = vi.fn();
    if (response instanceof Error) {
      mockFetch.mockRejectedValue(response);
    } else {
      mockFetch.mockResolvedValue(response);
    }
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  }

  test("returns static list for anthropic provider", async () => {
    const configDir = trackDir(makeTempDir());
    const result = await fetchProviderModels("anthropic", "", "", configDir);
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models).toContain("claude-opus-4-20250514");
    expect(result.models).toContain("claude-sonnet-4-20250514");
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('provider_static');
    expect(result.error).toBeUndefined();
  });

  test("does not call fetch for anthropic", async () => {
    stubFetch(new Error("should not be called"));
    const configDir = trackDir(makeTempDir());
    const result = await fetchProviderModels("anthropic", "", "", configDir);
    expect(result.models.length).toBeGreaterThan(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("calls Ollama /api/tags endpoint", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ models: [{ name: "llama3:latest" }, { name: "qwen2.5:14b" }] }),
        { status: 200 }
      )
    );
    const configDir = trackDir(makeTempDir());

    const result = await fetchProviderModels("ollama", "", "http://localhost:11434", configDir);
    expect(result.models).toEqual(["llama3:latest", "qwen2.5:14b"]);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('none');
    expect(result.error).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  test("uses default Ollama URL when base URL is empty", async () => {
    stubFetch(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const configDir = trackDir(makeTempDir());

    await fetchProviderModels("ollama", "", "", configDir);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://host.docker.internal:11434/api/tags",
      expect.anything()
    );
  });

  test("calls OpenAI-compatible /v1/models for other providers", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
        { status: 200 }
      )
    );
    const configDir = trackDir(makeTempDir());

    const result = await fetchProviderModels("openai", "sk-test", "", configDir);
    expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(result.error).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      })
    );
  });

  test("returns sorted model list from OpenAI-compatible API", async () => {
    stubFetch(
      new Response(
        JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "m-model" }] }),
        { status: 200 }
      )
    );
    const configDir = trackDir(makeTempDir());

    const result = await fetchProviderModels("groq", "key", "", configDir);
    expect(result.models).toEqual(["a-model", "m-model", "z-model"]);
  });

  test("returns error on non-OK response from Ollama", async () => {
    stubFetch(new Response("", { status: 500 }));
    const configDir = trackDir(makeTempDir());

    const result = await fetchProviderModels("ollama", "", "http://localhost:11434", configDir);
    expect(result.models).toEqual([]);
    expect(result.status).toBe('recoverable_error');
    expect(result.reason).toBe('provider_http');
    expect(result.error).toContain("500");
  });

  test("returns error on non-OK response from OpenAI-compatible API", async () => {
    stubFetch(new Response("Unauthorized", { status: 401 }));
    const configDir = trackDir(makeTempDir());

    const result = await fetchProviderModels("openai", "bad-key", "", configDir);
    expect(result.models).toEqual([]);
    expect(result.status).toBe('recoverable_error');
    expect(result.reason).toBe('provider_http');
    expect(result.error).toContain("401");
  });

  test("returns error when no base URL configured for unknown provider", async () => {
    const configDir = trackDir(makeTempDir());
    const result = await fetchProviderModels("unknown-provider", "", "", configDir);
    expect(result.models).toEqual([]);
    expect(result.status).toBe('recoverable_error');
    expect(result.reason).toBe('missing_base_url');
    expect(result.error).toContain("No base URL");
  });

  test("handles fetch error gracefully (never throws)", async () => {
    stubFetch(new Error("Connection refused"));
    const configDir = trackDir(makeTempDir());

    const result = await fetchProviderModels("ollama", "", "http://localhost:11434", configDir);
    expect(result.models).toEqual([]);
    expect(result.status).toBe('recoverable_error');
    expect(result.reason).toBe('network');
    expect(result.error).toContain("Connection refused");
  });

  test("handles timeout error with descriptive message", async () => {
    const timeoutErr = new DOMException("The operation was aborted.", "TimeoutError");
    stubFetch(timeoutErr);
    const configDir = trackDir(makeTempDir());

    const result = await fetchProviderModels("ollama", "", "http://localhost:11434", configDir);
    expect(result.models).toEqual([]);
    expect(result.status).toBe('recoverable_error');
    expect(result.reason).toBe('timeout');
    expect(result.error).toContain("timed out");
  });

  test("strips trailing slashes from base URL", async () => {
    stubFetch(new Response(JSON.stringify({ models: [] }), { status: 200 }));
    const configDir = trackDir(makeTempDir());

    await fetchProviderModels("ollama", "", "http://localhost:11434///", configDir);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.anything()
    );
  });

  test("omits Authorization header when API key is empty", async () => {
    stubFetch(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const configDir = trackDir(makeTempDir());

    await fetchProviderModels("lmstudio", "", "", configDir);
    const callArgs = mockFetch.mock.calls[0];
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ── resolveConfigForPush ──────────────────────────────────────────────

describe("resolveConfigForPush", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("resolves env: references in llm api_key", () => {
    const configDir = trackDir(makeTempDir());
    process.env.OPENAI_API_KEY = "sk-resolved-key";

    const config = getDefaultConfig();
    config.mem0.llm.config.api_key = "env:OPENAI_API_KEY";

    const resolved = resolveConfigForPush(config, configDir);
    expect(resolved.mem0.llm.config.api_key).toBe("sk-resolved-key");
  });

  test("resolves env: references in embedder api_key", () => {
    const configDir = trackDir(makeTempDir());
    process.env.OPENAI_API_KEY = "sk-embed-key";

    const config = getDefaultConfig();
    config.mem0.embedder.config.api_key = "env:OPENAI_API_KEY";

    const resolved = resolveConfigForPush(config, configDir);
    expect(resolved.mem0.embedder.config.api_key).toBe("sk-embed-key");
  });

  test("passes through raw API keys unchanged", () => {
    const configDir = trackDir(makeTempDir());

    const config = getDefaultConfig();
    config.mem0.llm.config.api_key = "sk-raw-key-12345";

    const resolved = resolveConfigForPush(config, configDir);
    expect(resolved.mem0.llm.config.api_key).toBe("sk-raw-key-12345");
  });

  test("does not mutate the original config", () => {
    const configDir = trackDir(makeTempDir());
    process.env.OPENAI_API_KEY = "resolved";

    const config = getDefaultConfig();
    const originalApiKey = config.mem0.llm.config.api_key;

    resolveConfigForPush(config, configDir);
    expect(config.mem0.llm.config.api_key).toBe(originalApiKey);
  });

  test("falls back to secrets.env for env: refs not in process.env", () => {
    const configDir = trackDir(makeTempDir());
    delete process.env.MY_CUSTOM_KEY;
    seedSecretsEnv(configDir, "MY_CUSTOM_KEY=from-secrets\n");

    const config = getDefaultConfig();
    config.mem0.llm.config.api_key = "env:MY_CUSTOM_KEY";

    const resolved = resolveConfigForPush(config, configDir);
    expect(resolved.mem0.llm.config.api_key).toBe("from-secrets");
  });

  test("handles config without api_key fields", () => {
    const configDir = trackDir(makeTempDir());

    const config = getDefaultConfig();
    delete (config.mem0.llm.config as Record<string, unknown>).api_key;
    delete (config.mem0.embedder.config as Record<string, unknown>).api_key;

    const resolved = resolveConfigForPush(config, configDir);
    expect(resolved.mem0.llm.config.api_key).toBeUndefined();
    expect(resolved.mem0.embedder.config.api_key).toBeUndefined();
  });
});

// ── checkVectorDimensions ─────────────────────────────────────────────

describe("checkVectorDimensions", () => {
  test("returns match=true when dimensions agree", () => {
    const dataDir = trackDir(makeTempDir());
    const persisted = getDefaultConfig();
    writeMemoryConfig(dataDir, persisted);

    const newConfig = getDefaultConfig();
    const result = checkVectorDimensions(dataDir, newConfig);
    expect(result.match).toBe(true);
    expect(result.currentDims).toBe(1536);
    expect(result.expectedDims).toBe(1536);
  });

  test("returns match=false when dimensions differ", () => {
    const dataDir = trackDir(makeTempDir());
    const persisted = getDefaultConfig();
    writeMemoryConfig(dataDir, persisted);

    const newConfig = getDefaultConfig();
    newConfig.mem0.vector_store.config.embedding_model_dims = 3072;
    const result = checkVectorDimensions(dataDir, newConfig);
    expect(result.match).toBe(false);
    expect(result.currentDims).toBe(1536);
    expect(result.expectedDims).toBe(3072);
  });

  test("returns match=true when no persisted config exists (uses defaults)", () => {
    const dataDir = trackDir(makeTempDir());
    const newConfig = getDefaultConfig();
    const result = checkVectorDimensions(dataDir, newConfig);
    expect(result.match).toBe(true);
  });
});

// ── resetVectorStore ─────────────────────────────────────────────

describe("resetVectorStore", () => {
  test("returns ok=true when qdrant directory exists", () => {
    const dataDir = trackDir(makeTempDir());
    const { mkdirSync } = require("node:fs");
    mkdirSync(join(dataDir, "memory", "qdrant", "collections"), { recursive: true });

    const result = resetVectorStore(dataDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(dataDir, "memory", "qdrant"))).toBe(false);
  });

  test("returns ok=true when qdrant directory does not exist", () => {
    const dataDir = trackDir(makeTempDir());
    const result = resetVectorStore(dataDir);
    expect(result.ok).toBe(true);
  });

  test("cleans up nested qdrant data", () => {
    const dataDir = trackDir(makeTempDir());
    const { mkdirSync, writeFileSync } = require("node:fs");
    const qdrantDir = join(dataDir, "memory", "qdrant");
    mkdirSync(join(qdrantDir, "collections", "memory"), { recursive: true });
    writeFileSync(join(qdrantDir, "collections", "memory", "data.bin"), "test");

    const result = resetVectorStore(dataDir);
    expect(result.ok).toBe(true);
    expect(existsSync(qdrantDir)).toBe(false);
  });
});

describe("resetVectorStore container path translation", () => {
  test("translates /data/ prefix to dataDir", () => {
    const dataDir = trackDir(makeTempDir());
    const { mkdirSync, writeFileSync } = require("node:fs");
    // Write config with container-style db_path
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    writeFileSync(
      join(dataDir, "memory", "default_config.json"),
      JSON.stringify({
        mem0: {
          llm: { provider: "openai", config: {} },
          embedder: { provider: "openai", config: {} },
          vector_store: {
            provider: "sqlite-vec",
            config: {
              collection_name: "memory",
              db_path: "/data/memory.db",
              embedding_model_dims: 1536,
            },
          },
        },
        memory: { custom_instructions: "" },
      })
    );

    // Create the DB file at the translated host path
    // /data/memory.db → ${dataDir}/memory/memory.db (since /data mounts to ${dataDir}/memory)
    writeFileSync(join(dataDir, "memory", "memory.db"), "fake-db");

    const result = resetVectorStore(dataDir);
    expect(result.ok).toBe(true);
    // The file at the translated path should be deleted
    expect(existsSync(join(dataDir, "memory", "memory.db"))).toBe(false);
  });

  test("resolves relative db_path under dataDir/memory/", () => {
    const dataDir = trackDir(makeTempDir());
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    writeFileSync(
      join(dataDir, "memory", "default_config.json"),
      JSON.stringify({
        mem0: {
          llm: { provider: "openai", config: {} },
          embedder: { provider: "openai", config: {} },
          vector_store: {
            provider: "sqlite-vec",
            config: {
              collection_name: "memory",
              db_path: "custom.db",
              embedding_model_dims: 1536,
            },
          },
        },
        memory: { custom_instructions: "" },
      })
    );
    writeFileSync(join(dataDir, "memory", "custom.db"), "fake-db");

    const result = resetVectorStore(dataDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(dataDir, "memory", "custom.db"))).toBe(false);
  });

  test("uses default path when db_path not configured", () => {
    const dataDir = trackDir(makeTempDir());
    const result = resetVectorStore(dataDir);
    expect(result.ok).toBe(true);
  });

  test("removes WAL and SHM files alongside db", () => {
    const dataDir = trackDir(makeTempDir());
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    const dbPath = join(dataDir, "memory", "memory.db");
    writeFileSync(dbPath, "fake-db");
    writeFileSync(`${dbPath}-wal`, "fake-wal");
    writeFileSync(`${dbPath}-shm`, "fake-shm");

    const result = resetVectorStore(dataDir);
    expect(result.ok).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

describe("provisionMemoryUser", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns ok=false when the memory API responds with an error status", async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"detail":"error"}', { status: 500 })) as unknown as typeof fetch;

    const result = await provisionMemoryUser("test-user");
    expect(result.ok).toBe(false);
  });

  test("returns ok=false with error message when fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;

    const result = await provisionMemoryUser("test-user");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("connection refused");
  });

  test("returns ok=true when the memory API responds successfully", async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 })) as unknown as typeof fetch;

    const result = await provisionMemoryUser("test-user");
    expect(result).toEqual({ ok: true });
  });
});
