import { describe, expect, it } from "bun:test";
import { createChatFetch } from "../../channels/chat/server.ts";

// ---------------------------------------------------------------------------
// Stub fetch: records the last call and always returns a 200 JSON response so
// the chat handler can complete successfully when we expect a 200.
// ---------------------------------------------------------------------------
type FetchCall = { url: string; init: RequestInit };

function makeMockFetch(status = 200, responseBody = '{"ok":true}'): {
  fetch: typeof fetch;
  lastCall: () => FetchCall | undefined;
} {
  let last: FetchCall | undefined;
  const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    last = { url: input.toString(), init: init ?? {} };
    return new Response(responseBody, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    fetch: mockFetch as unknown as typeof fetch,
    lastCall: () => last,
  };
}

// A factory for the handler under test, wired to a no-op (offline) gateway.
function handler(inboundToken = "") {
  const { fetch: mockFetch } = makeMockFetch();
  return createChatFetch("http://gateway", "test-secret", inboundToken, mockFetch);
}

// Convenience: POST /chat with arbitrary body/headers.
function postChat(
  body: string | null,
  headers: Record<string, string> = { "content-type": "application/json" },
  token = "",
): Request {
  const hdrs = new Headers(headers);
  if (token) hdrs.set("x-chat-token", token);
  return new Request("http://chat/chat", {
    method: "POST",
    body: body ?? undefined,
    headers: hdrs,
  });
}

// ---------------------------------------------------------------------------
// Health and routing sanity (ensures non-/chat paths still work as expected)
// ---------------------------------------------------------------------------
describe("security: input bounds — routing", () => {
  it("GET /health returns 200", async () => {
    const h = handler();
    const resp = await h(new Request("http://chat/health"));
    expect(resp.status).toBe(200);
  });

  it("GET /chat returns 404 (only POST is accepted)", async () => {
    const h = handler();
    const resp = await h(new Request("http://chat/chat"));
    expect(resp.status).toBe(404);
  });

  it("POST to unknown path returns 404", async () => {
    const h = handler();
    const resp = await h(
      new Request("http://chat/unknown", { method: "POST", body: "{}" }),
    );
    expect(resp.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Authentication — inbound token enforcement
// ---------------------------------------------------------------------------
describe("security: input bounds — authentication", () => {
  it("returns 401 when inbound token is required but missing", async () => {
    const h = handler("required-token");
    const resp = await h(postChat(JSON.stringify({ text: "hi" })));
    expect(resp.status).toBe(401);
  });

  it("returns 401 when inbound token is wrong", async () => {
    const h = handler("correct-token");
    const resp = await h(postChat(JSON.stringify({ text: "hi" }), {
      "content-type": "application/json",
    }, "wrong-token"));
    expect(resp.status).toBe(401);
  });

  it("returns 401 when inbound token is present but empty string", async () => {
    const h = handler("required-token");
    const resp = await h(postChat(JSON.stringify({ text: "hi" }), {
      "content-type": "application/json",
      "x-chat-token": "",
    }));
    expect(resp.status).toBe(401);
  });

  it("accepts request when correct inbound token is supplied", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const h = createChatFetch("http://gateway", "secret", "tok123", mockFetch);
    const resp = await h(postChat(JSON.stringify({ text: "hello" }), {
      "content-type": "application/json",
    }, "tok123"));
    expect(resp.status).toBe(200);
  });

  it("accepts request when no inbound token is configured (open channel)", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const h = createChatFetch("http://gateway", "secret", "", mockFetch);
    const resp = await h(postChat(JSON.stringify({ text: "hello" })));
    expect(resp.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Missing / empty required field: text
// ---------------------------------------------------------------------------
describe("security: input bounds — missing text field", () => {
  const cases: [string, string][] = [
    ["no text property", JSON.stringify({})],
    ["text is null", JSON.stringify({ text: null })],
    ["text is empty string", JSON.stringify({ text: "" })],
    ["text is false", JSON.stringify({ text: false })],
    ["text is 0", JSON.stringify({ text: 0 })],
    ["only unrelated fields", JSON.stringify({ userId: "u1", metadata: {} })],
  ];

  for (const [label, body] of cases) {
    it(`rejects body where ${label}`, async () => {
      const h = handler();
      const resp = await h(postChat(body));
      expect(resp.status).toBe(400);
    });
  }
});

// ---------------------------------------------------------------------------
// Invalid / malformed JSON body
// ---------------------------------------------------------------------------
describe("security: input bounds — malformed request body", () => {
  const cases: [string, string][] = [
    ["invalid JSON", "not-json"],
    ["truncated JSON body", '{"text":"hi"'],
    ["empty body", ""],
    ["JSON array body", JSON.stringify([{ text: "hi" }])],
    ["plain string JSON body", JSON.stringify("just a string")],
  ];

  async function expectNon200(body: string) {
    const h = handler();
    let status: number;
    try {
      const resp = await h(postChat(body));
      status = resp.status;
    } catch {
      status = 500;
    }
    expect(status).not.toBe(200);
  }

  for (const [label, body] of cases) {
    it(`throws or returns non-200 for ${label}`, async () => {
      await expectNon200(body);
    });
  }
});

// ---------------------------------------------------------------------------
// Valid payloads — ensure the happy path reaches the gateway
// ---------------------------------------------------------------------------
describe("security: input bounds — valid requests pass through", () => {
  it("forwards a minimal valid message to the gateway", async () => {
    const { fetch: mockFetch, lastCall } = makeMockFetch();
    const h = createChatFetch("http://gateway", "secret", "", mockFetch);
    const resp = await h(postChat(JSON.stringify({ text: "hello" })));
    expect(resp.status).toBe(200);
    expect(lastCall()?.url).toBe("http://gateway/channel/inbound");
  });

  it("forwards optional userId and metadata fields", async () => {
    const { fetch: mockFetch, lastCall } = makeMockFetch();
    const h = createChatFetch("http://gateway", "secret", "", mockFetch);
    await h(postChat(JSON.stringify({ text: "hi", userId: "u42", metadata: { src: "test" } })));
    const call = lastCall();
    expect(call).toBeDefined();
    const forwarded = JSON.parse(call!.init.body as string);
    expect(forwarded.userId).toBe("u42");
    expect(forwarded.channel).toBe("chat");
    expect(forwarded.text).toBe("hi");
    expect(forwarded.metadata).toEqual({ src: "test" });
  });

  it("defaults userId to 'chat-user' when not provided", async () => {
    const { fetch: mockFetch, lastCall } = makeMockFetch();
    const h = createChatFetch("http://gateway", "secret", "", mockFetch);
    await h(postChat(JSON.stringify({ text: "anonymous message" })));
    const call = lastCall();
    const forwarded = JSON.parse(call!.init.body as string);
    expect(forwarded.userId).toBe("chat-user");
  });

  it("attaches an x-channel-signature header before forwarding", async () => {
    const { fetch: mockFetch, lastCall } = makeMockFetch();
    const h = createChatFetch("http://gateway", "my-secret", "", mockFetch);
    await h(postChat(JSON.stringify({ text: "signed" })));
    const call = lastCall();
    const sig = (call!.init.headers as Record<string, string>)["x-channel-signature"];
    expect(sig).toBeDefined();
    expect(/^[0-9a-f]{64}$/.test(sig)).toBe(true);
  });

  it("handles a text message with Unicode content", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const h = createChatFetch("http://gateway", "secret", "", mockFetch);
    const resp = await h(postChat(JSON.stringify({ text: "\u4e2d\u6587\uD83D\uDE00" })));
    expect(resp.status).toBe(200);
  });

  it("handles a large text field without error (10 000 characters)", async () => {
    // No upper-bound is enforced by the chat server today; this test documents
    // that large payloads do not cause an unhandled exception and confirms the
    // current behaviour.  If a limit is added in the future, update this test.
    const { fetch: mockFetch } = makeMockFetch();
    const h = createChatFetch("http://gateway", "secret", "", mockFetch);
    const resp = await h(postChat(JSON.stringify({ text: "a".repeat(10_000) })));
    expect(resp.status).toBe(200);
  });

  it("handles a very large text field (100 000 characters) without unhandled exception", async () => {
    const { fetch: mockFetch } = makeMockFetch();
    const h = createChatFetch("http://gateway", "secret", "", mockFetch);
    const resp = await h(postChat(JSON.stringify({ text: "x".repeat(100_000) })));
    expect(resp.status).toBe(200);
  });
});
