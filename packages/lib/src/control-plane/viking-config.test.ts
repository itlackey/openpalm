import { describe, test, expect } from "bun:test";
import {
  assembleVikingConfig,
  validateVikingConfigOpts,
} from "./viking-config.js";
import type { VikingConfigOpts } from "./viking-config.js";

// ── Helpers ────────────────────────────────────────────────────────────

function validOpts(overrides?: Partial<VikingConfigOpts>): VikingConfigOpts {
  return {
    vikingApiKey: "test-api-key-123",
    embeddingProvider: "openai",
    embeddingModel: "nomic-embed-text:latest",
    embeddingApiKey: "",
    embeddingBaseUrl: "http://host.docker.internal:11434/v1",
    embeddingDims: 768,
    ...overrides,
  };
}

// ── validateVikingConfigOpts ───────────────────────────────────────────

describe("validateVikingConfigOpts", () => {
  test("all valid fields returns empty array", () => {
    const errors = validateVikingConfigOpts(validOpts());
    expect(errors).toEqual([]);
  });

  test("missing vikingApiKey returns error", () => {
    const errors = validateVikingConfigOpts(validOpts({ vikingApiKey: "" }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("vikingApiKey"))).toBe(true);
  });

  test("missing embeddingProvider returns error", () => {
    const errors = validateVikingConfigOpts(validOpts({ embeddingProvider: "" }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("embeddingProvider"))).toBe(true);
  });

  test("missing embeddingModel returns error", () => {
    const errors = validateVikingConfigOpts(validOpts({ embeddingModel: "" }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("embeddingModel"))).toBe(true);
  });

  test("missing embeddingBaseUrl returns error", () => {
    const errors = validateVikingConfigOpts(validOpts({ embeddingBaseUrl: "" }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("embeddingBaseUrl"))).toBe(true);
  });

  test("embeddingDims of 0 returns error", () => {
    const errors = validateVikingConfigOpts(validOpts({ embeddingDims: 0 }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("embeddingDims"))).toBe(true);
  });

  test("embeddingDims of -1 returns error", () => {
    const errors = validateVikingConfigOpts(validOpts({ embeddingDims: -1 }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("embeddingDims"))).toBe(true);
  });
});

// ── assembleVikingConfig ───────────────────────────────────────────────

describe("assembleVikingConfig", () => {
  test("produces valid parseable JSON", () => {
    const result = assembleVikingConfig(validOpts());
    expect(() => JSON.parse(result)).not.toThrow();
  });

  test("output contains correct server block", () => {
    const opts = validOpts({ vikingApiKey: "my-secret-key" });
    const config = JSON.parse(assembleVikingConfig(opts));
    expect(config.server.root_api_key).toBe("my-secret-key");
    expect(config.server.host).toBe("0.0.0.0");
    expect(config.server.port).toBe(1933);
  });

  test("includes storage.vectordb.dimension matching input", () => {
    const opts = validOpts({ embeddingDims: 1536 });
    const config = JSON.parse(assembleVikingConfig(opts));
    expect(config.storage.vectordb.dimension).toBe(1536);
  });

  test("omits vlm block when vlmProvider is absent", () => {
    const opts = validOpts();
    const config = JSON.parse(assembleVikingConfig(opts));
    expect(config.vlm).toBeUndefined();
  });

  test("omits vlm block when only vlmProvider set but vlmModel missing", () => {
    const opts = validOpts({ vlmProvider: "openai" });
    const config = JSON.parse(assembleVikingConfig(opts));
    expect(config.vlm).toBeUndefined();
  });

  test("includes vlm block when both vlmProvider and vlmModel set", () => {
    const opts = validOpts({
      vlmProvider: "openai",
      vlmModel: "gpt-4o",
      vlmApiKey: "vlm-key",
      vlmBaseUrl: "https://api.openai.com/v1",
    });
    const config = JSON.parse(assembleVikingConfig(opts));
    expect(config.vlm).toBeDefined();
    expect(config.vlm.provider).toBe("openai");
    expect(config.vlm.model).toBe("gpt-4o");
    expect(config.vlm.api_key).toBe("vlm-key");
    expect(config.vlm.api_base).toBe("https://api.openai.com/v1");
  });

  test("omits empty api_key from embedding config", () => {
    const opts = validOpts({ embeddingApiKey: "" });
    const config = JSON.parse(assembleVikingConfig(opts));
    expect(config.embedding.dense).not.toHaveProperty("api_key");
  });

  test("includes api_key in embedding config when non-empty", () => {
    const opts = validOpts({ embeddingApiKey: "sk-embed-key" });
    const config = JSON.parse(assembleVikingConfig(opts));
    expect(config.embedding.dense.api_key).toBe("sk-embed-key");
  });

  test("output ends with a newline", () => {
    const result = assembleVikingConfig(validOpts());
    expect(result.endsWith("\n")).toBe(true);
  });
});
