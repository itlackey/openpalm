import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("lib public API index", () => {
  it("uses explicit exports instead of export-star", () => {
    const content = readFileSync("packages/lib/src/index.ts", "utf8");
    expect(content.includes("export * from")).toBe(false);
  });
});
