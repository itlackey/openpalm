import { describe, expect, it } from "bun:test";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { BaseChannel, type HandleResult } from "@openpalm/lib/shared/channel-base.ts";

// ── Test channel implementations ────────────────────────────────────────

class TestChannel extends BaseChannel {
  name = "test";

  constructor(private handler: (req: Request) => Promise<HandleResult | null>) {
    super();
  }

  async handleRequest(req: Request): Promise<HandleResult | null> {
    return this.handler(req);
  }
}

class RoutedChannel extends BaseChannel {
  name = "routed";

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
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  let capturedBody = "";
  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    capturedBody = String(init?.body);
    return new Response(JSON.stringify({ answer: "ok", requestId: "r1", sessionId: "s1", userId: "u1" }), { status: 200 });
  };
  return {
    mockFetch: mockFetch as typeof fetch,
    get url() { return capturedUrl; },
    get headers() { return capturedHeaders; },
    get body() { return capturedBody; },
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

    const forwarded = JSON.parse(cap.body) as Record<string, unknown>;
    expect(forwarded.userId).toBe("user-1");
    expect(forwarded.channel).toBe("test");
    expect(forwarded.text).toBe("hello world");
    expect((forwarded.metadata as Record<string, unknown>).source).toBe("test");
    expect(cap.url).toBe("http://guardian:8080/channel/inbound");
  });

  it("HMAC signature matches signPayload", async () => {
    const cap = capturingFetch();
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hmac check" }));
    // Override secret for deterministic testing
    Object.defineProperty(channel, "secret", { get: () => "test-secret" });
    const handler = channel.createFetch(cap.mockFetch);

    await handler(postRequest("/webhook", {}));
    const expected = signPayload("test-secret", cap.body);
    expect(cap.headers["x-channel-signature"]).toBe(expected);
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

  it("returns guardian status on non-ok response", async () => {
    const errorFetch = (async () => new Response("{}", { status: 429 })) as typeof fetch;
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hi" }));
    const handler = channel.createFetch(errorFetch);
    const resp = await handler(postRequest("/webhook", {}));
    expect(resp.status).toBe(429);
  });

  it("maps 5xx guardian errors to 502", async () => {
    const errorFetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;
    const channel = new TestChannel(async () => ({ userId: "u1", text: "hi" }));
    const handler = channel.createFetch(errorFetch);
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

describe("BaseChannel startup", () => {
  // Plan reference: "Missing secret causes startup failure" (plan.md:218)
  // This is a placeholder test to document the expected behavior of BaseChannel.start()
  // when required secrets are missing. It is marked as skipped until the exact
  // start() API and secret requirements are finalized.
  it.skip("Missing secret causes startup failure", async () => {
    const AnyBaseChannel = BaseChannel as any;

    // TODO: Implement this test once the start() contract is confirmed.
    // Example intent:
    // - Ensure environment/config does not provide the required secret.
    // - Call AnyBaseChannel.start(...).
    // - Assert that startup fails (e.g., by throwing an error or rejecting a promise).

    if (typeof AnyBaseChannel.start !== "function") {
      throw new Error("BaseChannel.start is not implemented");
    }
  });
});

