import { describe, expect, it } from "bun:test";
import { parseEnvContent, mergeEnvContent, removeEnvKey, UnrepresentableEnvValueError } from "./env.js";

// ── Special character round-trips ────────────────────────────────────────
// Values written by mergeEnvContent must survive a parseEnvContent round-trip.
// mergeEnvContent writes files DOCKER COMPOSE reads, so since #628 it uses the
// compose-safe grammar: bare or single-quoted, and a refusal for the rest.
// env-grammar-parity.test.ts asserts these same values against a real
// `docker compose config`, which is the reader that actually matters.

describe("special characters in env values", () => {
  /** Write a value via mergeEnvContent, parse it back, assert identity. */
  function roundTrip(key: string, value: string): string {
    const written = mergeEnvContent("", { [key]: value });
    const parsed = parseEnvContent(written);
    expect(parsed[key]).toBe(value);
    return written;
  }

  it("round-trips values containing = (common in base64 API keys)", () => {
    roundTrip("TOKEN", "abc=def=ghi");
    roundTrip("TOKEN", "dGVzdA==");
    roundTrip("TOKEN", "key=value=extra=");
  });

  it("round-trips values containing $ (must not expand)", () => {
    roundTrip("TOKEN", "price$100");
    roundTrip("TOKEN", "$HOME/path");
    roundTrip("TOKEN", "a]$b$c");
  });

  it("round-trips values containing double quotes", () => {
    roundTrip("TOKEN", 'say "hello"');
    roundTrip("TOKEN", '"quoted"');
  });

  // #628: a compose-read file cannot hold these, so the write is refused
  // naming the key rather than producing a file Compose rejects whole — or,
  // worse, one this app and Compose read differently. Multi-line material
  // (PEMs, keys) belongs in a file secret, and free text in user.env, which
  // keeps the richer dotenv grammar because Compose never reads it.
  it("refuses values containing single quotes, naming the key", () => {
    expect(() => mergeEnvContent("", { TOKEN: "it's a token" })).toThrow(UnrepresentableEnvValueError);
    expect(() => mergeEnvContent("", { TOKEN: "it's a token" })).toThrow(/TOKEN/);
  });

  it("refuses values containing newlines, naming the key", () => {
    expect(() => mergeEnvContent("", { CERT: "line1\nline2" })).toThrow(UnrepresentableEnvValueError);
    expect(() => mergeEnvContent("", { CERT: "line1\nline2" })).toThrow(/CERT/);
  });

  it("refuses a value ending in a backslash, which compose rejects file-wide", () => {
    expect(() => mergeEnvContent("", { OP_HOME: "C:\\Users\\op\\" })).toThrow(
      UnrepresentableEnvValueError,
    );
  });

  it("round-trips values with + and / (base64 characters)", () => {
    roundTrip("KEY", "abc+def/ghi=");
    roundTrip("KEY", "sk-proj-A1b2C3+xyz/ZZZ==");
  });

  it("round-trips realistic API key with special chars", () => {
    roundTrip("OPENAI_API_KEY", "sk-proj-abc123+def/456==");
    roundTrip("ANTHROPIC_API_KEY", "sk-ant-api03-Abc$Def=Ghi");
  });
});

// ── quoteEnvValue quoting strategy ───────────────────────────────────────

describe("quoteEnvValue quoting strategy (via mergeEnvContent)", () => {
  it("does not quote simple values", () => {
    const result = mergeEnvContent("", { KEY: "simple123" });
    expect(result).toContain("KEY=simple123");
    expect(result).not.toMatch(/KEY=["']/);
  });

  it("single-quotes values with # (no single quote in value)", () => {
    const result = mergeEnvContent("", { KEY: "val#ue" });
    expect(result).toContain("KEY='val#ue'");
  });

  it("double-quotes values with $ when no single quote present", () => {
    const result = mergeEnvContent("", { KEY: "val$ue" });
    // Should use single quotes (preferred) since no single quote in value
    const parsed = parseEnvContent(result);
    expect(parsed.KEY).toBe("val$ue");
  });

  it("does not quote values that only contain =", () => {
    // = is safe unquoted in dotenv values
    const result = mergeEnvContent("", { KEY: "abc=def" });
    expect(result).toContain("KEY=abc=def");
    expect(result).not.toMatch(/KEY=["']/);
  });
});

// ── Update-in-place with special characters ──────────────────────────────

describe("mergeEnvContent updates existing keys with special char values", () => {
  it("updates an existing key to a value with =", () => {
    const input = "export TEST_VALUE=old_value\n";
    const result = mergeEnvContent(input, { TEST_VALUE: "new=value=here" });
    const parsed = parseEnvContent(result);
    expect(parsed.TEST_VALUE).toBe("new=value=here");
  });

  it("updates an existing key to a value with $", () => {
    const input = "export TEST_VALUE=old_value\n";
    const result = mergeEnvContent(input, { TEST_VALUE: "tok$en" });
    const parsed = parseEnvContent(result);
    expect(parsed.TEST_VALUE).toBe("tok$en");
  });

  it("preserves export prefix when updating with special chars", () => {
    const input = "export TEST_VALUE=old_value\n";
    const result = mergeEnvContent(input, { TEST_VALUE: "new#value" });
    expect(result).toMatch(/^export TEST_VALUE=/m);
    const parsed = parseEnvContent(result);
    expect(parsed.TEST_VALUE).toBe("new#value");
  });
});

describe("removeEnvKey", () => {
  it("removes a simple key", () => {
    const out = removeEnvKey("FOO=1\nBAR=2\n", "FOO");
    expect(parseEnvContent(out)).toEqual({ BAR: "2" });
  });

  it("returns content unchanged when key is absent", () => {
    const input = "FOO=1\nBAR=2\n";
    expect(removeEnvKey(input, "MISSING")).toBe(input);
  });

  it("handles the export prefix form", () => {
    const out = removeEnvKey("export FOO=1\nBAR=2\n", "FOO");
    expect(parseEnvContent(out)).toEqual({ BAR: "2" });
  });

  it("leaves comments above the deleted key intact", () => {
    const out = removeEnvKey("# header comment\nFOO=1\nBAR=2\n", "FOO");
    expect(out).toContain("# header comment");
    expect(parseEnvContent(out).FOO).toBeUndefined();
    expect(parseEnvContent(out).BAR).toBe("2");
  });
});
