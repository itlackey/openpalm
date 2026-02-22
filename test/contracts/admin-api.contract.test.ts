import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("contract: admin API docs", () => {
  it("documents key admin endpoints used by ui", () => {
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

  it("does not reference removed connection endpoints", () => {
    const docs = readFileSync("dev/docs/api-reference.md", "utf8");
    expect(docs.includes("/admin/connections")).toBe(false);
  });
});
