import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("contract: admin API docs", () => {
  it("documents key admin endpoints used by ui", () => {
    const docs = readFileSync("docs/development/api-reference.md", "utf8");
    expect(docs.includes("/admin/setup/status")).toBe(true);
    expect(docs.includes("/admin/gallery/search")).toBe(true);
    expect(docs.includes("/admin/containers/restart")).toBe(true);
  });
});
