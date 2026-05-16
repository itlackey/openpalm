import { describe, it, expect } from "bun:test";
import { parseCookies, isValidSession, isAllowedOrigin } from "./host-admin-server.ts";

describe("parseCookies", () => {
  it("parses a single cookie", () => {
    expect(parseCookies("op_session=abc123")).toEqual({ op_session: "abc123" });
  });

  it("parses multiple cookies", () => {
    const result = parseCookies("foo=1; bar=2; op_session=tok");
    expect(result.foo).toBe("1");
    expect(result.bar).toBe("2");
    expect(result.op_session).toBe("tok");
  });

  it("returns empty object for null header", () => {
    expect(parseCookies(null)).toEqual({});
  });
});

describe("isValidSession", () => {
  it("accepts matching op_session cookie", () => {
    expect(isValidSession({ op_session: "secret" }, "secret")).toBe(true);
  });

  it("rejects mismatched token", () => {
    expect(isValidSession({ op_session: "wrong" }, "secret")).toBe(false);
  });

  it("rejects missing cookie", () => {
    expect(isValidSession({}, "secret")).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  it("allows null origin (non-browser clients)", () => {
    expect(isAllowedOrigin(null, ["localhost:3880"])).toBe(true);
  });

  it("allows matching host", () => {
    expect(isAllowedOrigin("http://localhost:3880", ["localhost:3880"])).toBe(true);
  });

  it("blocks non-matching host", () => {
    expect(isAllowedOrigin("http://evil.com", ["localhost:3880"])).toBe(false);
  });

  it("blocks malformed origin", () => {
    expect(isAllowedOrigin("not-a-url", ["localhost:3880"])).toBe(false);
  });
});
