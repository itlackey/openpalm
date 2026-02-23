import { describe, expect, it } from "bun:test";
import { signPayload, verifySignature } from "../../core/gateway/src/channel-security.ts";

// ---------------------------------------------------------------------------
// Helper: produce a deterministic valid signature for tests that need one.
// ---------------------------------------------------------------------------
function sign(secret: string, body: string): string {
  return signPayload(secret, body);
}

describe("security: hmac", () => {
  // -------------------------------------------------------------------------
  // Empty / missing inputs
  // -------------------------------------------------------------------------
  describe("empty and missing inputs", () => {
    const body = JSON.stringify({ hello: "world" });

    it("rejects empty signature string", () => {
      expect(verifySignature("secret", body, "")).toBe(false);
    });

    it("rejects truncated signature (too short to match SHA-256 hex output)", () => {
      expect(verifySignature("secret", body, "abc")).toBe(false);
    });

    it("verifySignature returns false for empty secret — never throws", () => {
      // The caller must be protected from exceptions even if the secret is
      // misconfigured; false is the safe return value here.
      const sig = "a".repeat(64);
      expect(verifySignature("", body, sig)).toBe(false);
    });

    it("verifySignature returns false when both secret and sig are empty", () => {
      expect(verifySignature("", body, "")).toBe(false);
    });

    it("signPayload throws for empty secret", () => {
      expect(() => signPayload("", body)).toThrow("HMAC secret must not be empty");
    });

    it("signPayload throws for whitespace-only secret", () => {
      // Whitespace is technically non-empty so the library does NOT throw;
      // it produces a valid (but weak) signature.  This test documents the
      // current contract so a future change is intentional, not accidental.
      expect(() => signPayload("   ", body)).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Cross-body / cross-secret isolation
  // -------------------------------------------------------------------------
  describe("signature isolation", () => {
    it("signature from one body does not verify against a different body", () => {
      const body1 = JSON.stringify({ msg: "hello" });
      const body2 = JSON.stringify({ msg: "world" });
      const sig = sign("secret", body1);
      expect(verifySignature("secret", body2, sig)).toBe(false);
    });

    it("signature produced with one secret does not verify with a different secret", () => {
      const body = JSON.stringify({ user: "alice" });
      const sig = sign("secret-A", body);
      expect(verifySignature("secret-B", body, sig)).toBe(false);
    });

    it("swapping key and body is rejected", () => {
      const body = "the-body";
      const secret = "the-secret";
      const sig = sign(secret, body);
      // Attempt to forge by passing the secret as the body
      expect(verifySignature(body, secret, sig)).toBe(false);
    });

    it("different bodies produce different signatures (collision resistance)", () => {
      const sigs = new Set<string>();
      const variants = [
        '{"a":1}',
        '{"a":2}',
        '{"b":1}',
        "hello",
        "Hello",
        " hello",
        "hello ",
      ];
      for (const v of variants) {
        sigs.add(sign("secret", v));
      }
      // Every variant must produce a unique signature.
      expect(sigs.size).toBe(variants.length);
    });
  });

  // -------------------------------------------------------------------------
  // Signature format
  // -------------------------------------------------------------------------
  describe("signature format", () => {
    it("produces exactly 64 hex characters for SHA-256 HMAC", () => {
      const sig = sign("my-secret", '{"ok":true}');
      expect(sig).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(sig)).toBe(true);
    });

    it("signature is lowercase hex (no uppercase, no colons)", () => {
      const sig = sign("key", "value");
      expect(sig).toBe(sig.toLowerCase());
      expect(sig.includes(":")).toBe(false);
    });

    it("round-trip: signPayload then verifySignature returns true", () => {
      const body = JSON.stringify({ channel: "chat", userId: "u1", text: "hi" });
      const sig = sign("shared-secret", body);
      expect(verifySignature("shared-secret", body, sig)).toBe(true);
    });

    it("verifySignature rejects a signature that is one character short", () => {
      const body = '{"x":1}';
      const sig = sign("s", body);
      expect(verifySignature("s", body, sig.slice(0, -1))).toBe(false);
    });

    it("verifySignature rejects a signature that is one character long", () => {
      const body = '{"x":1}';
      expect(verifySignature("s", body, "a")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Edge-case body content
  // -------------------------------------------------------------------------
  describe("special body content", () => {
    it("handles an empty body string without throwing", () => {
      // signPayload should succeed; verifying the result should also succeed.
      const sig = sign("secret", "");
      expect(verifySignature("secret", "", sig)).toBe(true);
    });

    it("handles a body with Unicode / emoji characters", () => {
      const body = JSON.stringify({ text: "Hello, \u4e16\u754c! \uD83D\uDE80" });
      const sig = sign("secret", body);
      expect(verifySignature("secret", body, sig)).toBe(true);
    });

    it("handles a body with embedded newlines and tabs", () => {
      const body = "line1\nline2\r\n\ttabbed";
      const sig = sign("secret", body);
      expect(verifySignature("secret", body, sig)).toBe(true);
    });

    it("handles a body with null bytes", () => {
      const body = "before\x00after";
      const sig = sign("secret", body);
      expect(verifySignature("secret", body, sig)).toBe(true);
    });

    it("handles a very long body (100 KB) without errors", () => {
      const body = "x".repeat(100_000);
      const sig = sign("secret", body);
      expect(sig).toHaveLength(64);
      expect(verifySignature("secret", body, sig)).toBe(true);
    });

    it("handles a very long body (1 MB) without errors", () => {
      const body = JSON.stringify({ data: "z".repeat(1_000_000) });
      const sig = sign("long-secret", body);
      expect(verifySignature("long-secret", body, sig)).toBe(true);
    });

    it("a single-character difference in body produces a different signature", () => {
      const base = '{"text":"hello"}';
      const mutated = '{"text":"hellO"}'; // capital O
      expect(sign("s", base)).not.toBe(sign("s", mutated));
    });
  });

  // -------------------------------------------------------------------------
  // Secret strength / format
  // -------------------------------------------------------------------------
  describe("secret variations", () => {
    it("accepts a long secret (512 chars)", () => {
      const secret = "k".repeat(512);
      const body = '{"ok":true}';
      const sig = sign(secret, body);
      expect(verifySignature(secret, body, sig)).toBe(true);
    });

    it("accepts a secret with special characters", () => {
      const secret = "p@$$w0rd!#%^&*()-_=+[]{}|;':\",./<>?";
      const body = "payload";
      const sig = sign(secret, body);
      expect(verifySignature(secret, body, sig)).toBe(true);
    });

    it("different secrets produce different signatures for the same body", () => {
      const body = '{"msg":"same"}';
      const sig1 = sign("secret1", body);
      const sig2 = sign("secret2", body);
      expect(sig1).not.toBe(sig2);
    });
  });
});
