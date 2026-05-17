/**
 * Tests for opencode/provider-models.ts — sanitizeOpenCodeModels.
 *
 * Verifies:
 * 1. Normal OpenCode model shapes are preserved
 * 2. Object-map format (keyed by model ID)
 * 3. Missing `name` defaults to `id`
 * 4. Missing `providerID` defaults to fallback
 * 5. Non-object entries are filtered out
 * 6. Null/undefined/primitive input returns empty array
 */
import { describe, test, expect } from "vitest";
import { sanitizeOpenCodeModels } from "./provider-models.js";

describe("sanitizeOpenCodeModels", () => {
  test("returns well-formed models from a normal object map", () => {
    const models = {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        family: "gpt-4",
        providerID: "openai",
        status: "active",
        capabilities: { vision: true },
      },
      "gpt-3.5-turbo": {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5 Turbo",
        family: "gpt-3.5",
        providerID: "openai",
        status: "active",
      },
    };

    const result = sanitizeOpenCodeModels(models, "fallback");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: "gpt-4o",
      name: "GPT-4o",
      family: "gpt-4",
      providerID: "openai",
      status: "active",
      capabilities: { vision: true },
    });
    expect(result[1]).toEqual({
      id: "gpt-3.5-turbo",
      name: "GPT-3.5 Turbo",
      family: "gpt-3.5",
      providerID: "openai",
      status: "active",
      capabilities: {},
    });
  });

  test("missing name defaults to id", () => {
    const models = {
      "claude-3": { id: "claude-3", family: "claude" },
    };

    const result = sanitizeOpenCodeModels(models, "anthropic");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("claude-3");
  });

  test("missing providerID defaults to fallbackProviderId", () => {
    const models = {
      "my-model": { id: "my-model", name: "My Model" },
    };

    const result = sanitizeOpenCodeModels(models, "custom-provider");
    expect(result).toHaveLength(1);
    expect(result[0].providerID).toBe("custom-provider");
  });

  test("missing family defaults to empty string", () => {
    const models = {
      "model-a": { id: "model-a" },
    };

    const result = sanitizeOpenCodeModels(models, "p");
    expect(result[0].family).toBe("");
  });

  test("missing status defaults to active", () => {
    const models = {
      "model-a": { id: "model-a" },
    };

    const result = sanitizeOpenCodeModels(models, "p");
    expect(result[0].status).toBe("active");
  });

  test("non-object entries are filtered out", () => {
    const models = {
      good: { id: "good-model", name: "Good" },
      bad_string: "not-a-model",
      bad_number: 42,
      bad_null: null,
      bad_bool: true,
      bad_array: [1, 2, 3],
    };

    const result = sanitizeOpenCodeModels(models, "fallback");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("good-model");
  });

  test("entries missing id are filtered out", () => {
    const models = {
      "no-id": { name: "No ID model", family: "test" },
      "has-id": { id: "valid", name: "Valid" },
    };

    const result = sanitizeOpenCodeModels(models, "p");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("valid");
  });

  test("entries with non-string id are filtered out", () => {
    const models = {
      a: { id: 123, name: "Numeric ID" },
      b: { id: "valid", name: "Valid" },
    };

    const result = sanitizeOpenCodeModels(models, "p");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("valid");
  });

  test("returns empty array for null input", () => {
    expect(sanitizeOpenCodeModels(null, "p")).toEqual([]);
  });

  test("returns empty array for undefined input", () => {
    expect(sanitizeOpenCodeModels(undefined, "p")).toEqual([]);
  });

  test("returns empty array for primitive input", () => {
    expect(sanitizeOpenCodeModels("string", "p")).toEqual([]);
    expect(sanitizeOpenCodeModels(42, "p")).toEqual([]);
    expect(sanitizeOpenCodeModels(true, "p")).toEqual([]);
  });

  test("returns empty array for empty object", () => {
    expect(sanitizeOpenCodeModels({}, "p")).toEqual([]);
  });

  test("non-object capabilities default to empty object", () => {
    const models = {
      a: { id: "a", capabilities: "not-object" },
      b: { id: "b", capabilities: null },
      c: { id: "c", capabilities: { streaming: true } },
    };

    const result = sanitizeOpenCodeModels(models, "p");
    expect(result).toHaveLength(3);
    expect(result[0].capabilities).toEqual({});
    expect(result[1].capabilities).toEqual({});
    expect(result[2].capabilities).toEqual({ streaming: true });
  });
});
