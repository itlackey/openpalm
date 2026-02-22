import { describe, expect, it } from "bun:test";
import { signPayload, verifySignature } from "./crypto.ts";

describe("signPayload", () => {
  it("produces consistent hex output for the same inputs", () => {
    const result1 = signPayload("my-secret", "hello world");
    const result2 = signPayload("my-secret", "hello world");
    expect(result1).toBe(result2);
    expect(result1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different output for different secrets", () => {
    const body = JSON.stringify({ event: "test" });
    const sig1 = signPayload("secret-a", body);
    const sig2 = signPayload("secret-b", body);
    expect(sig1).not.toBe(sig2);
  });

  it("produces different output for different bodies", () => {
    const secret = "shared-secret";
    const sig1 = signPayload(secret, '{"id":1}');
    const sig2 = signPayload(secret, '{"id":2}');
    expect(sig1).not.toBe(sig2);
  });

  it("throws when the secret is an empty string", () => {
    expect(() => signPayload("", "some body")).toThrow("HMAC secret must not be empty");
  });
});

describe("verifySignature", () => {
  it("returns true for a valid signature produced by signPayload", () => {
    const secret = "correct-secret";
    const body = JSON.stringify({ channel: "chat", message: "hello" });
    const sig = signPayload(secret, body);
    expect(verifySignature(secret, body, sig)).toBe(true);
  });

  it("returns false when the secret does not match the signing secret", () => {
    const body = JSON.stringify({ channel: "discord" });
    const sig = signPayload("real-secret", body);
    expect(verifySignature("wrong-secret", body, sig)).toBe(false);
  });

  it("returns false when the body has been modified after signing", () => {
    const secret = "my-secret";
    const originalBody = JSON.stringify({ action: "ping" });
    const sig = signPayload(secret, originalBody);
    const tamperedBody = JSON.stringify({ action: "pong" });
    expect(verifySignature(secret, tamperedBody, sig)).toBe(false);
  });

  it("returns false when the incoming signature has been tampered with", () => {
    const secret = "my-secret";
    const body = JSON.stringify({ ok: true });
    const sig = signPayload(secret, body);
    const tampered = sig.slice(0, -4) + "0000";
    expect(verifySignature(secret, body, tampered)).toBe(false);
  });

  it("returns false when the secret is an empty string", () => {
    const body = JSON.stringify({ ok: true });
    const sig = signPayload("real-secret", body);
    expect(verifySignature("", body, sig)).toBe(false);
  });

  it("returns false when the incoming signature is an empty string", () => {
    const secret = "my-secret";
    const body = JSON.stringify({ ok: true });
    expect(verifySignature(secret, body, "")).toBe(false);
  });

  it("returns false for a truncated (wrong-length) signature", () => {
    const secret = "my-secret";
    const body = JSON.stringify({ ok: true });
    const sig = signPayload(secret, body);
    // Removing characters from the end produces a different length, so timingSafeEqual
    // is bypassed and the function must short-circuit to false.
    expect(verifySignature(secret, body, sig.slice(0, 32))).toBe(false);
  });
});
