/**
 * Tests for model-runner.ts — Docker Model Runner integration.
 *
 * Verifies:
 * 1. isValidModelName rejects invalid/malicious inputs
 * 2. generateModelOverlayYaml produces correct compose YAML
 * 3. parseLocalModelsCompose round-trips with generateModelOverlayYaml
 * 4. Embedding dimensions persist through YAML round-trip
 * 5. readLocalModelsCompose/writeLocalModelsCompose filesystem operations
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidModelName,
  generateModelOverlayYaml,
  parseLocalModelsCompose,
  readLocalModelsCompose,
  writeLocalModelsCompose,
  type LocalModelSelection,
} from "./model-runner.js";

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

// ── generateModelOverlayYaml ─────────────────────────────────────────────

describe("generateModelOverlayYaml", () => {
  test("generates YAML with system model only", () => {
    const yaml = generateModelOverlayYaml({
      systemModel: { model: "ai/llama3.2:3B-Q4_K_M", contextSize: 4096 },
    });
    expect(yaml).toContain("local-llm:");
    expect(yaml).toContain("model: ai/llama3.2:3B-Q4_K_M");
    expect(yaml).toContain("context_size: 4096");
    expect(yaml).not.toContain("local-embedding:");
  });

  test("generates YAML with embedding model only", () => {
    const yaml = generateModelOverlayYaml({
      embeddingModel: { model: "ai/all-minilm", dimensions: 384 },
    });
    expect(yaml).toContain("local-embedding:");
    expect(yaml).toContain("model: ai/all-minilm");
    expect(yaml).toContain("# dimensions: 384");
    expect(yaml).not.toContain("local-llm:");
  });

  test("generates YAML with both models", () => {
    const yaml = generateModelOverlayYaml({
      systemModel: { model: "ai/mistral", contextSize: 4096 },
      embeddingModel: { model: "ai/nomic-embed-text", dimensions: 768 },
    });
    expect(yaml).toContain("local-llm:");
    expect(yaml).toContain("local-embedding:");
    expect(yaml).toContain("model: ai/mistral");
    expect(yaml).toContain("model: ai/nomic-embed-text");
    expect(yaml).toContain("# dimensions: 768");
  });

  test("returns empty string when no models", () => {
    expect(generateModelOverlayYaml({})).toBe("");
  });

  test("omits context_size when not specified", () => {
    const yaml = generateModelOverlayYaml({
      systemModel: { model: "ai/smollm2" },
    });
    expect(yaml).toContain("model: ai/smollm2");
    expect(yaml).not.toContain("context_size");
  });

  test("includes services section with extra_hosts", () => {
    const yaml = generateModelOverlayYaml({
      systemModel: { model: "ai/mistral" },
    });
    expect(yaml).toContain("services:");
    expect(yaml).toContain("guardian:");
    expect(yaml).toContain("model-runner.docker.internal:host-gateway");
  });
});

// ── parseLocalModelsCompose ──────────────────────────────────────────────

describe("parseLocalModelsCompose", () => {
  test("parses system model from YAML", () => {
    const yaml = [
      "models:",
      "  local-llm:",
      "    model: ai/llama3.2:3B-Q4_K_M",
      "    context_size: 4096",
    ].join("\n");

    const result = parseLocalModelsCompose(yaml);
    expect(result.systemModel).toEqual({
      model: "ai/llama3.2:3B-Q4_K_M",
      contextSize: 4096,
    });
    expect(result.embeddingModel).toBeUndefined();
  });

  test("parses embedding model with persisted dimensions", () => {
    const yaml = [
      "models:",
      "  local-embedding:",
      "    model: ai/nomic-embed-text",
      "    # dimensions: 768",
    ].join("\n");

    const result = parseLocalModelsCompose(yaml);
    expect(result.embeddingModel).toEqual({
      model: "ai/nomic-embed-text",
      dimensions: 768,
    });
  });

  test("falls back to lookup table when no persisted dimensions", () => {
    const yaml = [
      "models:",
      "  local-embedding:",
      "    model: ai/all-minilm",
    ].join("\n");

    const result = parseLocalModelsCompose(yaml);
    expect(result.embeddingModel?.dimensions).toBe(384);
  });

  test("falls back to 384 for unknown model without persisted dims", () => {
    const yaml = [
      "models:",
      "  local-embedding:",
      "    model: hf.co/custom/embed-model",
    ].join("\n");

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
  test("system model round-trips correctly", () => {
    const original: LocalModelSelection = {
      systemModel: { model: "ai/mistral", contextSize: 4096 },
    };
    const yaml = generateModelOverlayYaml(original);
    const parsed = parseLocalModelsCompose(yaml);
    expect(parsed.systemModel).toEqual(original.systemModel);
  });

  test("embedding model round-trips with custom dimensions", () => {
    const original: LocalModelSelection = {
      embeddingModel: { model: "hf.co/custom/model", dimensions: 1024 },
    };
    const yaml = generateModelOverlayYaml(original);
    const parsed = parseLocalModelsCompose(yaml);
    expect(parsed.embeddingModel).toEqual(original.embeddingModel);
  });

  test("both models round-trip correctly", () => {
    const original: LocalModelSelection = {
      systemModel: { model: "ai/phi4-mini", contextSize: 4096 },
      embeddingModel: { model: "ai/nomic-embed-text", dimensions: 768 },
    };
    const yaml = generateModelOverlayYaml(original);
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
      systemModel: { model: "ai/llama3.2:3B-Q4_K_M", contextSize: 4096 },
      embeddingModel: { model: "ai/all-minilm", dimensions: 384 },
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
    const nestedDir = join(tmpDir, "nested", "config");
    writeLocalModelsCompose(nestedDir, {
      systemModel: { model: "ai/smollm2" },
    });
    expect(readLocalModelsCompose(nestedDir)).not.toBeNull();
  });
});
