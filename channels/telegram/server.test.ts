import { describe, expect, it } from "bun:test";
import { createTelegramFetch, signPayload } from "./server.ts";

describe("telegram adapter", () => {
  it("validates webhook secret and skips non-text updates", async () => {
    const fetchHandler = createTelegramFetch("http://gateway", "secret", "expected", fetch);
    const unauthorized = await fetchHandler(new Request("http://telegram/telegram/webhook", { method: "POST", body: JSON.stringify({}) }));
    expect(unauthorized.status).toBe(401);

    const skipped = await fetchHandler(new Request("http://telegram/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "expected" },
      body: JSON.stringify({ message: { from: { id: 1 }, chat: { id: 2 } } })
    }));
    expect(skipped.status).toBe(200);
  });

  it("forwards text updates with signed payload", async () => {
    let signature = "";
    let body = "";
    const mockFetch: typeof fetch = async (_input, init) => {
      signature = String((init?.headers as Record<string, string>)["x-channel-signature"]);
      body = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const fetchHandler = createTelegramFetch("http://gateway", "secret", "", mockFetch);
    const resp = await fetchHandler(new Request("http://telegram/telegram/webhook", {
      method: "POST",
      body: JSON.stringify({ message: { text: "hi", from: { id: 99, username: "u" }, chat: { id: 123 } } })
    }));
    expect(resp.status).toBe(200);
    expect(signature).toBe(signPayload("secret", body));
  });
});
