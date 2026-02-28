import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvContent, parseEnvFile, mergeEnvContent } from "./env.ts";

// ── parseEnvContent ─────────────────────────────────────────────────

describe("parseEnvContent", () => {
  it("parses simple KEY=value lines", () => {
    const result = parseEnvContent("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips comments and blank lines", () => {
    const result = parseEnvContent("# comment\n\nFOO=bar\n\n# another\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles double-quoted values", () => {
    const result = parseEnvContent('KEY="hello world"');
    expect(result.KEY).toBe("hello world");
  });

  it("handles single-quoted values", () => {
    const result = parseEnvContent("KEY='hello world'");
    expect(result.KEY).toBe("hello world");
  });

  it("strips inline comments from unquoted values", () => {
    const result = parseEnvContent("KEY=value # this is a comment");
    expect(result.KEY).toBe("value");
  });

  it("preserves # in quoted values", () => {
    const result = parseEnvContent('KEY="value # not a comment"');
    expect(result.KEY).toBe("value # not a comment");
  });

  it("handles = in values", () => {
    const result = parseEnvContent("URL=http://host:8080/path?a=b");
    expect(result.URL).toBe("http://host:8080/path?a=b");
  });

  it("handles empty values", () => {
    const result = parseEnvContent("KEY=");
    expect(result.KEY).toBe("");
  });

  it("handles empty input", () => {
    expect(parseEnvContent("")).toEqual({});
  });
});

// ── parseEnvFile ────────────────────────────────────────────────────

describe("parseEnvFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `openpalm-env-test-${randomBytes(4).toString("hex")}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty object for non-existent file", () => {
    expect(parseEnvFile(join(tmpDir, "missing.env"))).toEqual({});
  });

  it("parses an existing .env file", () => {
    writeFileSync(join(tmpDir, "test.env"), "FOO=bar\nBAZ=qux\n");
    const result = parseEnvFile(join(tmpDir, "test.env"));
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

// ── mergeEnvContent ─────────────────────────────────────────────────

describe("mergeEnvContent", () => {
  it("updates existing keys in-place", () => {
    const input = "FOO=old\nBAR=keep\n";
    const result = mergeEnvContent(input, { FOO: "new" });
    expect(result).toContain("FOO=new");
    expect(result).toContain("BAR=keep");
    expect(result).not.toContain("old");
  });

  it("appends missing keys", () => {
    const input = "FOO=bar\n";
    const result = mergeEnvContent(input, { NEW_KEY: "value" });
    expect(result).toContain("FOO=bar");
    expect(result).toContain("NEW_KEY=value");
  });

  it("preserves comments and blank lines", () => {
    const input = "# header comment\n\nFOO=old\n\n# section\nBAR=keep\n";
    const result = mergeEnvContent(input, { FOO: "new" });
    expect(result).toContain("# header comment");
    expect(result).toContain("# section");
    expect(result).toContain("FOO=new");
    expect(result).toContain("BAR=keep");
  });

  it("uncomments commented-out keys when uncomment=true", () => {
    const input = "# FOO=old\nBAR=keep\n";
    const result = mergeEnvContent(input, { FOO: "new" }, { uncomment: true });
    expect(result).toContain("FOO=new");
    expect(result).not.toContain("# FOO");
  });

  it("does not uncomment when uncomment=false (default)", () => {
    const input = "# FOO=old\nBAR=keep\n";
    const result = mergeEnvContent(input, { FOO: "new" });
    // FOO line stays commented, and new FOO is appended
    expect(result).toContain("# FOO=old");
    expect(result).toContain("FOO=new");
  });

  it("adds section header when appending", () => {
    const input = "FOO=bar\n";
    const result = mergeEnvContent(input, { NEW: "val" }, {
      sectionHeader: "# ── New Section ──"
    });
    expect(result).toContain("# ── New Section ──");
    expect(result).toContain("NEW=val");
  });

  it("handles empty input", () => {
    const result = mergeEnvContent("", { KEY: "value" });
    expect(result).toContain("KEY=value");
  });

  it("handles empty updates", () => {
    const input = "FOO=bar\n";
    const result = mergeEnvContent(input, {});
    expect(result).toBe(input);
  });
});
