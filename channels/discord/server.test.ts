import { describe, expect, it } from "bun:test";
import { createDiscordFetch } from "./server.ts";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";

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

describe("discord adapter", () => {
  it("handles ping interactions", async () => {
    const fetchHandler = createDiscordFetch("http://gateway", "secret", fetch);
    const resp = await fetchHandler(new Request("http://discord/discord/interactions", { method: "POST", body: JSON.stringify({ type: 1 }) }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ type: 1 });
  });

  it("forwards command interactions with normalized metadata", async () => {
    let forwarded = "";
    const mockFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      forwarded = String(init?.body);
      return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
    };
    const fetchHandler = createDiscordFetch("http://gateway", "secret", mockFetch as typeof fetch);
    const resp = await fetchHandler(new Request("http://discord/discord/interactions", {
      method: "POST",
      body: JSON.stringify({
        type: 2,
        data: { name: "hello" },
        user: { id: "123", username: "bob" },
        channel_id: "c1",
        guild_id: "g1"
      })
    }));
    expect(resp.status).toBe(200);
    const body = JSON.parse(forwarded) as Record<string, unknown>;
    expect(body.channel).toBe("discord");
    expect((body.metadata as Record<string, unknown>).guildId).toBe("g1");
  });

  it("/health → 200 {ok:true, service:'channel-discord'}", async () => {
    const fetchHandler = createDiscordFetch("http://gateway", "secret");
    const resp = await fetchHandler(new Request("http://discord/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-discord");
  });

  it("/discord/webhook forwards message with discord: userId prefix", async () => {
    const cap = capturingFetch();
    const fetchHandler = createDiscordFetch("http://gateway", "secret", cap.mockFetch);
    const resp = await fetchHandler(new Request("http://discord/discord/webhook", {
      method: "POST",
      body: JSON.stringify({ userId: "456", text: "webhook msg", channelId: "c2" }),
    }));
    expect(resp.status).toBe(200);
    const forwarded = JSON.parse(cap.body) as Record<string, unknown>;
    expect(forwarded.userId).toBe("discord:456");
    expect(forwarded.channel).toBe("discord");
    expect(forwarded.text).toBe("webhook msg");
  });

  it("/discord/webhook returns 400 when text missing", async () => {
    const cap = capturingFetch();
    const fetchHandler = createDiscordFetch("http://gateway", "secret", cap.mockFetch);
    const resp = await fetchHandler(new Request("http://discord/discord/webhook", {
      method: "POST",
      body: JSON.stringify({ userId: "456" }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("text_required");
  });

  it("HMAC: x-channel-signature matches signPayload", async () => {
    const sharedSecret = "hmac-test-secret";
    const cap = capturingFetch();
    const fetchHandler = createDiscordFetch("http://gateway", sharedSecret, cap.mockFetch);
    await fetchHandler(new Request("http://discord/discord/webhook", {
      method: "POST",
      body: JSON.stringify({ userId: "789", text: "verify hmac" }),
    }));
    const expected = signPayload(sharedSecret, cap.body);
    expect(cap.headers["x-channel-signature"]).toBe(expected);
  });

  it("unknown path → 404", async () => {
    const fetchHandler = createDiscordFetch("http://gateway", "secret");
    const resp = await fetchHandler(new Request("http://discord/nope"));
    expect(resp.status).toBe(404);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  it("GET /discord/interactions → 404", async () => {
    const fetchHandler = createDiscordFetch("http://gateway", "secret");
    const resp = await fetchHandler(new Request("http://discord/discord/interactions", { method: "GET" }));
    expect(resp.status).toBe(404);
  });

  it("command interaction with no text returns 'No message provided'", async () => {
    const cap = capturingFetch();
    const fetchHandler = createDiscordFetch("http://gateway", "secret", cap.mockFetch);
    const resp = await fetchHandler(new Request("http://discord/discord/interactions", {
      method: "POST",
      body: JSON.stringify({
        type: 2,
        data: {},
        user: { id: "123", username: "bob" },
      }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as { type: number; data: { content: string } };
    expect(body.data.content).toBe("No message provided.");
  });
});
