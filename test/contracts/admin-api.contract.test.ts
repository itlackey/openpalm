import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("admin API documentation parity", () => {
  // NOTE: This is a docs-parity test, not a behavioral contract test.
  // It verifies that key endpoints are documented, not that they work.
  it("documents current admin endpoints in api-reference.md", () => {
    const docs = readFileSync("dev/docs/api-reference.md", "utf8");
    expect(docs.includes("/setup/status")).toBe(true);
    expect(docs.includes("/command")).toBe(true);
    expect(docs.includes("/state")).toBe(true);
    expect(docs.includes("/plugins/install")).toBe(true);
    expect(docs.includes("/secrets")).toBe(true);
    expect(docs.includes("/connections")).toBe(false);
    expect(docs.includes("/automations")).toBe(true);
    expect(docs.includes("/providers")).toBe(false);
    expect(docs.includes("/stack/spec")).toBe(false);
  });
});
