import { describe, expect, it, afterEach } from "bun:test";
import ApiChannel from "./index.ts";

// ── Streaming stub (OcClient uses the global fetch, not the injected one) ────
// The streaming path drives the guardian /oc proxy via OcClient → global fetch.
// Stub it to emulate create-session → prompt (200) → a one-frame /event
// stream that ends the turn, so `stream:true` returns a real SSE response.

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = REAL_FETCH;
});

function stubStreamingGuardian(): void {
  const enc = new TextEncoder();
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace("http://guardian:8080/oc", "");
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/session") {
      return new Response(JSON.stringify({ id: "ses_stub" }), { status: 200 });
    }
    if (method === "POST" && path === "/session/ses_stub/message") {
      return new Response(JSON.stringify({ parts: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/event") {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "session.status", properties: { sessionID: "ses_stub", status: "idle" } })}\n\n`));
          c.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  (globalThis as { fetch: typeof fetch }).fetch = stub;
}

// ── Test helpers ─────────────────────────────────────────────────────────

function mockGuardianFetch() {
  return ocFetchStub() as typeof fetch;
}

type CapturedCall = {
  url: string;
  method: string;
  headers: Headers;
  body: string;
};

function ocFetchStub(calls?: CapturedCall[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: CapturedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls?.push(call);

    const path = call.url.replace("http://guardian:8080/oc", "");
    if (call.method === "POST" && path === "/session") {
      return Response.json({ id: "s1" });
    }
    if (call.method === "GET" && path === "/event") {
      const sse = [
        JSON.stringify({ type: "message.part.delta", properties: { sessionID: "s1", messageID: "^msg1", delta: "hello back" } }),
        JSON.stringify({ type: "session.idle", properties: { sessionID: "s1" } }),
      ].map((frame) => `data: ${frame}\n\n`).join("");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (call.method === "POST" && path === "/session/s1/message") {
      return new Response(JSON.stringify({ parts: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
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
  const calls: CapturedCall[] = [];
  const mockFetch = ocFetchStub(calls) as typeof fetch;

  const channel = new ApiChannel();
  Object.defineProperty(channel, "secret", { get: () => "test-secret" });
  if (opts?.apiKey !== undefined) {
    Object.defineProperty(channel, "apiKey", { get: () => opts.apiKey });
  }
  const handler = channel.createFetch(mockFetch);
  return { handler, captured: () => calls };
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

// ── CHANNEL_ID override ──────────────────────────────────────────────────

describe("api channel CHANNEL_ID override", () => {
  it("uses CHANNEL_ID env var for channel name", async () => {
    const origId = Bun.env.CHANNEL_ID;
    try {
      Bun.env.CHANNEL_ID = "chat";
      const channel = new ApiChannel();
      Object.defineProperty(channel, "secret", { get: () => "test-secret" });
      expect(channel.name).toBe("chat");

      const handler = channel.createFetch(mockGuardianFetch());
      const resp = await handler(new Request("http://chat/health"));
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.service).toBe("channel-chat");
    } finally {
      if (origId === undefined) delete Bun.env.CHANNEL_ID;
      else Bun.env.CHANNEL_ID = origId;
    }
  });

  it("forwards correct channel name in guardian payload when CHANNEL_ID is set", async () => {
    const origId = Bun.env.CHANNEL_ID;
    try {
      Bun.env.CHANNEL_ID = "chat";
      const { handler, captured } = createHandlerWithCapture();
      await handler(new Request("http://chat/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hello" }] }),
      }));
      const createCall = captured().find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session");
      expect(createCall?.headers.get("authorization")).toBe(`Basic ${Buffer.from("chat:test-secret", "utf-8").toString("base64")}`);
    } finally {
      if (origId === undefined) delete Bun.env.CHANNEL_ID;
      else Bun.env.CHANNEL_ID = origId;
    }
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
    const calls = captured();
    const createCall = calls.find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session");
    const messageCall = calls.find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session/s1/message");
    expect(createCall?.headers.get("authorization")).toBe(`Basic ${Buffer.from("api:test-secret", "utf-8").toString("base64")}`);
    expect(createCall?.headers.get("x-openpalm-user")).toBe("api:u1");
    expect(createCall?.headers.get("x-openpalm-session-key")).toBe("api:u1");
    const parsed = JSON.parse(messageCall?.body ?? "{}") as Record<string, unknown>;
    expect((parsed.parts as Array<Record<string, unknown>>)[0]?.text).toBe("hello");
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
    const messageCall = captured().find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session/s1/message");
    const parsed = JSON.parse(messageCall?.body ?? "{}") as Record<string, unknown>;
    expect((parsed.parts as Array<Record<string, unknown>>)[0]?.text).toBe("part1\npart2");
  });

  it("returns 400 when no user message found", async () => {
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "system", content: "be helpful" }] }),
    }));
    expect(resp.status).toBe(400);
  });

  it("honors stream:true with an SSE chat.completion.chunk response", async () => {
    stubStreamingGuardian();
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", stream: true, messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    const text = await resp.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
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

  it("honors stream:true with an SSE text_completion response", async () => {
    stubStreamingGuardian();
    const handler = createHandler();
    const resp = await handler(new Request("http://api/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", stream: true, prompt: "hi" }),
    }));
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    const text = await resp.text();
    expect(text).toContain('"object":"text_completion"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("forwards correct payload to guardian", async () => {
    const { handler, captured } = createHandlerWithCapture();
    await handler(new Request("http://api/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", user: "u2", prompt: "test prompt" }),
    }));
    const calls = captured();
    const createCall = calls.find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session");
    const messageCall = calls.find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session/s1/message");
    expect(createCall?.headers.get("x-openpalm-user")).toBe("api:u2");
    const parsed = JSON.parse(messageCall?.body ?? "{}") as Record<string, unknown>;
    expect((parsed.parts as Array<Record<string, unknown>>)[0]?.text).toBe("test prompt");
  });

  it("accepts array prompt values", async () => {
    const { handler, captured } = createHandlerWithCapture();
    const resp = await handler(new Request("http://api/v1/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-3.5", prompt: ["test", "prompt"] }),
    }));
    expect(resp.status).toBe(200);
    const messageCall = captured().find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session/s1/message");
    const parsed = JSON.parse(messageCall?.body ?? "{}") as Record<string, unknown>;
    expect((parsed.parts as Array<Record<string, unknown>>)[0]?.text).toBe("test prompt");
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
    const messageCall = captured().find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session/s1/message");
    const parsed = JSON.parse(messageCall?.body ?? "{}") as Record<string, unknown>;
    expect((parsed.parts as Array<Record<string, unknown>>)[0]?.text).toBe("block content");
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
    const createCall = captured().find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session");
    expect(createCall?.headers.get("x-openpalm-user")).toBe("api:anthro-user-1");
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

  it("honors stream:true with an Anthropic SSE response", async () => {
    stubStreamingGuardian();
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
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    const text = await resp.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
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

  it("accepts chat completions with extra Bearer whitespace", async () => {
    const handler = createHandler({ apiKey: "key-123" });
    const resp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer    key-123" },
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
    const body = await resp.json() as Record<string, unknown>;
    expect(body.type).toBe("error");
    expect(body.error).toBeDefined();
  });

  it("returns 502 when guardian success body is not json", async () => {
    const invalidJsonFetch = (async () =>
      new Response("not json", { status: 200 })
    ) as typeof fetch;

    const channel = new ApiChannel();
    Object.defineProperty(channel, "secret", { get: () => "test-secret" });
    Object.defineProperty(channel, "apiKey", { get: () => "" });
    const handler = channel.createFetch(invalidJsonFetch);

    const openAiResp = await handler(new Request("http://api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(openAiResp.status).toBe(502);
    const openAiBody = await openAiResp.json() as Record<string, unknown>;
    expect(openAiBody.error).toBeDefined();

    const anthropicResp = await handler(new Request("http://api/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-3",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    }));
    expect(anthropicResp.status).toBe(502);
    const anthropicBody = await anthropicResp.json() as Record<string, unknown>;
    expect(anthropicBody.type).toBe("error");
  });
});
