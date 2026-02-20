import { describe, expect, it } from "bun:test";
import { validatePluginIdentifier } from "./extensions.ts";

describe("validatePluginIdentifier (H2/H3 regression)", () => {
  it("rejects path traversal with ../", () => {
    expect(validatePluginIdentifier("../etc/passwd")).toBe(false);
  });

  it("rejects path traversal buried in a plugins path", () => {
    expect(validatePluginIdentifier("./plugins/../../../etc/passwd")).toBe(false);
  });

  it("rejects path traversal without leading ./", () => {
    expect(validatePluginIdentifier("plugins/../../../etc/passwd")).toBe(false);
  });

  it("accepts plugins/ prefix for local plugin paths (H3 fix)", () => {
    expect(validatePluginIdentifier("plugins/policy.ts")).toBe(true);
  });

  it("accepts ./plugins/ prefix for local plugin paths", () => {
    expect(validatePluginIdentifier("./plugins/policy.ts")).toBe(true);
  });

  it("accepts scoped npm package names", () => {
    expect(validatePluginIdentifier("@openpalm/valid-pkg")).toBe(true);
  });

  it("accepts unscoped npm package names", () => {
    expect(validatePluginIdentifier("some-plugin")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validatePluginIdentifier("")).toBe(false);
  });

  it("rejects shell injection characters in plugins path", () => {
    expect(validatePluginIdentifier("./plugins/bad;rm -rf /")).toBe(false);
    expect(validatePluginIdentifier("./plugins/bad|cat /etc/passwd")).toBe(false);
    expect(validatePluginIdentifier("./plugins/bad`whoami`")).toBe(false);
    expect(validatePluginIdentifier("./plugins/$HOME")).toBe(false);
  });

  it("rejects arbitrary paths that are not under plugins/", () => {
    expect(validatePluginIdentifier("/etc/passwd")).toBe(false);
    expect(validatePluginIdentifier("./etc/passwd")).toBe(false);
  });
});
