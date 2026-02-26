import { describe, expect, it } from "bun:test";
import { buildChannelMessage, forwardChannelMessage, type ChannelMessage } from "./channel-sdk.ts";
import { signPayload } from "./crypto.ts";

describe("buildChannelMessage", () => {
  const base = { userId: "u1", channel: "chat", text: "hello" };

  it("returns all required fields", () => {
    const msg = buildChannelMessage(base);
    expect(msg.userId).toBe("u1");
    expect(msg.channel).toBe("chat");
    expect(msg.text).toBe("hello");
    expect(typeof msg.nonce).toBe("string");
    expect(typeof msg.timestamp).toBe("number");
    expect(msg.metadata).toEqual({});
  });

  it("nonce is a valid UUID", () => {
    const msg = buildChannelMessage(base);
    expect(msg.nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("generates unique nonces per call", () => {
    const a = buildChannelMessage(base);
    const b = buildChannelMessage(base);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("timestamp is a recent epoch ms", () => {
    const before = Date.now();
    const msg = buildChannelMessage(base);
    const after = Date.now();
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it("defaults metadata to empty object", () => {
    const msg = buildChannelMessage(base);
    expect(msg.metadata).toEqual({});
  });

  it("preserves provided metadata", () => {
    const msg = buildChannelMessage({ ...base, metadata: { foo: "bar" } });
    expect(msg.metadata).toEqual({ foo: "bar" });
  });

  it("sanitizes metadata to plain, bounded JSON values", () => {
    const metadata: Record<string, unknown> = {
      ok: "yes",
      nested: {
        level1: {
          level2: {
            level3: {
              level4: "drop-me",
            },
          },
        },
      },
      list: ["a", { safe: true }, () => "drop"],
    };
    Object.defineProperty(metadata, "__proto__", {
      value: { polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const msg = buildChannelMessage({
      ...base,
      metadata,
    });

    const meta = msg.metadata as Record<string, unknown>;
    expect(meta.ok).toBe("yes");
    // Depth 3 sanitizer truncates beyond level 2
    expect((meta.nested as Record<string, unknown>).level1).toBeDefined();
    // Functions are stringified, arrays are preserved
    expect(Array.isArray(meta.list)).toBe(true);
  });
});

describe("forwardChannelMessage", () => {
  const payload: ChannelMessage = {
    userId: "u1",
    channel: "chat",
    text: "hi",
    nonce: "nonce-1",
    timestamp: 1000,
    metadata: {},
  };
  const secret = "test-secret";

  it("POSTs to {gatewayUrl}/channel/inbound", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "GET";
      return new Response("ok");
    };
    await forwardChannelMessage("http://gw:8080", secret, payload, mockFetch as typeof fetch);
    expect(capturedUrl).toBe("http://gw:8080/channel/inbound");
    expect(capturedMethod).toBe("POST");
  });

  it("sets content-type to application/json", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      capturedHeaders = h;
      return new Response("ok");
    };
    await forwardChannelMessage("http://gw:8080", secret, payload, mockFetch as typeof fetch);
    expect(capturedHeaders["content-type"]).toBe("application/json");
  });

  it("attaches x-channel-signature matching signPayload", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = String(init?.body);
      return new Response("ok");
    };
    await forwardChannelMessage("http://gw:8080", secret, payload, mockFetch as typeof fetch);
    const expected = signPayload(secret, capturedBody);
    expect(capturedHeaders["x-channel-signature"]).toBe(expected);
  });

  it("serializes payload as JSON body", async () => {
    let capturedBody = "";
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = String(init?.body);
      return new Response("ok");
    };
    await forwardChannelMessage("http://gw:8080", secret, payload, mockFetch as typeof fetch);
    const parsed = JSON.parse(capturedBody) as ChannelMessage;
    expect(parsed.userId).toBe("u1");
    expect(parsed.channel).toBe("chat");
    expect(parsed.text).toBe("hi");
    expect(parsed.nonce).toBe("nonce-1");
    expect(parsed.timestamp).toBe(1000);
  });
});
