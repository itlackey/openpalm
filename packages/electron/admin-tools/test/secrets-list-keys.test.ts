import { describe, it, expect } from "bun:test";
import { parseEnvKeys } from "../src/tools/secrets-list-keys.ts";

describe("parseEnvKeys", () => {
  it("extracts simple key names", () => {
    expect(parseEnvKeys("FOO=bar\nBAZ=qux")).toEqual(["FOO", "BAZ"]);
  });

  it("skips comments and blank lines", () => {
    const input = "# header\n\nFOO=bar\n  # mid comment\nBAZ=qux\n";
    expect(parseEnvKeys(input)).toEqual(["FOO", "BAZ"]);
  });

  it("skips lines without equals", () => {
    expect(parseEnvKeys("NOEQUALS\nFOO=ok")).toEqual(["FOO"]);
  });

  it("strips export prefix", () => {
    expect(parseEnvKeys("export FOO=bar")).toEqual(["FOO"]);
  });

  it("never returns the value, only the key", () => {
    const keys = parseEnvKeys("SECRET=super-sensitive-value-xyz");
    expect(keys).toEqual(["SECRET"]);
    // Critical contract: no value ever appears in the result.
    expect(JSON.stringify(keys)).not.toContain("super-sensitive-value-xyz");
  });

  it("handles empty input", () => {
    expect(parseEnvKeys("")).toEqual([]);
  });
});
