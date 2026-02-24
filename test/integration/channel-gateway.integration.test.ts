import { describe, expect, it } from "bun:test";
import { createChatFetch } from "../../channels/chat/server.ts";
import { createDiscordFetch } from "../../channels/discord/server.ts";
import { createOpenAIFetch } from "../../channels/openai/server.ts";
import { createTelegramFetch } from "../../channels/telegram/server.ts";
import { createVoiceFetch } from "../../channels/voice/server.ts";

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
    const adapter = Bun.serve({ port: 0, fetch: createVoiceFetch(`http://localhost:${gateway.port}`, "secret") });

    try {
      const resp = await fetch(`http://localhost:${adapter.port}/voice/transcription`, { method: "POST", body: JSON.stringify({ text: "hello" }) });
      expect(resp.status).toBe(502);
    } finally {
      adapter.stop();
      gateway.stop();
    }
  });

  it("discord and telegram produce normalized channel messages", async () => {
    const received: string[] = [];
    const gateway = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.text());
        return new Response(JSON.stringify({ answer: "ok" }), { status: 200 });
      }
    });

    const discord = Bun.serve({ port: 0, fetch: createDiscordFetch(`http://localhost:${gateway.port}`, "secret") });
    const telegram = Bun.serve({ port: 0, fetch: createTelegramFetch(`http://localhost:${gateway.port}`, "secret", "") });

    try {
      await fetch(`http://localhost:${discord.port}/discord/webhook`, { method: "POST", body: JSON.stringify({ userId: "testuser", text: "hello" }) });
      await fetch(`http://localhost:${telegram.port}/telegram/webhook`, { method: "POST", body: JSON.stringify({ message: { text: "hi", from: { id: 1 }, chat: { id: 2 } } }) });
      expect(received.length).toBe(2);
      expect((JSON.parse(received[0]) as Record<string, unknown>).channel).toBe("discord");
      expect((JSON.parse(received[1]) as Record<string, unknown>).channel).toBe("telegram");
    } finally {
      discord.stop();
      telegram.stop();
      gateway.stop();
    }
  });

  it("openai facade forwards chat completions through gateway", async () => {
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
      fetch: createOpenAIFetch(`http://localhost:${gateway.port}`, "secret", "")
    });

    try {
      const resp = await fetch(`http://localhost:${adapter.port}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(resp.status).toBe(200);
      const payload = JSON.parse(inboundBody) as Record<string, unknown>;
      expect(payload.channel).toBe("openai");
      expect(payload.text).toBe("hello");
    } finally {
      adapter.stop();
      gateway.stop();
    }
  });

  it("openai facade forwards anthropic messages through gateway", async () => {
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
      fetch: createOpenAIFetch(`http://localhost:${gateway.port}`, "secret", "")
    });

    try {
      const resp = await fetch(`http://localhost:${adapter.port}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({
          model: "claude-3-5-sonnet-latest",
          messages: [{ role: "user", content: "hello anthropic" }],
        }),
      });
      expect(resp.status).toBe(200);
      const payload = JSON.parse(inboundBody) as Record<string, unknown>;
      expect(payload.channel).toBe("openai");
      expect(payload.text).toBe("hello anthropic");
    } finally {
      adapter.stop();
      gateway.stop();
    }
  });
});
