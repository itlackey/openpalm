/**
 * Tests for model-runner.ts — Docker Model Runner integration.
 *
 * Verifies:
 * 1. isValidModelName rejects invalid/malicious inputs
 * 2. generateModelOverlayYaml produces correct compose YAML
 * 3. parseLocalModelsCompose round-trips with generateModelOverlayYaml
 * 4. Embedding dimensions persist through YAML round-trip
 * 5. readLocalModelsCompose/writeLocalModelsCompose filesystem operations
 * 6. HuggingFace model ref parsing
 * 7. applyLocalModelsToOpenMemory shared helper
 * 8. JSON metadata sidecar read/write
 * 9. CONFIG_HOME → DATA_HOME migration
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidModelName,
  generateModelOverlayYaml,
  parseLocalModelsCompose,
  readLocalModelsCompose,
  writeLocalModelsCompose,
  parseHfRef,
  applyLocalModelsToOpenMemory,
  readLocalModelsMeta,
  writeLocalModelsMeta,
  updateModelMetadata,
  migrateLocalModelsToDataDir,
  buildModelRestartServices,
  SUGGESTED_SYSTEM_MODELS,
  SUGGESTED_EMBEDDING_MODELS,
  LOCAL_EMBEDDING_DIMS,
  type LocalModelSelection,
} from "./model-runner.js";
import type { OpenMemoryConfig } from "./openmemory-config.js";

// ── isValidModelName ────────────────────────────────────────────────────

describe("isValidModelName", () => {
  test("accepts ai/ prefixed models", () => {
    expect(isValidModelName("ai/llama3.2:3B-Q4_K_M")).toBe(true);
    expect(isValidModelName("ai/all-minilm")).toBe(true);
    expect(isValidModelName("ai/phi4-mini")).toBe(true);
  });

  test("accepts hf.co/ prefixed models", () => {
    expect(isValidModelName("hf.co/user/model-name")).toBe(true);
    expect(isValidModelName("hf.co/org/model:tag")).toBe(true);
    expect(isValidModelName("hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidModelName("")).toBe(false);
  });

  test("rejects models without valid prefix", () => {
    expect(isValidModelName("llama3")).toBe(false);
    expect(isValidModelName("openai/gpt-4")).toBe(false);
    expect(isValidModelName("local/model")).toBe(false);
  });

  test("rejects models with newlines (YAML injection)", () => {
    expect(isValidModelName("ai/model\nmalicious: true")).toBe(false);
    expect(isValidModelName("ai/model\r\nevil: yes")).toBe(false);
  });

  test("rejects models with spaces", () => {
    expect(isValidModelName("ai/model name")).toBe(false);
    expect(isValidModelName("ai/model\tname")).toBe(false);
  });

  test("rejects models with control characters", () => {
    expect(isValidModelName("ai/model\x00name")).toBe(false);
    expect(isValidModelName("ai/model\x1fname")).toBe(false);
    expect(isValidModelName("ai/model\x7fname")).toBe(false);
  });

  test("rejects models with special YAML characters", () => {
    expect(isValidModelName("ai/model{inject}")).toBe(false);
    expect(isValidModelName("ai/model;drop")).toBe(false);
  });
});

// ── parseHfRef ────────────────────────────────────────────────────────────

describe("parseHfRef", () => {
  test("parses valid HF refs", () => {
    expect(parseHfRef("hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF")).toEqual({
      repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    });
    expect(parseHfRef("hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF")).toEqual({
      repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    });
  });

  test("returns null for non-HF refs", () => {
    expect(parseHfRef("ai/llama3.2:3B-Q4_K_M")).toBeNull();
    expect(parseHfRef("local/model")).toBeNull();
  });

  test("returns null for malformed HF refs", () => {
    expect(parseHfRef("hf.co/")).toBeNull();
    expect(parseHfRef("hf.co/no-slash")).toBeNull();
  });
});

// ── Model catalog ─────────────────────────────────────────────────────────

describe("model catalog", () => {
  test("suggested system models use HF refs as primary", () => {
    for (const model of SUGGESTED_SYSTEM_MODELS) {
      expect(model.id).toMatch(/^hf\.co\//);
    }
  });

  test("suggested embedding models use HF refs as primary", () => {
    for (const model of SUGGESTED_EMBEDDING_MODELS) {
      expect(model.id).toMatch(/^hf\.co\//);
    }
  });

  test("LOCAL_EMBEDDING_DIMS includes both HF and legacy entries", () => {
    // HF entries
    expect(LOCAL_EMBEDDING_DIMS["hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF"]).toBe(768);
    expect(LOCAL_EMBEDDING_DIMS["hf.co/ChristianAzinn/all-MiniLM-L6-v2-gguf"]).toBe(384);
    // Legacy ai/ entries
    expect(LOCAL_EMBEDDING_DIMS["ai/all-minilm"]).toBe(384);
    expect(LOCAL_EMBEDDING_DIMS["ai/nomic-embed-text"]).toBe(768);
  });
});

// ── generateModelOverlayYaml ─────────────────────────────────────────────

describe("generateModelOverlayYaml", () => {
  const testUrl = "http://model-runner.docker.internal:12434";

  test("generates YAML with system model only", () => {
    const yaml = generateModelOverlayYaml({
      systemModel: { model: "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF", contextSize: 131072 },
    }, testUrl);
    expect(yaml).toContain("# local-llm: hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF");
    expect(yaml).toContain("# context_size: 131072");
    expect(yaml).not.toContain("# local-embedding:");
    // Overlay only provides extra_hosts, no LOCAL_* env vars
    expect(yaml).not.toContain("LOCAL_LLM_MODEL");
    expect(yaml).not.toContain("environment:");
  });

  test("generates YAML with embedding model only", () => {
    const yaml = generateModelOverlayYaml({
      embeddingModel: { model: "hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF", dimensions: 768 },
    }, testUrl);
    expect(yaml).toContain("# local-embedding: hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF");
    expect(yaml).toContain("# embedding_dims: 768");
    expect(yaml).not.toContain("# local-llm:");
    expect(yaml).not.toContain("LOCAL_EMBEDDING_MODEL");
    expect(yaml).not.toContain("environment:");
  });

  test("generates YAML with both models", () => {
    const yaml = generateModelOverlayYaml({
      systemModel: { model: "ai/mistral", contextSize: 4096 },
      embeddingModel: { model: "ai/nomic-embed-text", dimensions: 768 },
    }, testUrl);
    expect(yaml).toContain("# local-llm: ai/mistral");
    expect(yaml).toContain("# local-embedding: ai/nomic-embed-text");
    expect(yaml).toContain("# embedding_dims: 768");
  });

  test("returns empty string when no models", () => {
    expect(generateModelOverlayYaml({})).toBe("");
  });

  test("omits context_size when not specified", () => {
    const yaml = generateModelOverlayYaml({
      systemModel: { model: "ai/smollm2" },
    }, testUrl);
    expect(yaml).toContain("# local-llm: ai/smollm2");
    expect(yaml).not.toContain("context_size");
  });

  test("includes services section with extra_hosts only (no environment vars)", () => {
    const yaml = generateModelOverlayYaml({
      systemModel: { model: "ai/mistral" },
    }, testUrl);
    expect(yaml).toContain("services:");
    expect(yaml).toContain("guardian:");
    expect(yaml).toContain("model-runner.docker.internal:host-gateway");
    // No LOCAL_* environment vars — config flows through secrets.env
    expect(yaml).not.toContain("environment:");
    expect(yaml).not.toContain("LOCAL_LLM_URL");
    expect(yaml).not.toContain("LOCAL_LLM_MODEL");
  });

  test("does not use models: top-level element", () => {
    const yaml = generateModelOverlayYaml({
      systemModel: { model: "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF" },
    }, testUrl);
    // Should not have models: as a YAML key (only in comments)
    expect(yaml).not.toMatch(/^models:/m);
  });

  test("does not include model runner URL in environment vars", () => {
    const yaml = generateModelOverlayYaml(
      { systemModel: { model: "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF" } },
      "http://model-runner.docker.internal/engines",
    );
    // Config flows through secrets.env, not compose overlay
    expect(yaml).not.toContain("LOCAL_LLM_URL");
    expect(yaml).not.toContain("environment:");
  });
});

// ── parseLocalModelsCompose ──────────────────────────────────────────────

describe("parseLocalModelsCompose", () => {
  test("parses system model from new comment format", () => {
    const yaml = [
      "# Local AI models — managed by OpenPalm admin",
      "# local-llm: hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF",
      "# context_size: 131072",
      "",
      "services:",
    ].join("\n");

    const result = parseLocalModelsCompose(yaml);
    expect(result.systemModel).toEqual({
      model: "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF",
      contextSize: 131072,
    });
    expect(result.embeddingModel).toBeUndefined();
  });

  test("parses embedding model from new comment format", () => {
    const yaml = [
      "# local-embedding: hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF",
      "# embedding_dims: 768",
    ].join("\n");

    const result = parseLocalModelsCompose(yaml);
    expect(result.embeddingModel).toEqual({
      model: "hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF",
      dimensions: 768,
    });
  });

  test("parses legacy models: format (backward compat)", () => {
    const yaml = [
      "models:",
      "  local-llm:",
      "    model: ai/mistral",
      "    context_size: 4096",
    ].join("\n");

    const result = parseLocalModelsCompose(yaml);
    expect(result.systemModel).toEqual({
      model: "ai/mistral",
      contextSize: 4096,
    });
  });

  test("parses legacy embedding with dimensions comment", () => {
    const yaml = [
      "models:",
      "  local-embedding:",
      "    model: ai/all-minilm",
      "    # dimensions: 384",
    ].join("\n");

    const result = parseLocalModelsCompose(yaml);
    expect(result.embeddingModel?.dimensions).toBe(384);
  });

  test("falls back to lookup table when no persisted dimensions", () => {
    const yaml = "# local-embedding: ai/all-minilm\n";
    const result = parseLocalModelsCompose(yaml);
    expect(result.embeddingModel?.dimensions).toBe(384);
  });

  test("falls back to 384 for unknown model without persisted dims", () => {
    const yaml = "# local-embedding: hf.co/custom/embed-model\n";
    const result = parseLocalModelsCompose(yaml);
    expect(result.embeddingModel?.dimensions).toBe(384);
  });

  test("returns empty selection for empty YAML", () => {
    const result = parseLocalModelsCompose("");
    expect(result).toEqual({});
  });
});

// ── Round-trip ────────────────────────────────────────────────────────────

describe("generate → parse round-trip", () => {
  const testUrl = "http://model-runner.docker.internal:12434";

  test("system model round-trips correctly", () => {
    const original: LocalModelSelection = {
      systemModel: { model: "ai/mistral", contextSize: 4096 },
    };
    const yaml = generateModelOverlayYaml(original, testUrl);
    const parsed = parseLocalModelsCompose(yaml);
    expect(parsed.systemModel).toEqual(original.systemModel);
  });

  test("embedding model round-trips with custom dimensions", () => {
    const original: LocalModelSelection = {
      embeddingModel: { model: "hf.co/custom/model", dimensions: 1024 },
    };
    const yaml = generateModelOverlayYaml(original, testUrl);
    const parsed = parseLocalModelsCompose(yaml);
    expect(parsed.embeddingModel).toEqual(original.embeddingModel);
  });

  test("both models round-trip correctly", () => {
    const original: LocalModelSelection = {
      systemModel: { model: "hf.co/bartowski/Phi-4-mini-instruct-GGUF", contextSize: 16384 },
      embeddingModel: { model: "hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF", dimensions: 768 },
    };
    const yaml = generateModelOverlayYaml(original, testUrl);
    const parsed = parseLocalModelsCompose(yaml);
    expect(parsed.systemModel).toEqual(original.systemModel);
    expect(parsed.embeddingModel).toEqual(original.embeddingModel);
  });

  test("legacy ai/ models still round-trip", () => {
    const original: LocalModelSelection = {
      systemModel: { model: "ai/phi4-mini", contextSize: 4096 },
      embeddingModel: { model: "ai/nomic-embed-text", dimensions: 768 },
    };
    const yaml = generateModelOverlayYaml(original, testUrl);
    const parsed = parseLocalModelsCompose(yaml);
    expect(parsed.systemModel).toEqual(original.systemModel);
    expect(parsed.embeddingModel).toEqual(original.embeddingModel);
  });
});

// ── Filesystem: readLocalModelsCompose / writeLocalModelsCompose ──────────

describe("readLocalModelsCompose / writeLocalModelsCompose", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "model-runner-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null when file does not exist", () => {
    expect(readLocalModelsCompose(tmpDir)).toBeNull();
  });

  test("write then read round-trips", () => {
    const selection: LocalModelSelection = {
      systemModel: { model: "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF", contextSize: 131072 },
      embeddingModel: { model: "hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF", dimensions: 768 },
    };
    writeLocalModelsCompose(tmpDir, selection);
    const result = readLocalModelsCompose(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.systemModel).toEqual(selection.systemModel);
    expect(result!.embeddingModel).toEqual(selection.embeddingModel);
  });

  test("writing empty selection deletes the file", () => {
    // Write first, then clear
    writeLocalModelsCompose(tmpDir, {
      systemModel: { model: "ai/mistral" },
    });
    expect(readLocalModelsCompose(tmpDir)).not.toBeNull();

    writeLocalModelsCompose(tmpDir, {});
    expect(readLocalModelsCompose(tmpDir)).toBeNull();
  });

  test("creates parent directory if needed", () => {
    const nestedDir = join(tmpDir, "nested", "data");
    writeLocalModelsCompose(nestedDir, {
      systemModel: { model: "ai/smollm2" },
    });
    expect(readLocalModelsCompose(nestedDir)).not.toBeNull();
  });

  test("reads from configDir as fallback (migration)", () => {
    const dataDir = join(tmpDir, "data");
    const configDir = join(tmpDir, "config");
    mkdirSync(configDir, { recursive: true });

    // Write to CONFIG_HOME (legacy location)
    writeFileSync(join(configDir, "local-models.yml"),
      generateModelOverlayYaml({ systemModel: { model: "ai/mistral", contextSize: 4096 } }, "http://localhost")
    );

    // Read should find it via configDir fallback and copy to dataDir
    const result = readLocalModelsCompose(dataDir, configDir);
    expect(result).not.toBeNull();
    expect(result!.systemModel?.model).toBe("ai/mistral");

    // File should now exist in dataDir too
    expect(existsSync(join(dataDir, "local-models.yml"))).toBe(true);
  });
});

// ── Metadata sidecar ──────────────────────────────────────────────────────

describe("metadata sidecar", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "model-runner-meta-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads empty metadata when file missing", () => {
    const meta = readLocalModelsMeta(tmpDir);
    expect(meta).toEqual({ models: {} });
  });

  test("writes and reads metadata", () => {
    const meta = {
      models: {
        "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF": {
          source: "huggingface" as const,
          pipelineTag: "text-generation",
          downloads: 10000,
          status: "ready" as const,
          downloadedAt: "2024-01-01T00:00:00Z",
        },
      },
    };
    writeLocalModelsMeta(tmpDir, meta);
    const result = readLocalModelsMeta(tmpDir);
    expect(result).toEqual(meta);
  });

  test("updateModelMetadata merges fields", () => {
    updateModelMetadata(tmpDir, "hf.co/test/model", {
      source: "huggingface",
      status: "pending",
    });
    updateModelMetadata(tmpDir, "hf.co/test/model", {
      status: "ready",
      downloadedAt: "2024-01-01T00:00:00Z",
    });
    const meta = readLocalModelsMeta(tmpDir);
    expect(meta.models["hf.co/test/model"]).toEqual({
      source: "huggingface",
      status: "ready",
      downloadedAt: "2024-01-01T00:00:00Z",
    });
  });
});

// ── Migration ─────────────────────────────────────────────────────────────

describe("migrateLocalModelsToDataDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "model-runner-migrate-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("copies from CONFIG_HOME to DATA_HOME", () => {
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");
    mkdirSync(configDir, { recursive: true });

    const content = generateModelOverlayYaml({ systemModel: { model: "ai/mistral" } }, "http://localhost");
    writeFileSync(join(configDir, "local-models.yml"), content);

    migrateLocalModelsToDataDir(configDir, dataDir);

    expect(existsSync(join(dataDir, "local-models.yml"))).toBe(true);
    expect(readFileSync(join(dataDir, "local-models.yml"), "utf-8")).toBe(content);
  });

  test("no-op if DATA_HOME copy already exists", () => {
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(join(configDir, "local-models.yml"), "old-content");
    writeFileSync(join(dataDir, "local-models.yml"), "new-content");

    migrateLocalModelsToDataDir(configDir, dataDir);

    // DATA_HOME copy should not be overwritten
    expect(readFileSync(join(dataDir, "local-models.yml"), "utf-8")).toBe("new-content");
  });

  test("no-op if CONFIG_HOME has no file", () => {
    const configDir = join(tmpDir, "config");
    const dataDir = join(tmpDir, "data");
    mkdirSync(configDir, { recursive: true });

    migrateLocalModelsToDataDir(configDir, dataDir);

    expect(existsSync(join(dataDir, "local-models.yml"))).toBe(false);
  });
});

// ── applyLocalModelsToOpenMemory ──────────────────────────────────────────

describe("applyLocalModelsToOpenMemory", () => {
  // modelRunnerUrl follows the new convention: base URL without /v1
  const modelRunnerUrl = "http://model-runner.docker.internal/engines";

  function makeBaseConfig(): OpenMemoryConfig {
    return {
      mem0: {
        llm: { provider: "openai", config: {} },
        embedder: { provider: "openai", config: {} },
        vector_store: {
          provider: "qdrant",
          config: { collection_name: "openmemory", path: "/data/qdrant", embedding_model_dims: 1536 },
        },
      },
      openmemory: { custom_instructions: "" },
    };
  }

  test("applies system model to LLM config", () => {
    const config = makeBaseConfig();
    applyLocalModelsToOpenMemory(config, {
      systemModel: { model: "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF" },
    }, modelRunnerUrl);

    expect(config.mem0.llm.provider).toBe("openai");
    expect(config.mem0.llm.config.model).toBe("hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF");
    // mem0 expects base_url with /v1 (it appends /chat/completions directly)
    expect(config.mem0.llm.config.base_url).toBe("http://model-runner.docker.internal/engines/v1");
  });

  test("applies embedding model to embedder config", () => {
    const config = makeBaseConfig();
    applyLocalModelsToOpenMemory(config, {
      embeddingModel: { model: "hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF", dimensions: 768 },
    }, modelRunnerUrl);

    expect(config.mem0.embedder.provider).toBe("openai");
    expect(config.mem0.embedder.config.model).toBe("hf.co/nomic-ai/nomic-embed-text-v1.5-GGUF");
    expect(config.mem0.vector_store.config.embedding_model_dims).toBe(768);
  });

  test("applies both models", () => {
    const config = makeBaseConfig();
    applyLocalModelsToOpenMemory(config, {
      systemModel: { model: "ai/mistral" },
      embeddingModel: { model: "ai/all-minilm", dimensions: 384 },
    }, modelRunnerUrl);

    expect(config.mem0.llm.config.model).toBe("ai/mistral");
    expect(config.mem0.embedder.config.model).toBe("ai/all-minilm");
    expect(config.mem0.vector_store.config.embedding_model_dims).toBe(384);
  });
});

// ── buildModelRestartServices ─────────────────────────────────────────────

describe("buildModelRestartServices", () => {
  test("returns empty for no flags", () => {
    expect(buildModelRestartServices(false, false)).toEqual([]);
  });

  test("returns guardian only", () => {
    expect(buildModelRestartServices(true, false)).toEqual(["guardian"]);
  });

  test("returns openmemory only", () => {
    expect(buildModelRestartServices(false, true)).toEqual(["openmemory"]);
  });

  test("returns both", () => {
    expect(buildModelRestartServices(true, true)).toEqual(["guardian", "openmemory"]);
  });
});
