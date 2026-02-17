import { describe, expect, it } from "bun:test";
import { signPayload, verifyReplayProtection, verifySignature } from "./channel-security.ts";

describe("channel security", () => {
  it("validates signatures", () => {
    const body = JSON.stringify({ ok: true });
    const sig = signPayload("secret", body);
    expect(verifySignature("secret", body, sig)).toBe(true);
    expect(verifySignature("secret", body, "bad")).toBe(false);
  });

  it("blocks replayed nonce", () => {
    const ts = Date.now();
    expect(verifyReplayProtection("webhook", "n1", ts)).toBe(true);
    expect(verifyReplayProtection("webhook", "n1", ts)).toBe(false);
  });
});
