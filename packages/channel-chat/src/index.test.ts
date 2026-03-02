import { describe, expect, it } from "bun:test";
import ChatChannel from "./index.ts";

function mockGuardianFetch() {
  const mockFetch = async () => {
    return new Response(JSON.stringify({ answer: "hello back", sessionId: "s1" }), { status: 200 });
  };
  return mockFetch as typeof fetch;
}

function createHandler(opts?: { apiKey?: string }) {
  const channel = new ChatChannel();
  Object.defineProperty(channel, "secret", { get: () => "test-secret" });
  if (opts?.apiKey !== undefined) {
    Object.defineProperty(channel, "apiKey", { get: () => opts.apiKey });
  }
  return channel.createFetch(mockGuardianFetch());
}

describe("chat channel health", () => {
  it("GET /health returns 200", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://chat/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-chat");
  });
});

describe("chat channel OpenAI format", () => {
  it("POST /v1/chat/completions returns chat.completion shape", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://chat/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    const choices = body.choices as Array<Record<string, unknown>>;
    const msg = choices[0].message as Record<string, unknown>;
    expect(msg.content).toBe("hello back");
  });

  it("POST /v1/completions returns text_completion shape", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://chat/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", prompt: "hello" }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.object).toBe("text_completion");
    const choices = body.choices as Array<Record<string, unknown>>;
    expect(choices[0].text).toBe("hello back");
  });
});

describe("chat channel Anthropic format", () => {
  it("POST /v1/messages returns Anthropic message shape", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://chat/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3",
        messages: [{ role: "user", content: "hello" }],
      }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.type).toBe("message");
    const content = body.content as Array<Record<string, unknown>>;
    expect(content[0].text).toBe("hello back");
  });
});

describe("chat channel auth", () => {
  it("rejects unauthorized when API key is set", async () => {
    const handler = createHandler({ apiKey: "secret-key" });
    const resp = await handler(new Request("http://chat/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(resp.status).toBe(401);
  });

  it("accepts requests with correct Bearer token", async () => {
    const handler = createHandler({ apiKey: "secret-key" });
    const resp = await handler(new Request("http://chat/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer secret-key" },
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(resp.status).toBe(200);
  });
});

describe("chat channel error handling", () => {
  it("returns 400 for streaming requests", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://chat/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", stream: true, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(resp.status).toBe(400);
  });

  it("returns 400 when no user message found", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://chat/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "system", content: "hi" }] }),
    }));
    expect(resp.status).toBe(400);
  });

  it("returns 404 for unknown paths", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://chat/v1/unknown", { method: "POST" }));
    expect(resp.status).toBe(404);
  });
});
