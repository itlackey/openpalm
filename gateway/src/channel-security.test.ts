import { describe, expect, it } from "bun:test";
import { signPayload, verifySignature } from "./channel-security.ts";

describe("channel security", () => {
  it("validates signatures", () => {
    const body = JSON.stringify({ ok: true });
    const sig = signPayload("secret", body);
    expect(verifySignature("secret", body, sig)).toBe(true);
    expect(verifySignature("secret", body, "bad")).toBe(false);
  });

  it("rejects empty body and empty signatures", () => {
    expect(verifySignature("secret", "", "")).toBe(false);

    const signed = signPayload("secret", "{}");
    expect(verifySignature("secret", "{}", "")).toBe(false);
    expect(verifySignature("secret", "{}", signed.slice(0, -2))).toBe(false);
  });

  it("rejects empty shared secrets", () => {
    const body = JSON.stringify({ channel: "chat" });
    expect(() => signPayload("", body)).toThrow("HMAC secret must not be empty");
    expect(verifySignature("", body, "any-sig")).toBe(false);
  });
});
