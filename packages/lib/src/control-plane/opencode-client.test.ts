import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { createOpenCodeClient } from "./opencode-client.ts";

// ── Test server helper ──────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve> | null = null;
let serverPort = 0;

function startMockServer(handler: (req: Request) => Response | Promise<Response>) {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: handler,
  });
  serverPort = server.port;
}

afterEach(() => {
  if (server) { server.stop(true); server = null; }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("createOpenCodeClient", () => {
  test("proxy returns ok:true for 200 responses", async () => {
    startMockServer(() => new Response(JSON.stringify({ hello: "world" }), {
      headers: { "Content-Type": "application/json" },
    }));

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    const result = await client.proxy("/test");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ hello: "world" });
  });

  test("proxy returns ok:false for non-200 responses", async () => {
    startMockServer(() => new Response(JSON.stringify({ message: "bad" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }));

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    const result = await client.proxy("/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toBe("bad");
    }
  });

  test("proxy returns unavailable for gateway errors", async () => {
    startMockServer(() => new Response("bad gateway", { status: 502 }));

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    const result = await client.proxy("/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("opencode_unavailable");
    }
  });

  test("proxy returns unavailable on network error", async () => {
    const client = createOpenCodeClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    const result = await client.proxy("/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("opencode_unavailable");
    }
  });

  test("getProviders returns array from data.all", async () => {
    startMockServer(() => new Response(JSON.stringify({
      all: [{ id: "openai", name: "OpenAI" }, { id: "groq", name: "Groq" }],
    }), { headers: { "Content-Type": "application/json" } }));

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    const providers = await client.getProviders();
    expect(providers).toHaveLength(2);
    expect(providers[0].id).toBe("openai");
  });

  test("getProviders returns empty array on error", async () => {
    startMockServer(() => new Response("error", { status: 500 }));

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    const providers = await client.getProviders();
    expect(providers).toEqual([]);
  });

  test("getProviderAuth returns auth map", async () => {
    startMockServer(() => new Response(JSON.stringify({
      openai: [{ type: "api", label: "API Key" }],
    }), { headers: { "Content-Type": "application/json" } }));

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    const auth = await client.getProviderAuth();
    expect(auth.openai).toHaveLength(1);
    expect(auth.openai[0].type).toBe("api");
  });

  test("setProviderApiKey sends PUT with correct body", async () => {
    let receivedBody: any = null;
    let receivedMethod = "";
    let receivedPath = "";

    startMockServer(async (req) => {
      receivedMethod = req.method;
      receivedPath = new URL(req.url).pathname;
      receivedBody = await req.json();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    const result = await client.setProviderApiKey("openai", "sk-test-123");

    expect(result.ok).toBe(true);
    expect(receivedMethod).toBe("PUT");
    expect(receivedPath).toBe("/auth/openai");
    expect(receivedBody).toEqual({ type: "api", key: "sk-test-123" });
  });

  test("isAvailable returns true when /provider responds 200", async () => {
    startMockServer(() => new Response(JSON.stringify({ all: [] }), {
      headers: { "Content-Type": "application/json" },
    }));

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    expect(await client.isAvailable()).toBe(true);
  });

  test("isAvailable returns false when unreachable", async () => {
    const client = createOpenCodeClient({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    expect(await client.isAvailable()).toBe(false);
  });

  test("getConfig returns config object on success", async () => {
    startMockServer(() => new Response(JSON.stringify({ model: "gpt-4o" }), {
      headers: { "Content-Type": "application/json" },
    }));

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    const config = await client.getConfig();
    expect(config).toEqual({ model: "gpt-4o" });
  });

  test("getConfig returns null on error", async () => {
    startMockServer(() => new Response("error", { status: 500 }));

    const client = createOpenCodeClient({ baseUrl: `http://127.0.0.1:${serverPort}` });
    expect(await client.getConfig()).toBeNull();
  });
});
