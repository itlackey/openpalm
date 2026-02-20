import { describe, expect, it } from "bun:test";
import { parseJsonc } from "./jsonc.ts";

describe("parseJsonc (C5 regression)", () => {
  it("parses plain JSON without comments", () => {
    const result = parseJsonc('{ "key": "value" }');
    expect(result).toEqual({ key: "value" });
  });

  it("strips inline // comments correctly", () => {
    const input = '{ "key": "value" // inline comment\n}';
    const result = parseJsonc(input) as Record<string, unknown>;
    expect(result.key).toBe("value");
  });

  it("strips block /* */ comments", () => {
    const input = '{ /* block comment */ "key": "value" }';
    const result = parseJsonc(input) as Record<string, unknown>;
    expect(result.key).toBe("value");
  });

  it("handles trailing commas before closing brace", () => {
    const input = '{ "key": "value", }';
    const result = parseJsonc(input) as Record<string, unknown>;
    expect(result.key).toBe("value");
  });

  it("handles trailing commas before closing bracket", () => {
    const input = '{ "items": ["a", "b",] }';
    const result = parseJsonc(input) as Record<string, unknown>;
    expect(result.items).toEqual(["a", "b"]);
  });

  it("preserves URLs with // inside string values (no corruption)", () => {
    const input = '{ "url": "http://example.com" }';
    const result = parseJsonc(input) as Record<string, unknown>;
    expect(result.url).toBe("http://example.com");
  });

  it("preserves URLs with // in nested contexts", () => {
    const input = '{ "endpoint": "https://api.example.com/v1/models", "note": "test" // comment\n}';
    const result = parseJsonc(input) as Record<string, unknown>;
    expect(result.endpoint).toBe("https://api.example.com/v1/models");
    expect(result.note).toBe("test");
  });

  it("handles // inside strings followed by real // comments", () => {
    const input = '{ "proto": "http://host" // this is the host\n}';
    const result = parseJsonc(input) as Record<string, unknown>;
    expect(result.proto).toBe("http://host");
  });

  it("handles multiple trailing commas and comments together", () => {
    const input = `{
      "a": 1, // first
      "b": 2, // second
    }`;
    const result = parseJsonc(input) as Record<string, unknown>;
    expect(result.a).toBe(1);
    expect(result.b).toBe(2);
  });
});
