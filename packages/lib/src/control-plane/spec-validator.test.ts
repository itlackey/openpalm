import { describe, test, expect } from "bun:test";
import { validateStackSpecV4 } from "./spec-validator.js";
import type { StackSpec } from "./stack-spec.js";

function makeValidSpec(overrides?: Partial<StackSpec>): StackSpec {
  return {
    version: 4,
    connections: [{ id: "openai", name: "OpenAI", provider: "openai", baseUrl: "" }],
    assignments: {
      llm: { connectionId: "openai", model: "gpt-4o" },
      embeddings: { connectionId: "openai", model: "embed", dims: 1536 },
    },
    ...overrides,
  };
}

describe("validateStackSpecV4", () => {
  test("valid minimal spec has no errors", () => {
    expect(validateStackSpecV4(makeValidSpec())).toEqual([]);
  });

  test("rejects non-object input", () => {
    const errors = validateStackSpecV4("not an object");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].code).toBe("OP-CFG-000");
  });

  test("rejects null input", () => {
    const errors = validateStackSpecV4(null);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("rejects wrong version", () => {
    const errors = validateStackSpecV4({ version: 99 });
    expect(errors.some((e) => e.code === "OP-CFG-020")).toBe(true);
  });

  test("suggests migration for version 3", () => {
    const errors = validateStackSpecV4({ version: 3 });
    expect(errors[0].hint).toContain("migrate");
  });

  test("rejects missing connections", () => {
    const spec = { version: 4, assignments: { llm: { connectionId: "", model: "m" }, embeddings: { connectionId: "", model: "e" } } };
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-001")).toBe(true);
  });

  test("rejects empty connections array", () => {
    const spec = makeValidSpec({ connections: [] });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-001")).toBe(true);
  });

  test("rejects connection with missing id", () => {
    const spec = makeValidSpec({
      connections: [{ id: "", name: "Test", provider: "openai", baseUrl: "" }],
    });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-004")).toBe(true);
  });

  test("rejects connection with invalid id", () => {
    const spec = makeValidSpec({
      connections: [{ id: "UPPER_CASE!", name: "Test", provider: "openai", baseUrl: "" }],
    });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-005")).toBe(true);
  });

  test("rejects duplicate connection ids", () => {
    const spec = makeValidSpec({
      connections: [
        { id: "openai", name: "One", provider: "openai", baseUrl: "" },
        { id: "openai", name: "Two", provider: "openai", baseUrl: "" },
      ],
    });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-006")).toBe(true);
  });

  test("rejects missing assignments", () => {
    const errors = validateStackSpecV4({ version: 4, connections: [{ id: "a", name: "A", provider: "p", baseUrl: "" }] });
    expect(errors.some((e) => e.code === "OP-CFG-002")).toBe(true);
  });

  test("rejects dangling llm connectionId", () => {
    const spec = makeValidSpec();
    spec.assignments.llm.connectionId = "nonexistent";
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-003" && e.path === "assignments.llm.connectionId")).toBe(true);
  });

  test("rejects dangling embeddings connectionId", () => {
    const spec = makeValidSpec();
    spec.assignments.embeddings.connectionId = "nonexistent";
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-003" && e.path === "assignments.embeddings.connectionId")).toBe(true);
  });

  test("rejects missing llm model", () => {
    const spec = makeValidSpec();
    spec.assignments.llm.model = "";
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-008")).toBe(true);
  });

  test("rejects negative embedding dims", () => {
    const spec = makeValidSpec();
    spec.assignments.embeddings.dims = -1;
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-009")).toBe(true);
  });

  test("accepts valid ports", () => {
    const spec = makeValidSpec({ ports: { ingress: 8080, assistant: 4000 } });
    expect(validateStackSpecV4(spec)).toEqual([]);
  });

  test("rejects invalid port values", () => {
    const spec = makeValidSpec({ ports: { ingress: 99999 } });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-010")).toBe(true);
  });

  test("rejects port 0", () => {
    const spec = makeValidSpec({ ports: { ingress: 0 } });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-010")).toBe(true);
  });

  test("rejects invalid image namespace", () => {
    const spec = makeValidSpec({ image: { namespace: "INVALID!" } });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-012")).toBe(true);
  });

  test("accepts valid image namespace", () => {
    const spec = makeValidSpec({ image: { namespace: "my-repo.io" } });
    expect(validateStackSpecV4(spec)).toEqual([]);
  });

  test("validates optional assignment connectionIds", () => {
    const spec = makeValidSpec();
    spec.assignments.reranking = { enabled: true, connectionId: "nonexistent", model: "m" };
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-003" && e.path?.includes("reranking"))).toBe(true);
  });

  // ── Tests added from reviewer feedback ───────────────────────────

  test("rejects non-string network.bindAddress (OP-CFG-011)", () => {
    const spec = { ...makeValidSpec(), network: { bindAddress: 123 } };
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-011")).toBe(true);
  });

  test("rejects connection with missing provider", () => {
    const spec = makeValidSpec({
      connections: [{ id: "test", name: "Test", provider: "", baseUrl: "" }],
    });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-004" && e.path?.includes("provider"))).toBe(true);
  });

  test("rejects connection with missing name", () => {
    const spec = makeValidSpec({
      connections: [{ id: "test", name: "", provider: "openai", baseUrl: "" }],
    });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-004" && e.path?.includes("name"))).toBe(true);
  });

  test("rejects missing embeddings model", () => {
    const spec = makeValidSpec();
    spec.assignments.embeddings.model = "";
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-008" && e.path?.includes("embeddings"))).toBe(true);
  });

  test("rejects float port value", () => {
    const spec = makeValidSpec({ ports: { ingress: 80.5 } });
    const errors = validateStackSpecV4(spec);
    expect(errors.some((e) => e.code === "OP-CFG-010")).toBe(true);
  });
});
