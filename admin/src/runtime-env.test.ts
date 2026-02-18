// @ts-ignore Bun test types are provided at runtime in Bun-based test execution.
import { describe, expect, it } from "bun:test";
import { parseRuntimeEnvContent, sanitizeEnvScalar, setRuntimeBindScopeContent, updateRuntimeEnvContent } from "./runtime-env.ts";

describe("runtime env content helpers", () => {
  it("parses key-value env lines while ignoring comments and blanks", () => {
    const parsed = parseRuntimeEnvContent(["# note", "OPENMEMORY_URL=http://openmemory:3000", "", "A=B=C"].join("\n"));
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

  it("applies host bind scope and appends missing runtime bind keys", () => {
    const current = [
      "OPENPALM_INGRESS_BIND_ADDRESS=0.0.0.0",
      "OTHER=keep"
    ].join("\n");

    const next = setRuntimeBindScopeContent(current, "host");
    expect(next).toContain("OPENPALM_INGRESS_BIND_ADDRESS=127.0.0.1");
    expect(next).toContain("OPENPALM_OPENMEMORY_BIND_ADDRESS=127.0.0.1");
    expect(next).toContain("OPENCODE_CORE_BIND_ADDRESS=127.0.0.1");
    expect(next).toContain("OPENCODE_CORE_SSH_BIND_ADDRESS=127.0.0.1");
    expect(next).toContain("OTHER=keep");
  });

  it("removes newline/control injection from scalar values", () => {
    expect(sanitizeEnvScalar("  one\nTWO\r\nthree  ")).toBe("oneTWOthree");
    expect(sanitizeEnvScalar(42)).toBe("");
  });
});
