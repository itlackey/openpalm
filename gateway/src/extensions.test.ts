import { describe, expect, it } from "bun:test";
import { classifyPluginRisk, validatePluginIdentifier } from "./extensions.ts";

describe("extensions", () => {
  it("validates plugin identifiers", () => {
    expect(validatePluginIdentifier("@scope/pkg")).toBe(true);
    expect(validatePluginIdentifier("./.opencode/plugins/x.ts")).toBe(true);
    expect(validatePluginIdentifier("bad;rm -rf")).toBe(false);
  });

  it("classifies critical plugins", () => {
    expect(classifyPluginRisk("@scope/shell-exec-plugin")).toBe("critical");
  });
});
