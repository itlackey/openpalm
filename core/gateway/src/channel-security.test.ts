import { describe, expect, it } from "bun:test";
import { signPayload, verifySignature } from "./channel-security.ts";

describe("channel security", () => {
  it("re-exports working HMAC sign/verify from @openpalm/lib", () => {
    const body = JSON.stringify({ ok: true });
    const sig = signPayload("secret", body);
    expect(verifySignature("secret", body, sig)).toBe(true);
    expect(verifySignature("secret", body, "bad")).toBe(false);
  });
});
