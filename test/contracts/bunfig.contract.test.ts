import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("bunfig contract", () => {
  it("defines non-trivial test and install policy", () => {
    const content = readFileSync("bunfig.toml", "utf8");
    expect(content.includes("[test]")).toBe(true);
    expect(content.includes("exclude = [")).toBe(true);
    expect(content.includes("[install]")).toBe(true);
    expect(content.includes("frozen = true")).toBe(true);
  });
});
