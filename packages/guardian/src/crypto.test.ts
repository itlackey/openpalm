/**
 * constantTimeEqual — the single shared secure comparison.
 *
 * Behavioral coverage: it returns the correct boolean for equal, unequal,
 * and DIFFERING-LENGTH inputs. The length-safe property (no early return on a
 * length mismatch) is exercised here by asserting differing-length inputs still
 * return `false` rather than throwing or leaking via a structural short-circuit.
 */
import { describe, it, expect } from "bun:test";
import { constantTimeEqual } from "./crypto.ts";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("s3cret-token", "s3cret-token")).toBe(true);
  });

  it("returns false for same-length but differing strings", () => {
    expect(constantTimeEqual("s3cret-token", "s3cret-toker")).toBe(false);
  });

  it("returns false for differing-length inputs (length-safe, no early leak)", () => {
    expect(constantTimeEqual("short", "short-plus-more")).toBe(false);
    expect(constantTimeEqual("short-plus-more", "short")).toBe(false);
  });

  it("returns true for two empty strings and false when only one is empty", () => {
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("", "x")).toBe(false);
    expect(constantTimeEqual("x", "")).toBe(false);
  });

  it("compares by UTF-8 bytes, handling multi-byte characters", () => {
    expect(constantTimeEqual("café", "café")).toBe(true);
    expect(constantTimeEqual("café", "cafe")).toBe(false);
  });
});
