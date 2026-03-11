/**
 * Tests for model-runner.ts — Local provider detection.
 *
 * Uses mocked fetch to avoid real network calls and timeouts.
 */
import { describe, test, expect, vi, afterEach } from "vitest";
import { detectLocalProviders, type LocalProviderDetection } from "./model-runner.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectLocalProviders", () => {
  test("returns an array with 3 providers when none reachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not reachable"));

    const results = await detectLocalProviders();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(3);
  });

  test("each result has required fields", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not reachable"));

    const results = await detectLocalProviders();
    for (const result of results) {
      expect(result).toHaveProperty("provider");
      expect(result).toHaveProperty("url");
      expect(result).toHaveProperty("available");
      expect(typeof result.provider).toBe("string");
      expect(typeof result.url).toBe("string");
      expect(typeof result.available).toBe("boolean");
    }
  });

  test("includes all expected providers", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not reachable"));

    const results = await detectLocalProviders();
    const providers = results.map((r) => r.provider);
    expect(providers).toContain("model-runner");
    expect(providers).toContain("ollama");
    expect(providers).toContain("lmstudio");
  });

  test("unavailable providers have empty url and available=false", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not reachable"));

    const results = await detectLocalProviders();
    for (const result of results) {
      expect(result.available).toBe(false);
      expect(result.url).toBe("");
    }
  });

  test("marks provider as available when probe succeeds", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes("localhost:11434")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error("not reachable");
    });

    const results = await detectLocalProviders();
    const ollama = results.find((r) => r.provider === "ollama");
    expect(ollama?.available).toBe(true);
    expect(ollama?.url).toBe("http://localhost:11434");
  });
});
