import { describe, expect, it } from "bun:test";
import { createDiscordFetch } from "./server.ts";

describe("discord adapter", () => {
  it("handles ping interactions", async () => {
    const fetchHandler = createDiscordFetch("http://gateway", "secret", fetch);
    const resp = await fetchHandler(new Request("http://discord/discord/interactions", { method: "POST", body: JSON.stringify({ type: 1 }) }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ type: 1 });
  });

  it("forwards command interactions with normalized metadata", async () => {
    let forwarded = "";
    const mockFetch: typeof fetch = async (_input, init) => {
      forwarded = String(init?.body);
      return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
    };
    const fetchHandler = createDiscordFetch("http://gateway", "secret", mockFetch);
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
});
