/**
 * Tests for provider-constants.ts — shared LLM provider constants.
 *
 * Verifies:
 * 1. mem0ProviderName maps local providers to "openai" and passes cloud names through
 * 2. PROVIDER_LABELS has an entry for every provider in LLM_PROVIDERS
 * 3. LOCAL_PROVIDER_HELP has help text for all local providers
 * 4. PROVIDER_DEFAULT_URLS has entries for model-runner and lmstudio
 * 5. PROVIDER_KEY_MAP maps known cloud providers to env var names
 * 6. EMBEDDING_DIMS has well-known embedding dimension entries
 */
import { describe, test, expect } from "vitest";
import {
  LLM_PROVIDERS,
  PROVIDER_DEFAULT_URLS,
  PROVIDER_KEY_MAP,
  PROVIDER_LABELS,
  LOCAL_PROVIDER_HELP,
  EMBEDDING_DIMS,
  mem0ProviderName,
} from "$lib/provider-constants.js";

// ── mem0ProviderName ──────────────────────────────────────────────────────

describe("mem0ProviderName", () => {
  test("maps 'model-runner' to 'openai'", () => {
    expect(mem0ProviderName("model-runner")).toBe("openai");
  });

  test("maps 'lmstudio' to 'openai'", () => {
    expect(mem0ProviderName("lmstudio")).toBe("openai");
  });

  test("passes 'openai' through unchanged", () => {
    expect(mem0ProviderName("openai")).toBe("openai");
  });

  test("passes 'ollama' through unchanged", () => {
    expect(mem0ProviderName("ollama")).toBe("ollama");
  });

  test("passes 'anthropic' through unchanged", () => {
    expect(mem0ProviderName("anthropic")).toBe("anthropic");
  });

  test("passes unknown provider names through unchanged", () => {
    expect(mem0ProviderName("some-future-provider")).toBe("some-future-provider");
  });
});

// ── PROVIDER_LABELS coverage ──────────────────────────────────────────────

describe("PROVIDER_LABELS", () => {
  test("has a label for every provider in LLM_PROVIDERS", () => {
    for (const provider of LLM_PROVIDERS) {
      expect(PROVIDER_LABELS).toHaveProperty(provider);
      expect(typeof PROVIDER_LABELS[provider]).toBe("string");
      expect(PROVIDER_LABELS[provider].length).toBeGreaterThan(0);
    }
  });

  test("label values are human-readable (not raw slugs)", () => {
    // Spot-check a few known labels
    expect(PROVIDER_LABELS["openai"]).toBe("OpenAI");
    expect(PROVIDER_LABELS["anthropic"]).toBe("Anthropic");
    expect(PROVIDER_LABELS["model-runner"]).toBe("Docker Model Runner");
    expect(PROVIDER_LABELS["lmstudio"]).toBe("LM Studio");
  });
});

// ── LOCAL_PROVIDER_HELP coverage ──────────────────────────────────────────

describe("LOCAL_PROVIDER_HELP", () => {
  const LOCAL_PROVIDERS = ["model-runner", "ollama", "lmstudio"] as const;

  test("has help text for all local providers", () => {
    for (const provider of LOCAL_PROVIDERS) {
      expect(LOCAL_PROVIDER_HELP).toHaveProperty(provider);
      expect(typeof LOCAL_PROVIDER_HELP[provider]).toBe("string");
      expect(LOCAL_PROVIDER_HELP[provider].length).toBeGreaterThan(0);
    }
  });

  test("help text contains actionable guidance", () => {
    // Each help string should mention how to add models
    expect(LOCAL_PROVIDER_HELP["model-runner"]).toContain("docker model");
    expect(LOCAL_PROVIDER_HELP["ollama"]).toContain("ollama pull");
    expect(LOCAL_PROVIDER_HELP["lmstudio"]).toContain("LM Studio");
  });
});

// ── PROVIDER_DEFAULT_URLS ─────────────────────────────────────────────────

describe("PROVIDER_DEFAULT_URLS", () => {
  test("has a base URL for model-runner", () => {
    expect(PROVIDER_DEFAULT_URLS["model-runner"]).toBeDefined();
    expect(PROVIDER_DEFAULT_URLS["model-runner"]).toContain("model-runner");
  });

  test("has a base URL for lmstudio", () => {
    expect(PROVIDER_DEFAULT_URLS["lmstudio"]).toBeDefined();
    expect(PROVIDER_DEFAULT_URLS["lmstudio"]).toContain("1234");
  });

  test("has a base URL for ollama", () => {
    expect(PROVIDER_DEFAULT_URLS["ollama"]).toBeDefined();
    expect(PROVIDER_DEFAULT_URLS["ollama"]).toContain("11434");
  });

  test("cloud provider URLs use HTTPS", () => {
    const cloudProviders = ["openai", "groq", "mistral", "together", "deepseek", "xai"];
    for (const provider of cloudProviders) {
      if (PROVIDER_DEFAULT_URLS[provider]) {
        expect(PROVIDER_DEFAULT_URLS[provider]).toMatch(/^https:\/\//);
      }
    }
  });

  test("local provider URLs use HTTP", () => {
    const localProviders = ["model-runner", "ollama", "lmstudio"];
    for (const provider of localProviders) {
      expect(PROVIDER_DEFAULT_URLS[provider]).toMatch(/^http:\/\//);
    }
  });
});

// ── PROVIDER_KEY_MAP ──────────────────────────────────────────────────────

describe("PROVIDER_KEY_MAP", () => {
  test("maps openai to OPENAI_API_KEY", () => {
    expect(PROVIDER_KEY_MAP["openai"]).toBe("OPENAI_API_KEY");
  });

  test("maps anthropic to ANTHROPIC_API_KEY", () => {
    expect(PROVIDER_KEY_MAP["anthropic"]).toBe("ANTHROPIC_API_KEY");
  });

  test("all values follow *_API_KEY naming convention", () => {
    for (const [, envVar] of Object.entries(PROVIDER_KEY_MAP)) {
      expect(envVar).toMatch(/_API_KEY$/);
    }
  });
});

// ── EMBEDDING_DIMS ────────────────────────────────────────────────────────

describe("EMBEDDING_DIMS", () => {
  test("all dimension values are positive integers", () => {
    for (const [model, dims] of Object.entries(EMBEDDING_DIMS)) {
      expect(Number.isInteger(dims)).toBe(true);
      expect(dims).toBeGreaterThan(0);
    }
  });

  test("keys follow provider/model naming convention", () => {
    for (const key of Object.keys(EMBEDDING_DIMS)) {
      expect(key).toMatch(/^[a-z]+\/.+$/);
    }
  });

  test("includes known OpenAI embedding models", () => {
    expect(EMBEDDING_DIMS["openai/text-embedding-3-small"]).toBe(1536);
    expect(EMBEDDING_DIMS["openai/text-embedding-3-large"]).toBe(3072);
  });
});

// ── LLM_PROVIDERS array ──────────────────────────────────────────────────

describe("LLM_PROVIDERS", () => {
  test("is a non-empty readonly array", () => {
    expect(Array.isArray(LLM_PROVIDERS)).toBe(true);
    expect(LLM_PROVIDERS.length).toBeGreaterThan(0);
  });

  test("includes both cloud and local providers", () => {
    // Cloud
    expect(LLM_PROVIDERS).toContain("openai");
    expect(LLM_PROVIDERS).toContain("anthropic");
    // Local
    expect(LLM_PROVIDERS).toContain("model-runner");
    expect(LLM_PROVIDERS).toContain("ollama");
    expect(LLM_PROVIDERS).toContain("lmstudio");
  });

  test("has no duplicate entries", () => {
    const unique = new Set(LLM_PROVIDERS);
    expect(unique.size).toBe(LLM_PROVIDERS.length);
  });
});
