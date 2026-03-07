import { describe, expect, it } from "bun:test";
import { asRecord, constantTimeEqual, extractChatText } from "./utils.ts";

describe("constantTimeEqual", () => {
  it("returns true for equal strings and false for different strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });
});

describe("asRecord", () => {
  it("returns null for non-record values", () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord([])).toBeNull();
    expect(asRecord("x")).toBeNull();
    expect(asRecord(1)).toBeNull();
  });

  it("returns object records", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("extractChatText", () => {
  it("returns null for non-array input", () => {
    expect(extractChatText(null)).toBeNull();
    expect(extractChatText({})).toBeNull();
  });

  it("returns the last non-empty user string content", () => {
    expect(extractChatText([
      { role: "user", content: "first" },
      { role: "assistant", content: "ignore" },
      { role: "user", content: " second " },
    ])).toBe(" second ");
  });

  it("extracts text blocks and ignores mixed/empty parts", () => {
    const text = extractChatText([
      {
        role: "user",
        content: [
          { type: "image", source: "x" },
          { type: "text", text: "" },
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
          { type: "text", text: "   " },
          1,
          null,
        ],
      },
    ]);
    expect(text).toBe("hello\nworld");
  });

  it("returns null for whitespace-only user content", () => {
    expect(extractChatText([
      { role: "user", content: "   " },
      { role: "assistant", content: "ignored" },
    ])).toBeNull();
  });
});
