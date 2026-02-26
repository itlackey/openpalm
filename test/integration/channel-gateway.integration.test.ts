import { describe, expect, it } from "bun:test";
import { createChatFetch } from "../../channels/chat/server.ts";

describe("integration: channel adapters -> gateway", () => {
  it("chat forwards a full roundtrip payload", async () => {
    let inboundBody = "";
    const gateway = Bun.serve({
      port: 0,
      async fetch(req) {
        inboundBody = await req.text();
        return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
      }
    });
    const adapter = Bun.serve({
      port: 0,
      fetch: createChatFetch(`http://localhost:${gateway.port}`, "secret", "")
    });

    try {
      const resp = await fetch(`http://localhost:${adapter.port}/chat`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
      expect(resp.status).toBe(200);
      const payload = JSON.parse(inboundBody) as Record<string, unknown>;
      expect(payload.channel).toBe("chat");
    } finally {
      adapter.stop();
      gateway.stop();
    }
  });

  it("gateway error propagates to caller", async () => {
    const gateway = Bun.serve({ port: 0, fetch: () => new Response(JSON.stringify({ error: "boom" }), { status: 502 }) });
    const adapter = Bun.serve({ port: 0, fetch: createChatFetch(`http://localhost:${gateway.port}`, "secret", "") });

    try {
      const resp = await fetch(`http://localhost:${adapter.port}/chat`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
      expect(resp.status).toBe(502);
    } finally {
      adapter.stop();
      gateway.stop();
    }
  });
});
