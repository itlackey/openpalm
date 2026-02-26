import { describe, expect, it } from "bun:test";
import { sanitizeEnvScalar, updateRuntimeEnvContent } from "./runtime-env.ts";
import { parseEnvContent } from "../shared/env-parser.ts";

describe("runtime env content helpers", () => {
  it("parses key-value env lines while ignoring comments and blanks", () => {
    const parsed = parseEnvContent(["# note", "OPENMEMORY_URL=http://openmemory:3000", "", "A=B=C"].join("\n"));
    expect(parsed).toEqual({
      OPENMEMORY_URL: "http://openmemory:3000",
      A: "B=C"
    });
  });

  it("updates managed keys, removes empty managed values, and preserves unmanaged lines", () => {
    const current = [
      "# comment",
      "OPENMEMORY_URL=http://old",
      "OPENMEMORY_POSTGRES_URL=postgresql://old",
      "OTHER=keep"
    ].join("\n");

    const next = updateRuntimeEnvContent(current, {
      OPENMEMORY_URL: "http://new",
      OPENMEMORY_POSTGRES_URL: undefined,
      OPENMEMORY_QDRANT_URL: "http://qdrant"
    });

    expect(next).toContain("# comment");
    expect(next).toContain("OPENMEMORY_URL=http://new");
    expect(next).not.toContain("OPENMEMORY_POSTGRES_URL=");
    expect(next).toContain("OPENMEMORY_QDRANT_URL=http://qdrant");
    expect(next).toContain("OTHER=keep");
    expect(next.endsWith("\n")).toBe(true);
  });

  it("preserves existing keys when they are not in the managed update set", () => {
    const current = [
      "OPENAI_BASE_URL=https://old.example/v1",
      "OPENAI_API_KEY=sk-existing"
    ].join("\n");

    const next = updateRuntimeEnvContent(current, {
      OPENAI_BASE_URL: "https://new.example/v1"
    });

    expect(next).toContain("OPENAI_BASE_URL=https://new.example/v1");
    expect(next).toContain("OPENAI_API_KEY=sk-existing");
  });

  it("removes newline/control injection from scalar values", () => {
    expect(sanitizeEnvScalar("  one\nTWO\r\nthree  ")).toBe("oneTWOthree");
    expect(sanitizeEnvScalar(42)).toBe("");
  });
});
