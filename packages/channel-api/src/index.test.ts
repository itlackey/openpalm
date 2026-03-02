import { describe, expect, it } from "bun:test";
import { signPayload } from "@openpalm/channels-sdk";
import ApiChannel from "./index.ts";

// ── Test helpers ─────────────────────────────────────────────────────────

function mockGuardianFetch() {
  return (async () =>
    new Response(JSON.stringify({ answer: "hello back", sessionId: "s1" }), { status: 200 })
  ) as typeof fetch;
}

function createHandler(opts?: { apiKey?: string }) {
  const channel = new ApiChannel();
  Object.defineProperty(channel, "secret", { get: () => "test-secret" });
  if (opts?.apiKey !== undefined) {
    Object.defineProperty(channel, "apiKey", { get: () => opts.apiKey });
  }
  return channel.createFetch(mockGuardianFetch());
}

function createHandlerWithCapture(opts?: { apiKey?: string }) {
  let capturedUrl = "";
  let capturedSignature = "";
  let capturedBody = "";
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedSignature = String((init?.headers as Record<string, string>)["x-channel-signature"]);
    capturedBody = String(init?.body);
    return new Response(JSON.stringify({ answer: "hello back" }), { status: 200 });
  }) as typeof fetch;

  const channel = new ApiChannel();
  Object.defineProperty(channel, "secret", { get: () => "test-secret" });
  if (opts?.apiKey !== undefined) {
    Object.defineProperty(channel, "apiKey", { get: () => opts.apiKey });
  }
  const handler = channel.createFetch(mockFetch);
  return { handler, captured: () => ({ url: capturedUrl, signature: capturedSignature, body: capturedBody }) };
}

// ── Health ────────────────────────────────────────────────────────────────

describe("api channel health", () => {
  it("GET /health returns 200", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-api");
  });
});

// ── GET /v1/models ───────────────────────────────────────────────────────

describe("api channel models", () => {
  it("GET /v1/models returns model list", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/models"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.object).toBe("list");
    const data = body.data as Array<Record<string, unknown>>;
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].id).toBe("openpalm");
    expect(data[0].object).toBe("model");
  });
});

// ── POST /v1/chat/completions ────────────────────────────────────────────

describe("api channel chat completions", () => {
  it("returns chat.completion shape", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("chatcmpl-")).toBe(true);
    const choices = body.choices as Array<Record<string, unknown>>;
    const msg = choices[0].message as Record<string, unknown>;
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("hello back");
    expect(choices[0].finish_reason).toBe("stop");
    expect(body.usage).toBeDefined();
  });

  it("forwards correct payload to guardian", async () => {
    const { handler, captured } = createHandlerWithCapture();
    await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini", user: "u1", messages: [{ role: "user", content: "hello" }] }),
    }));
    const { url, body, signature } = captured();
    expect(url).toBe("http://guardian:8080/channel/inbound");
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed.channel).toBe("api");
    expect(parsed.userId).toBe("u1");
    expect(parsed.text).toBe("hello");
    expect(signature).toBe(signPayload("test-secret", body));
  });

  it("extracts text from content-block array messages", async () => {
    const { handler, captured } = createHandlerWithCapture();
    await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4",
        messages: [{ role: "user", content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] }],
      }),
    }));
    const parsed = JSON.parse(captured().body) as Record<string, unknown>;
    expect(parsed.text).toBe("part1\npart2");
  });

  it("returns 400 when no user message found", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "system", content: "be helpful" }] }),
    }));
    expect(resp.status).toBe(400);
  });

  it("returns 400 for streaming requests", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", stream: true, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(resp.status).toBe(400);
  });

  it("defaults model to openpalm when not provided", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.model).toBe("openpalm");
  });
});

// ── POST /v1/completions ─────────────────────────────────────────────────

describe("api channel legacy completions", () => {
  it("returns text_completion shape", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", prompt: "hello" }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.object).toBe("text_completion");
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("cmpl-")).toBe(true);
    const choices = body.choices as Array<Record<string, unknown>>;
    expect(choices[0].text).toBe("hello back");
    expect(choices[0].finish_reason).toBe("stop");
    expect(body.usage).toBeDefined();
  });

  it("returns 400 when prompt is missing", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5" }),
    }));
    expect(resp.status).toBe(400);
  });

  it("returns 400 for streaming requests", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", stream: true, prompt: "hi" }),
    }));
    expect(resp.status).toBe(400);
  });

  it("forwards correct payload to guardian", async () => {
    const { handler, captured } = createHandlerWithCapture();
    await handler(new Request("http://api/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", user: "u2", prompt: "test prompt" }),
    }));
    const parsed = JSON.parse(captured().body) as Record<string, unknown>;
    expect(parsed.channel).toBe("api");
    expect(parsed.userId).toBe("u2");
    expect(parsed.text).toBe("test prompt");
  });
});

// ── POST /v1/messages (Anthropic) ────────────────────────────────────────

describe("api channel Anthropic messages", () => {
  it("returns Anthropic message shape", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      }),
    }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(typeof body.id).toBe("string");
    expect((body.id as string).startsWith("msg_")).toBe(true);
    expect(body.stop_reason).toBe("end_turn");
    expect(body.stop_sequence).toBeNull();
    const content = body.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("hello back");
    const usage = body.usage as Record<string, unknown>;
    expect(typeof usage.input_tokens).toBe("number");
    expect(typeof usage.output_tokens).toBe("number");
  });

  it("extracts text from Anthropic content-block messages", async () => {
    const { handler, captured } = createHandlerWithCapture();
    await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3",
        max_tokens: 1024,
        messages: [{ role: "user", content: [{ type: "text", text: "block content" }] }],
      }),
    }));
    const parsed = JSON.parse(captured().body) as Record<string, unknown>;
    expect(parsed.text).toBe("block content");
  });

  it("extracts user_id from Anthropic metadata", async () => {
    const { handler, captured } = createHandlerWithCapture();
    await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
        metadata: { user_id: "anthro-user-1" },
      }),
    }));
    const parsed = JSON.parse(captured().body) as Record<string, unknown>;
    expect(parsed.userId).toBe("anthro-user-1");
  });

  it("returns 400 when no user message found", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-3", max_tokens: 1024, messages: [] }),
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.type).toBe("error");
  });

  it("returns 400 for streaming requests", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    }));
    expect(resp.status).toBe(400);
  });

  it("returns model in response", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3-sonnet-20240229",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    }));
    const body = await resp.json() as Record<string, unknown>;
    expect(body.model).toBe("claude-3-sonnet-20240229");
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────

describe("api channel OpenAI auth", () => {
  it("rejects unauthorized chat completions when API key is set", async () => {
    const handler = createHandler({ apiKey: "key-123" });
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(resp.status).toBe(401);
  });

  it("accepts chat completions with correct Bearer token", async () => {
    const handler = createHandler({ apiKey: "key-123" });
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer key-123" },
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
    }));
    expect(resp.status).toBe(200);
  });

  it("rejects unauthorized legacy completions when API key is set", async () => {
    const handler = createHandler({ apiKey: "key-123" });
    const resp = await handler(new Request("http://api/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", prompt: "hello" }),
    }));
    expect(resp.status).toBe(401);
  });

  it("accepts legacy completions with correct Bearer token", async () => {
    const handler = createHandler({ apiKey: "key-123" });
    const resp = await handler(new Request("http://api/v1/completions", {
      method: "POST",
      headers: { authorization: "Bearer key-123" },
      body: JSON.stringify({ model: "gpt-3.5", prompt: "hello" }),
    }));
    expect(resp.status).toBe(200);
  });
});

describe("api channel Anthropic auth", () => {
  it("rejects unauthorized Anthropic messages when API key is set", async () => {
    const handler = createHandler({ apiKey: "key-123" });
    const resp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      }),
    }));
    expect(resp.status).toBe(401);
  });

  it("accepts Anthropic messages with correct x-api-key", async () => {
    const handler = createHandler({ apiKey: "key-123" });
    const resp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "key-123" },
      body: JSON.stringify({
        model: "claude-3",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      }),
    }));
    expect(resp.status).toBe(200);
  });

  it("skips auth when no API key is configured", async () => {
    const handler = createHandler({ apiKey: "" });
    const resp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      }),
    }));
    expect(resp.status).toBe(200);
  });
});

// ── Error handling ───────────────────────────────────────────────────────

describe("api channel error handling", () => {
  it("returns 404 for unknown paths", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/unknown", { method: "POST" }));
    expect(resp.status).toBe(404);
  });

  it("returns 400 for invalid JSON on chat completions", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: "not json",
    }));
    expect(resp.status).toBe(400);
  });

  it("returns 400 for invalid JSON on Anthropic messages", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: "not json",
    }));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.type).toBe("error");
  });

  it("returns 502 when guardian fails", async () => {
    const failFetch = (async () =>
      new Response(JSON.stringify({ error: "fail" }), { status: 500 })
    ) as typeof fetch;

    const channel = new ApiChannel();
    Object.defineProperty(channel, "secret", { get: () => "test-secret" });
    Object.defineProperty(channel, "apiKey", { get: () => "" });
    const handler = channel.createFetch(failFetch);

    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(resp.status).toBe(502);
  });

  it("returns 502 when guardian throws", async () => {
    const throwFetch = (async () => { throw new Error("network error"); }) as typeof fetch;

    const channel = new ApiChannel();
    Object.defineProperty(channel, "secret", { get: () => "test-secret" });
    Object.defineProperty(channel, "apiKey", { get: () => "" });
    const handler = channel.createFetch(throwFetch);

    const resp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    }));
    expect(resp.status).toBe(502);
  });
});
