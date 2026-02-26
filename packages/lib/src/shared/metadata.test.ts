import { describe, expect, it } from "bun:test";
import { sanitizeMetadataObject } from "./metadata.ts";

describe("sanitizeMetadataObject", () => {
  it("returns undefined for non-object inputs", () => {
    expect(sanitizeMetadataObject(undefined)).toBeUndefined();
    expect(sanitizeMetadataObject("x")).toBeUndefined();
    expect(sanitizeMetadataObject([1, 2, 3])).toBeUndefined();
  });

  it("truncates long strings and deep values", () => {
    const result = sanitizeMetadataObject({
      text: "x".repeat(2100),
      nested: { a: { b: { c: { d: 1 } } } },
    });
    expect(result?.text).toHaveLength(2000);
    expect(result?.nested).toEqual({ a: { b: "[truncated]" } });
  });
});
