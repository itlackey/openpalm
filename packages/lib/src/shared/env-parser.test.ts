import { describe, expect, it } from "bun:test";
import { parseEnvContent, parseEnvLine } from "./env-parser.ts";

describe("env parser", () => {
  it("parses key-value lines and ignores comments/invalid entries", () => {
    const parsed = parseEnvContent("\n# comment\nA=1\nINVALID\nB = two\n");
    expect(parsed).toEqual({ A: "1", B: "two" });
  });

  it("supports quoted value stripping when enabled", () => {
    expect(parseEnvLine("KEY='quoted value'", { stripQuotedValues: true })).toEqual(["KEY", "quoted value"]);
    expect(parseEnvLine("KEY=\"double quoted\"", { stripQuotedValues: true })).toEqual(["KEY", "double quoted"]);
    expect(parseEnvLine("KEY='quoted value'", { stripQuotedValues: false })).toEqual(["KEY", "'quoted value'"]);
  });

  it("keeps equals signs inside values", () => {
    expect(parseEnvLine("URL=https://example.com?a=1&b=2")).toEqual(["URL", "https://example.com?a=1&b=2"]);
  });
});
