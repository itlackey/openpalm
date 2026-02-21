import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("contract: stack-spec schema", () => {
  it("includes host/lan/public exposure and intent-only top-level fields", () => {
    const schema = JSON.parse(readFileSync("assets/config/stack-spec.schema.json", "utf8")) as Record<string, unknown>;
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["accessScope", "automations", "channels", "version"]);
    const exposure = (((schema.$defs as Record<string, unknown>).channelConfig as Record<string, unknown>).properties as Record<string, unknown>).exposure as Record<string, unknown>;
    expect(exposure.enum).toEqual(["host", "lan", "public"]);
  });

  it("documents direct secret reference token format", () => {
    const schemaText = readFileSync("assets/config/stack-spec.schema.json", "utf8");
    expect(schemaText.includes("^\\\\$\\\\{[A-Z][A-Z0-9_]*\\\\}$")).toBe(true);
  });
});
