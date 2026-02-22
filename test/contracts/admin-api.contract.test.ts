import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("admin API documentation parity", () => {
  // NOTE: This is a docs-parity test, not a behavioral contract test.
  // It verifies that key endpoints are documented, not that they work.
  it("documents current admin endpoints in api-reference.md", () => {
    const docs = readFileSync("dev/docs/api-reference.md", "utf8");
    expect(docs.includes("/admin/setup/status")).toBe(true);
    expect(docs.includes("/admin/command")).toBe(true);
    expect(docs.includes("/admin/state")).toBe(true);
    expect(docs.includes("/admin/plugins/install")).toBe(true);
    expect(docs.includes("/admin/secrets")).toBe(true);
    expect(docs.includes("/admin/connections")).toBe(false);
    expect(docs.includes("/admin/automations")).toBe(true);
    expect(docs.includes("/admin/providers")).toBe(false);
    expect(docs.includes("/admin/stack/spec")).toBe(false);
  });
});
