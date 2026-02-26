import { describe, expect, it } from "bun:test";
import { createSimpleTextAdapter } from "./channel-simple-text.ts";

describe("createSimpleTextAdapter", () => {
  const adapter = createSimpleTextAdapter({
    channel: "chat",
    routePath: "/chat",
    serviceName: "channel-chat",
    userIdFallback: "chat-user",
    inboundTokenHeader: "x-chat-token",
    inboundToken: "test-token",
  });

  const route = adapter.routes[0];

  it("rejects unauthorized requests when inbound token is configured", async () => {
    const result = await route.handler(new Request("http://chat/chat", {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unauthorized result");
    expect(result.status).toBe(401);
  });

  it("normalizes and returns payload for valid requests", async () => {
    const result = await route.handler(new Request("http://chat/chat", {
      method: "POST",
      headers: { "x-chat-token": "test-token" },
      body: JSON.stringify({ text: " hello ", metadata: { a: 1 } }),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful payload");
    expect(result.payload.channel).toBe("chat");
    expect(result.payload.userId).toBe("chat-user");
    expect(result.payload.text).toBe("hello");
    expect(result.payload.metadata).toEqual({ a: 1 });
  });

  it("sanitizes nested metadata and drops dangerous keys", async () => {
    const result = await route.handler(new Request("http://chat/chat", {
      method: "POST",
      headers: { "x-chat-token": "test-token" },
      body: JSON.stringify({
        text: "hello",
        metadata: {
          ok: true,
          __proto__: { polluted: true },
          nested: { a: { b: { c: { d: 1 } } } },
        },
      }),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful payload");
    expect(result.payload.metadata).toEqual({
      ok: true,
      nested: { a: { b: "[truncated]" } },
    });
  });
});
