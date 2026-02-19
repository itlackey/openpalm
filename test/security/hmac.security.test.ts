import { describe, expect, it } from "bun:test";
import { verifySignature } from "../../gateway/src/channel-security.ts";

describe("security: hmac", () => {
  it("rejects empty and truncated signatures", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifySignature("secret", body, "")).toBe(false);
    expect(verifySignature("secret", body, "abc")).toBe(false);
  });
});
