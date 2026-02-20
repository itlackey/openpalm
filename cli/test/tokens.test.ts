import { describe, expect, it } from "bun:test";
import { generateToken } from "../src/lib/tokens.ts";

describe("tokens", () => {
  describe("generateToken", () => {
    it("default length is 64 characters", () => {
      const token = generateToken();
      expect(token.length).toBe(64);
    });

    it("custom length produces correct size", () => {
      const token32 = generateToken(32);
      expect(token32.length).toBe(32);

      const token128 = generateToken(128);
      expect(token128.length).toBe(128);
    });

    it("token is URL-safe (no +, /, or =)", () => {
      const token = generateToken(128);
      expect(token).not.toContain("+");
      expect(token).not.toContain("/");
      expect(token).not.toContain("=");
    });

    it("two tokens are unique (not equal)", () => {
      const token1 = generateToken();
      const token2 = generateToken();
      expect(token1).not.toBe(token2);
    });
  });
});
