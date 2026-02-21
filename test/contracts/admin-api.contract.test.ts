import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("contract: admin API docs", () => {
  it("documents key admin endpoints used by ui", () => {
    const docs = readFileSync("docs/development/api-reference.md", "utf8");
    expect(docs.includes("/admin/setup/status")).toBe(true);
    expect(docs.includes("/admin/plugins/install")).toBe(true);
    expect(docs.includes("/admin/containers/restart")).toBe(true);
    expect(docs.includes("/admin/secrets")).toBe(true);
    expect(docs.includes("/admin/connections")).toBe(true);
    expect(docs.includes("/admin/automations")).toBe(true);
    expect(docs.includes("/admin/providers")).toBe(true);
    expect(docs.includes("/admin/stack/spec")).toBe(true);
  });

  it("does not reference removed gallery endpoints", () => {
    const docs = readFileSync("docs/development/api-reference.md", "utf8");
    expect(docs.includes("/admin/gallery/")).toBe(false);
  });
});
