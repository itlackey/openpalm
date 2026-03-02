/**
 * Tests for openmemory-config.ts — OpenMemory LLM & embedding config management.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  getDefaultConfig,
  readOpenMemoryConfig,
  writeOpenMemoryConfig,
  ensureOpenMemoryConfig,
  LLM_PROVIDERS,
  EMBED_PROVIDERS,
  EMBEDDING_DIMS,
  type OpenMemoryConfig,
} from "./openmemory-config.js";
import { makeTempDir, trackDir, registerCleanup } from "./test-helpers.js";

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

  test("returns config with qdrant vector store", () => {
    const config = getDefaultConfig();
    expect(config.mem0.vector_store.provider).toBe("qdrant");
    expect(config.mem0.vector_store.config.host).toBe("qdrant");
    expect(config.mem0.vector_store.config.port).toBe(6333);
    expect(config.mem0.vector_store.config.embedding_model_dims).toBe(1536);
  });

  test("uses env: syntax for API key references", () => {
    const config = getDefaultConfig();
    expect(config.mem0.llm.config.api_key).toBe("env:OPENAI_API_KEY");
    expect(config.mem0.embedder.config.api_key).toBe("env:OPENAI_API_KEY");
  });

  test("returns empty custom instructions", () => {
    const config = getDefaultConfig();
    expect(config.openmemory.custom_instructions).toBe("");
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

describe("readOpenMemoryConfig", () => {
  test("returns default config when file does not exist", () => {
    const dataDir = trackDir(makeTempDir());
    const config = readOpenMemoryConfig(dataDir);
    expect(config).toEqual(getDefaultConfig());
  });

  test("reads existing config file", () => {
    const dataDir = trackDir(makeTempDir());
    const custom: OpenMemoryConfig = {
      ...getDefaultConfig(),
      mem0: {
        ...getDefaultConfig().mem0,
        llm: { provider: "ollama", config: { model: "llama3" } },
      },
    };
    writeOpenMemoryConfig(dataDir, custom);

    const result = readOpenMemoryConfig(dataDir);
    expect(result.mem0.llm.provider).toBe("ollama");
    expect(result.mem0.llm.config.model).toBe("llama3");
  });

  test("returns default config on malformed JSON", () => {
    const dataDir = trackDir(makeTempDir());
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(join(dataDir, "openmemory"), { recursive: true });
    writeFileSync(
      join(dataDir, "openmemory", "default_config.json"),
      "not valid json {"
    );

    const config = readOpenMemoryConfig(dataDir);
    expect(config).toEqual(getDefaultConfig());
  });
});

describe("writeOpenMemoryConfig", () => {
  test("creates openmemory directory and writes JSON file", () => {
    const dataDir = trackDir(makeTempDir());
    const config = getDefaultConfig();
    config.mem0.llm.provider = "anthropic";

    writeOpenMemoryConfig(dataDir, config);

    const path = join(dataDir, "openmemory", "default_config.json");
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as OpenMemoryConfig;
    expect(parsed.mem0.llm.provider).toBe("anthropic");
  });

  test("overwrites existing config file", () => {
    const dataDir = trackDir(makeTempDir());
    const configA = getDefaultConfig();
    configA.mem0.llm.config.model = "model-a";
    writeOpenMemoryConfig(dataDir, configA);

    const configB = getDefaultConfig();
    configB.mem0.llm.config.model = "model-b";
    writeOpenMemoryConfig(dataDir, configB);

    const result = readOpenMemoryConfig(dataDir);
    expect(result.mem0.llm.config.model).toBe("model-b");
  });

  test("writes pretty-printed JSON with trailing newline", () => {
    const dataDir = trackDir(makeTempDir());
    writeOpenMemoryConfig(dataDir, getDefaultConfig());

    const raw = readFileSync(
      join(dataDir, "openmemory", "default_config.json"),
      "utf-8"
    );
    expect(raw).toContain("  ");
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("ensureOpenMemoryConfig", () => {
  test("creates default config when file does not exist", () => {
    const dataDir = trackDir(makeTempDir());
    ensureOpenMemoryConfig(dataDir);

    const path = join(dataDir, "openmemory", "default_config.json");
    expect(existsSync(path)).toBe(true);
    const config = JSON.parse(readFileSync(path, "utf-8")) as OpenMemoryConfig;
    expect(config.mem0.llm.provider).toBe("openai");
  });

  test("does not overwrite existing config (seed-once)", () => {
    const dataDir = trackDir(makeTempDir());
    const custom = getDefaultConfig();
    custom.mem0.llm.provider = "ollama";
    writeOpenMemoryConfig(dataDir, custom);

    ensureOpenMemoryConfig(dataDir);

    const result = readOpenMemoryConfig(dataDir);
    expect(result.mem0.llm.provider).toBe("ollama");
  });

  test("is idempotent — safe to call multiple times", () => {
    const dataDir = trackDir(makeTempDir());
    ensureOpenMemoryConfig(dataDir);
    ensureOpenMemoryConfig(dataDir);

    const config = readOpenMemoryConfig(dataDir);
    expect(config).toEqual(getDefaultConfig());
  });
});
