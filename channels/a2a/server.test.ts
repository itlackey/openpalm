import { describe, expect, it } from "bun:test";
import { createA2aChannel } from "./channel.ts";
import { createFetch, signPayload } from "./server.ts";

describe("a2a adapter", () => {
  const adapter = createA2aChannel();

  it("returns health status", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/health"));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { ok: boolean; service: string };
    expect(data.ok).toBe(true);
    expect(data.service).toBe("channel-a2a");
  });

  it("returns 404 for unknown routes", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/unknown"));
    expect(resp.status).toBe(404);
  });

  it("serves agent card at well-known endpoint", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/.well-known/agent.json"));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { name: string; skills: Array<{ id: string }> };
    expect(data.name).toBe("OpenPalm");
    expect(data.skills.length).toBeGreaterThan(0);
    expect(data.skills[0].id).toBe("chat");
  });

  it("returns error for unknown JSON-RPC method", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/a2a", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/unknown" }),
      headers: { "content-type": "application/json" },
    }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { error: { code: number } };
    expect(data.error.code).toBe(-32601);
  });

  it("returns error when message text is missing", async () => {
    const handler = createFetch(adapter, "http://gateway", "secret");
    const resp = await handler(new Request("http://test/a2a", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/send",
        params: { message: { parts: [] } },
      }),
      headers: { "content-type": "application/json" },
    }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { error: { code: number } };
    expect(data.error.code).toBe(-32602);
  });

  it("normalizes tasks/send payload and forwards with valid HMAC", async () => {
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

    const resp = await handler(new Request("http://test/a2a", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/send",
        params: {
          id: "task-123",
          message: {
            parts: [{ type: "text", text: "hello agent" }],
            metadata: { userId: "agent-1" },
          },
        },
      }),
      headers: { "content-type": "application/json" },
    }));

    expect(resp.status).toBe(200);
    expect(capturedUrl).toBe("http://gateway/channel/inbound");

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(parsed.channel).toBe("a2a");
    expect(parsed.text).toBe("hello agent");
    expect(parsed.userId).toBe("agent-1");
    expect(typeof parsed.nonce).toBe("string");
    expect(typeof parsed.timestamp).toBe("number");
    expect(capturedSig).toBe(signPayload("test-secret", capturedBody));

    const data = (await resp.json()) as {
      jsonrpc: string;
      id: number;
      result: {
        id: string;
        status: { state: string };
        artifacts: Array<{ parts: Array<{ type: string; text: string }> }>;
      };
    };
    expect(data.jsonrpc).toBe("2.0");
    expect(data.id).toBe(3);
    expect(data.result.id).toBe("task-123");
    expect(data.result.status.state).toBe("completed");
    expect(data.result.artifacts[0].parts[0].text).toBe("hello from assistant");
  });

  it("returns gateway error as JSON-RPC error", async () => {
    const mockFetch = async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("Internal Server Error", { status: 500 });

    const handler = createFetch(adapter, "http://gateway", "secret", mockFetch as typeof fetch);

    const resp = await handler(new Request("http://test/a2a", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tasks/send",
        params: {
          message: { parts: [{ type: "text", text: "hello" }] },
        },
      }),
      headers: { "content-type": "application/json" },
    }));

    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { error: { code: number; message: string } };
    expect(data.error.code).toBe(-32000);
    expect(data.error.message).toContain("Gateway error");
  });
});
