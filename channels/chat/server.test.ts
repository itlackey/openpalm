import { describe, expect, it } from "bun:test";
import { createChatFetch, signPayload } from "./server.ts";

describe("chat adapter", () => {
  it("returns health and auth rejects when token is configured", async () => {
    const fetchHandler = createChatFetch("http://gateway", "secret", "token", fetch);
    const health = await fetchHandler(new Request("http://chat/health"));
    expect(health.status).toBe(200);

    const unauthorized = await fetchHandler(new Request("http://chat/chat", { method: "POST", body: JSON.stringify({ text: "hello" }) }));
    expect(unauthorized.status).toBe(401);
  });

  it("normalizes payload and forwards with valid hmac", async () => {
    let url = "";
    let signature = "";
    let body = "";
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      signature = String((init?.headers as Record<string, string>)["x-channel-signature"]);
      body = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const fetchHandler = createChatFetch("http://gateway", "secret", "", mockFetch as typeof fetch);
    const resp = await fetchHandler(new Request("http://chat/chat", { method: "POST", body: JSON.stringify({ userId: "u1", text: "hello" }) }));
    expect(resp.status).toBe(200);
    expect(url).toBe("http://gateway/channel/inbound");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed.channel).toBe("chat");
    expect(signature).toBe(signPayload("secret", body));
  });
});
