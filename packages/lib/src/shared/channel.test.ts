import { describe, expect, it } from "bun:test";
import { ERROR_CODES, validatePayload } from "./channel.ts";
import { signPayload, verifySignature } from "./crypto.ts";
import { buildChannelMessage, forwardChannelMessage } from "./channel-sdk.ts";

// ── validatePayload ───────────────────────────────────────────────────────

describe("validatePayload", () => {
  const valid = {
    userId: "u1",
    channel: "chat",
    text: "hello",
    nonce: "abc",
    timestamp: Date.now(),
  };

  it("accepts a valid payload", () => {
    const result = validatePayload(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.userId).toBe("u1");
  });

  it("rejects null", () => {
    const result = validatePayload(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ERROR_CODES.INVALID_PAYLOAD);
  });

  it("rejects missing userId", () => {
    expect(validatePayload({ ...valid, userId: "" }).ok).toBe(false);
  });

  it("rejects whitespace-only userId", () => {
    expect(validatePayload({ ...valid, userId: "   " }).ok).toBe(false);
  });

  it("rejects missing channel", () => {
    expect(validatePayload({ ...valid, channel: "" }).ok).toBe(false);
  });

  it("rejects empty text", () => {
    expect(validatePayload({ ...valid, text: "" }).ok).toBe(false);
  });

  it("rejects text exceeding 10 000 chars", () => {
    expect(validatePayload({ ...valid, text: "x".repeat(10_001) }).ok).toBe(false);
  });

  it("rejects missing nonce", () => {
    expect(validatePayload({ ...valid, nonce: "" }).ok).toBe(false);
  });

  it("rejects non-number timestamp", () => {
    expect(validatePayload({ ...valid, timestamp: "now" }).ok).toBe(false);
  });
});

// ── signPayload / verifySignature ─────────────────────────────────────────

describe("signPayload", () => {
  it("produces a 64-char hex string", () => {
    const sig = signPayload("secret", "body");
    expect(sig).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(sig)).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    expect(signPayload("secret", "body")).toBe(signPayload("secret", "body"));
  });

  it("changes when body changes", () => {
    expect(signPayload("secret", "a")).not.toBe(signPayload("secret", "b"));
  });

  it("changes when secret changes", () => {
    expect(signPayload("s1", "body")).not.toBe(signPayload("s2", "body"));
  });
});

describe("verifySignature", () => {
  it("accepts a correct signature", () => {
    const sig = signPayload("secret", "body");
    expect(verifySignature("secret", "body", sig)).toBe(true);
  });

  it("rejects an incorrect signature", () => {
    expect(verifySignature("secret", "body", "a".repeat(64))).toBe(false);
  });

  it("rejects empty secret", () => {
    expect(verifySignature("", "body", signPayload("secret", "body"))).toBe(false);
  });

  it("rejects empty sig", () => {
    expect(verifySignature("secret", "body", "")).toBe(false);
  });

  it("rejects signature of wrong length", () => {
    expect(verifySignature("secret", "body", "abc")).toBe(false);
  });
});

// ── buildChannelMessage ───────────────────────────────────────────────────

describe("buildChannelMessage", () => {
  it("adds nonce and timestamp", () => {
    const before = Date.now();
    const payload = buildChannelMessage({ userId: "u1", channel: "chat", text: "hi" });
    const after = Date.now();
    expect(typeof payload.nonce).toBe("string");
    expect(payload.nonce.length).toBeGreaterThan(0);
    expect(payload.timestamp).toBeGreaterThanOrEqual(before);
    expect(payload.timestamp).toBeLessThanOrEqual(after);
  });

  it("preserves all input fields", () => {
    const payload = buildChannelMessage({
      userId: "u1",
      channel: "chat",
      text: "hello",
      metadata: { foo: 1 },
    });
    expect(payload.userId).toBe("u1");
    expect(payload.channel).toBe("chat");
    expect(payload.text).toBe("hello");
    expect((payload.metadata as Record<string, unknown>)?.foo).toBe(1);
  });

  it("generates unique nonces", () => {
    const a = buildChannelMessage({ userId: "u1", channel: "c", text: "t" });
    const b = buildChannelMessage({ userId: "u1", channel: "c", text: "t" });
    expect(a.nonce).not.toBe(b.nonce);
  });
});

// ── forwardChannelMessage ─────────────────────────────────────────────────

describe("forwardChannelMessage", () => {
  it("posts to /channel/inbound with HMAC signature", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
    };

    const payload = buildChannelMessage({ userId: "u1", channel: "chat", text: "hello" });
    await forwardChannelMessage("http://guardian", "secret", payload, mockFetch as typeof fetch);

    expect(capturedUrl).toBe("http://guardian/channel/inbound");
    expect(capturedHeaders["content-type"]).toBe("application/json");
    const expectedSig = signPayload("secret", capturedBody);
    expect(capturedHeaders["x-channel-signature"]).toBe(expectedSig);
  });

  it("returns the fetch response", async () => {
    const mockFetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ answer: "reply" }), { status: 200 });
    const payload = buildChannelMessage({ userId: "u1", channel: "chat", text: "hi" });
    const resp = await forwardChannelMessage("http://guardian", "secret", payload, mockFetch as typeof fetch);
    expect(resp.status).toBe(200);
  });
});
