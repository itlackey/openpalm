import { describe, expect, it } from "bun:test";
import { errMessage } from "./errors.ts";

describe("errMessage", () => {
  it("returns the message of an Error instance", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });

  it("returns the message for an Error subclass", () => {
    class CustomError extends Error {}
    expect(errMessage(new CustomError("nope"))).toBe("nope");
  });

  it("stringifies non-Error values", () => {
    expect(errMessage("plain string")).toBe("plain string");
    expect(errMessage(42)).toBe("42");
    expect(errMessage({ toString: () => "obj" })).toBe("obj");
  });

  it("handles null and undefined", () => {
    expect(errMessage(null)).toBe("null");
    expect(errMessage(undefined)).toBe("undefined");
  });
});
