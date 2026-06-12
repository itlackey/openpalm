import { describe, expect, it } from "bun:test";
import { BaseChannel, type HandleResult } from "./channel-base.ts";

// ── Test channel implementations ────────────────────────────────────────

class TestChannel extends BaseChannel {
  name = "test";
  override get secret(): string { return "test-secret"; }

  constructor(private handler: (req: Request) => Promise<HandleResult | null>) {
    super();
  }

  async handleRequest(req: Request): Promise<HandleResult | null> {
    return this.handler(req);
  }
}

class RoutedChannel extends BaseChannel {
  name = "routed";
  override get secret(): string { return "test-secret"; }

  async handleRequest(_req: Request): Promise<HandleResult | null> {
    return { userId: "u1", text: "hello" };
  }

  async route(_req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/custom") {
      return new Response(JSON.stringify({ custom: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function postRequest(path: string, body: unknown): Request {
  return new Request(`http://test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function capturingFetch() {
  const calls: Array<{ url: string; method: string; headers: Headers; body: string }> = [];
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);

    const path = call.url.replace("http://guardian:8080", "");
    if (call.method === "POST" && path === "/oc/session") {
      return Response.json({ id: "s1" });
    }
    if (call.method === "GET" && path === "/oc/event") {
      const sse = [
        JSON.stringify({ type: "message.part.delta", properties: { sessionID: "s1", messageID: "^m1", delta: "ok" } }),
        JSON.stringify({ type: "session.idle", properties: { sessionID: "s1" } }),
      ].map((frame) => `data: ${frame}\n\n`).join("");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (call.method === "POST" && path === "/oc/session/s1/message") {
      return Response.json({ parts: [{ type: "text", text: "ok" }] });
    }
    return new Response("not found", { status: 404 });
  };
  return {
    mockFetch: mockFetch as typeof fetch,
    get calls() { return calls; },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("BaseChannel health endpoint", () => {
  it("GET /health returns 200 with service info", async () => {
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hi" }));
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://test/health"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("channel-test");
  });
});

describe("BaseChannel message forwarding", () => {
  it("forwards handleRequest result to guardian", async () => {
    const cap = capturingFetch();
    const channel = new TestChannel(async () => ({
      userId: "user-1",
      text: "hello world",
      metadata: { source: "test" },
    }));
    const handler = channel.createFetch(cap.mockFetch);

    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(200);

    const createCall = cap.calls.find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session");
    const eventCall = cap.calls.find((call) => call.method === "GET" && call.url === "http://guardian:8080/oc/event");
    const messageCall = cap.calls.find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session/s1/message");

    expect(createCall?.headers.get("authorization")).toBe(`Basic ${Buffer.from("test:test-secret", "utf-8").toString("base64")}`);
    expect(createCall?.headers.get("x-openpalm-user")).toBe("user-1");
    expect(createCall?.headers.get("x-openpalm-session-key")).toBe("user-1");
    expect(eventCall?.headers.get("x-openpalm-user")).toBe("user-1");

    const forwarded = JSON.parse(messageCall?.body ?? "{}") as Record<string, unknown>;
    expect((forwarded.parts as Array<Record<string, unknown>>)[0]?.text).toBe("hello world");
  });

  it("uses Basic auth derived from principal id and secret", async () => {
    const cap = capturingFetch();
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hmac check" }));
    Object.defineProperty(channel, "secret", { get: () => "test-secret" });
    const handler = channel.createFetch(cap.mockFetch);

    await handler(postRequest("/webhook", {}));
    const createCall = cap.calls.find((call) => call.method === "POST" && call.url === "http://guardian:8080/oc/session");
    expect(createCall?.headers.get("authorization")).toBe(`Basic ${Buffer.from("test:test-secret", "utf-8").toString("base64")}`);
  });
});

describe("BaseChannel null return (skip forwarding)", () => {
  it("returns 200 with skipped=true when handleRequest returns null", async () => {
    const channel = new TestChannel(async () => null);
    const handler = channel.createFetch();
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.skipped).toBe(true);
  });
});

describe("BaseChannel validation", () => {
  it("returns 400 when text is empty", async () => {
    const channel = new TestChannel(async () => ({ userId: "u1", text: "" }));
    const handler = channel.createFetch();
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("text_required");
  });

  it("returns 400 when userId is empty", async () => {
    const channel = new TestChannel(async () => ({ userId: "", text: "hello" }));
    const handler = channel.createFetch();
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("missing_user_id");
  });

  it("returns 400 when handleRequest throws", async () => {
    const channel = new TestChannel(async () => { throw new Error("parse fail"); });
    const handler = channel.createFetch();
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_request");
  });
});

describe("BaseChannel guardian errors", () => {
  it("returns 502 when guardian fetch throws", async () => {
    const failFetch = (async () => { throw new Error("network"); }) as typeof fetch;
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hi" }));
    const handler = channel.createFetch(failFetch);
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(502);
  });

  it("maps non-ok guardian responses during session create to 502", async () => {
    const errorFetch = (async () => new Response("{}", { status: 429 })) as typeof fetch;
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hi" }));
    const handler = channel.createFetch(errorFetch);
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(502);
  });

  it("maps 5xx guardian errors to 502", async () => {
    const errorFetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hi" }));
    const handler = channel.createFetch(errorFetch);
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(502);
  });
});

describe("BaseChannel timeout handling", () => {
  it("returns 502 when guardian fetch times out (abort error)", async () => {
    const timeoutFetch = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hi" }));
    const handler = channel.createFetch(timeoutFetch);
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(502);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("guardian_error");
  });

  it("returns 502 when guardian fetch times out (timeout error)", async () => {
    const timeoutFetch = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hi" }));
    const handler = channel.createFetch(timeoutFetch);
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(502);
  });
});

describe("BaseChannel custom routing", () => {
  it("custom route returns response", async () => {
    const channel = new RoutedChannel();
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://test/custom"));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.custom).toBe(true);
  });

  it("falls through to default handler when route returns null", async () => {
    const cap = capturingFetch();
    const channel = new RoutedChannel();
    const handler = channel.createFetch(cap.mockFetch);
    const resp = await handler(postRequest("/other", {}));
    expect(resp.status).toBe(200);
  });
});

describe("BaseChannel routing", () => {
  it("GET on non-health path returns 404", async () => {
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hi" }));
    const handler = channel.createFetch();
    const resp = await handler(new Request("http://test/webhook", { method: "GET" }));
    expect(resp.status).toBe(404);
  });
});
