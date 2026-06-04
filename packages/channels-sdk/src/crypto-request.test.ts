import { describe, test, expect } from "bun:test";
import { signRequest, verifyRequest, type RequestSignatureFields } from "./crypto.ts";

const SECRET = "channel-secret-abc";

function fields(overrides: Partial<RequestSignatureFields> = {}): RequestSignatureFields {
  return {
    method: "POST",
    pathWithQuery: "/session/sess-1/message?foo=1",
    body: JSON.stringify({ text: "hello" }),
    nonce: "nonce-1",
    timestamp: 1_700_000_000_000,
    userId: "discord:alice",
    ...overrides,
  };
}

describe("signRequest / verifyRequest — round trip", () => {
  test("a signed request verifies with the same fields", () => {
    const f = fields();
    const sig = signRequest(SECRET, f);
    expect(typeof sig).toBe("string");
    expect(sig.length).toBe(64); // sha256 hex
    expect(verifyRequest(SECRET, f, sig)).toBe(true);
  });

  test("signature is deterministic for identical fields", () => {
    const f = fields();
    expect(signRequest(SECRET, f)).toBe(signRequest(SECRET, f));
  });

  test("a different secret does not verify", () => {
    const f = fields();
    const sig = signRequest(SECRET, f);
    expect(verifyRequest("other-secret", f, sig)).toBe(false);
  });
});

describe("verifyRequest — fail-closed guards", () => {
  test("empty secret fails closed", () => {
    const f = fields();
    const sig = signRequest(SECRET, f);
    expect(verifyRequest("", f, sig)).toBe(false);
  });

  test("empty signature fails closed", () => {
    const f = fields();
    expect(verifyRequest(SECRET, f, "")).toBe(false);
  });
});

describe("signRequest — userId is inside the signed material (security review F1)", () => {
  test("swapping userId while reusing another field's signature MUST fail", () => {
    // alice signs a legitimate call.
    const alice = fields({ userId: "discord:alice" });
    const aliceSig = signRequest(SECRET, alice);

    // mallory reuses alice's signature but presents her own userId in the headers
    // (verifier reconstructs from the presented userId). Because userId is signed,
    // this must NOT verify.
    const mallory = fields({ userId: "discord:mallory" });
    expect(verifyRequest(SECRET, mallory, aliceSig)).toBe(false);

    // sanity: mallory's own signature does verify for her own fields.
    const mallorySig = signRequest(SECRET, mallory);
    expect(verifyRequest(SECRET, mallory, mallorySig)).toBe(true);

    // and the two signatures differ purely because userId differs.
    expect(aliceSig).not.toBe(mallorySig);
  });
});

describe("signRequest — every signed field is bound", () => {
  test("tampered body fails", () => {
    const f = fields();
    const sig = signRequest(SECRET, f);
    expect(verifyRequest(SECRET, { ...f, body: JSON.stringify({ text: "evil" }) }, sig)).toBe(false);
  });

  test("tampered method fails", () => {
    const f = fields({ method: "POST" });
    const sig = signRequest(SECRET, f);
    expect(verifyRequest(SECRET, { ...f, method: "DELETE" }, sig)).toBe(false);
  });

  test("tampered path+query fails", () => {
    const f = fields();
    const sig = signRequest(SECRET, f);
    expect(verifyRequest(SECRET, { ...f, pathWithQuery: "/session/sess-2/message?foo=1" }, sig)).toBe(false);
  });

  test("changing only the query string fails", () => {
    const f = fields();
    const sig = signRequest(SECRET, f);
    expect(verifyRequest(SECRET, { ...f, pathWithQuery: "/session/sess-1/message?foo=2" }, sig)).toBe(false);
  });

  test("tampered nonce fails", () => {
    const f = fields();
    const sig = signRequest(SECRET, f);
    expect(verifyRequest(SECRET, { ...f, nonce: "nonce-2" }, sig)).toBe(false);
  });

  test("tampered timestamp fails", () => {
    const f = fields();
    const sig = signRequest(SECRET, f);
    expect(verifyRequest(SECRET, { ...f, timestamp: f.timestamp + 1 }, sig)).toBe(false);
  });
});

describe("signRequest — empty-body GET signs over SHA256(\"\")", () => {
  // SHA256 of the empty string, the well-known constant.
  const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  test("the empty-body digest used is SHA256(\"\")", () => {
    const hex = new Bun.CryptoHasher("sha256").update("").digest("hex");
    expect(hex).toBe(EMPTY_SHA256);
  });

  test("a GET /event with empty body round-trips", () => {
    const f = fields({ method: "GET", pathWithQuery: "/event", body: "" });
    const sig = signRequest(SECRET, f);
    expect(verifyRequest(SECRET, f, sig)).toBe(true);
  });

  test("the empty-body signed string embeds SHA256(\"\")", () => {
    const f = fields({ method: "GET", pathWithQuery: "/event", body: "" });
    // Recompute the canonical string independently and HMAC it, to lock the format.
    const signed = ["GET", "/event", EMPTY_SHA256, f.nonce, String(f.timestamp), f.userId].join("\n");
    const expected = new Bun.CryptoHasher("sha256", SECRET).update(signed).digest("hex");
    expect(signRequest(SECRET, f)).toBe(expected);
  });
});
