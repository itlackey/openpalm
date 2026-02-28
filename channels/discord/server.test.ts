import { describe, expect, it } from "bun:test";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { createDiscordFetch } from "./server.ts";

function webhookRequest(body: unknown): Request {
  return new Request("http://discord/discord/webhook", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function capturingFetch() {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = "";
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    capturedBody = String(init?.body);
    return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
  };
  return {
    mockFetch: mockFetch as typeof fetch,
    get url() { return capturedUrl; },
    get headers() { return capturedHeaders; },
    get body() { return capturedBody; },
  };
}

describe("health endpoint", () => {
  it("GET /health returns 200 with service info", async () => {
    const handler = createDiscordFetch("http://guardian", "secret");
    const resp = await handler(new Request("http://discord/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-discord");
  });
});

describe("webhook endpoint", () => {
  it("forwards message with discord: userId prefix", async () => {
    const cap = capturingFetch();
    const handler = createDiscordFetch("http://guardian", "secret", cap.mockFetch);
    const resp = await handler(webhookRequest({ userId: "456", text: "webhook msg", channelId: "c2" }));
    expect(resp.status).toBe(200);
    const forwarded = JSON.parse(cap.body) as Record<string, unknown>;
    expect(forwarded.userId).toBe("discord:456");
    expect(forwarded.channel).toBe("discord");
    expect(forwarded.text).toBe("webhook msg");
  });

  it("returns 400 when text missing", async () => {
    const cap = capturingFetch();
    const handler = createDiscordFetch("http://guardian", "secret", cap.mockFetch);
    const resp = await handler(webhookRequest({ userId: "456" }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("text_required");
  });

  it("returns 400 when userId missing", async () => {
    const cap = capturingFetch();
    const handler = createDiscordFetch("http://guardian", "secret", cap.mockFetch);
    const resp = await handler(webhookRequest({ text: "hello" }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("missing_user_id");
  });

  it("returns 400 for invalid JSON", async () => {
    const handler = createDiscordFetch("http://guardian", "secret");
    const resp = await handler(new Request("http://discord/discord/webhook", {
      method: "POST",
      body: "not-json{{{",
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_json");
  });

  it("HMAC: x-channel-signature matches signPayload", async () => {
    const sharedSecret = "hmac-test-secret";
    const cap = capturingFetch();
    const handler = createDiscordFetch("http://guardian", sharedSecret, cap.mockFetch);
    await handler(webhookRequest({ userId: "789", text: "verify hmac" }));
    const expected = signPayload(sharedSecret, cap.body);
    expect(cap.headers["x-channel-signature"]).toBe(expected);
  });

  it("forwards to guardian /channel/inbound", async () => {
    const cap = capturingFetch();
    const handler = createDiscordFetch("http://guardian", "secret", cap.mockFetch);
    await handler(webhookRequest({ userId: "1", text: "hello" }));
    expect(cap.url).toBe("http://guardian/channel/inbound");
  });
});

describe("routing", () => {
  it("unknown path → 404", async () => {
    const handler = createDiscordFetch("http://guardian", "secret");
    const resp = await handler(new Request("http://discord/nope"));
    expect(resp.status).toBe(404);
  });

  it("GET /discord/webhook → 404", async () => {
    const handler = createDiscordFetch("http://guardian", "secret");
    const resp = await handler(new Request("http://discord/discord/webhook", { method: "GET" }));
    expect(resp.status).toBe(404);
  });
});
