import { describe, it, expect } from "bun:test";
import { plugin } from "../src/index.ts";

describe("admin-tools-plugin", () => {
  it("registers the expected tools", async () => {
    const hooks = await plugin(
      {} as Parameters<typeof plugin>[0],
      {} as Parameters<typeof plugin>[1],
    );
    expect(hooks.tool).toBeDefined();
    const names = Object.keys(hooks.tool as NonNullable<typeof hooks.tool>);
    expect(names).toContain("compose.up");
    expect(names).toContain("compose.down");
    expect(names).toContain("compose.ps");
    expect(names).toContain("secrets.list-keys");
    expect(names).toContain("endpoints.list");
    expect(names).toContain("health-check");
  });

  it("each tool has a description and args schema", async () => {
    const hooks = await plugin(
      {} as Parameters<typeof plugin>[0],
      {} as Parameters<typeof plugin>[1],
    );
    for (const [name, def] of Object.entries(hooks.tool as NonNullable<typeof hooks.tool>)) {
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.args).toBeDefined();
      expect(typeof def.execute).toBe("function");
      // Naming hygiene: every tool name is namespaced or kebab-cased.
      expect(name).toMatch(/^[a-z][a-z0-9.-]*$/);
    }
  });
});
