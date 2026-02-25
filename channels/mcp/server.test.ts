import { describe, expect, it } from "bun:test";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { createMcpChannel } from "./channel.ts";
import { createFetch } from "./server.ts";

describe("mcp adapter", () => {
  const adapter = createMcpChannel();

  it("returns health status", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/health"));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok: boolean; service: string };
    expect(data.ok).toBe(true);
    expect(data.service).toBe("channel-mcp");
  });

  it("returns 404 for unknown routes", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/unknown"));
    expect(resp.status).toBe(404);
  });

  it("handles initialize and returns server capabilities", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      headers: { "content-type": "application/json" },
    }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { jsonrpc: string; id: number; result: Record<string, unknown> };
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(1);
    expect(data.result.protocolVersion).toBe("2025-03-26");
    expect(data.result.capabilities).toBeTruthy();
    const serverInfo = data.result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("openpalm-mcp");
  });

  it("handles tools/list and returns available tools", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      headers: { "content-type": "application/json" },
    }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { result: { tools: Array<{ name: string }> } };
    expect(data.result.tools.length).toBeGreaterThan(0);
    expect(data.result.tools[0].name).toBe("openpalm_chat");
  });

  it("returns error for unknown tool", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "nonexistent", arguments: {} },
      }),
      headers: { "content-type": "application/json" },
    }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { error: { code: number; message: string } };
    expect(data.error.code).toBe(-32602);
  });

  it("returns error when message argument is missing", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "openpalm_chat", arguments: {} },
      }),
      headers: { "content-type": "application/json" },
    }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { error: { code: number } };
    expect(data.error.code).toBe(-32602);
  });

  it("returns error for unknown JSON-RPC method", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "unknown/method" }),
      headers: { "content-type": "application/json" },
    }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { error: { code: number } };
    expect(data.error.code).toBe(-32601);
  });

  it("normalizes tools/call payload and forwards with valid HMAC", async () => {
    let capturedUrl = "";
    let capturedSig = "";
    let capturedBody = "";

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedSig = String((init?.headers as Record<string, string>)["x-channel-signature"]);
      capturedBody = String(init?.body);
      return new Response(JSON.stringify({ answer: "hello from assistant" }), { status: 200 });
    };

    const handler = createFetch(adapter, "http://gateway", "test-secret", mockFetch as typeof fetch);

    const resp = await handler(new Request("http://test/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "openpalm_chat", arguments: { message: "hello", userId: "u1" } },
      }),
      headers: { "content-type": "application/json" },
    }));

    expect(resp.status).toBe(200);
    expect(capturedUrl).toBe("http://gateway/channel/inbound");

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(parsed.channel).toBe("mcp");
    expect(parsed.text).toBe("hello");
    expect(parsed.userId).toBe("u1");
    expect(typeof parsed.nonce).toBe("string");
    expect(typeof parsed.timestamp).toBe("number");
    expect(capturedSig).toBe(signPayload("test-secret", capturedBody));

    const data = (await resp.json()) as { jsonrpc: string; id: number; result: { content: Array<{ type: string; text: string }> } };
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(6);
    expect(data.result.content[0].type).toBe("text");
    expect(data.result.content[0].text).toBe("hello from assistant");
  });

  it("returns gateway error as JSON-RPC error", async () => {
    const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("Internal Server Error", { status: 500 });

    const handler = createFetch(adapter, "http://gateway", "secret", mockFetch as typeof fetch);

    const resp = await handler(new Request("http://test/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "openpalm_chat", arguments: { message: "hello" } },
      }),
      headers: { "content-type": "application/json" },
    }));

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { error: { code: number; message: string } };
    expect(data.error.code).toBe(-32000);
    expect(data.error.message).toContain("Gateway error");
  });
});
