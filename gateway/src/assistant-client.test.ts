import { describe, expect, it } from "bun:test";
import { OpenCodeClient } from "./assistant-client.ts";

describe("OpenCodeClient", () => {
  it("sends a message and parses the response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            response: "Hello from agent",
            session_id: "sess-1",
            agent: "channel-intake",
            metadata: { processed: true },
          }),
          { headers: { "content-type": "application/json" } }
        );
      },
    });

    try {
      const client = new OpenCodeClient(`http://localhost:${server.port}`);
      const result = await client.send({
        message: "test message",
        userId: "user-1",
        sessionId: "sess-1",
        agent: "channel-intake",
        channel: "chat",
      });

      expect(result.response).toBe("Hello from agent");
      expect(result.sessionId).toBe("sess-1");
      expect(result.agent).toBe("channel-intake");
    } finally {
      server.stop();
    }
  });

  it("throws on non-ok response and preserves body text", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("retry later", { status: 503, headers: { "retry-after": "120" } });
      },
    });

    try {
      const client = new OpenCodeClient(`http://localhost:${server.port}`);
      await expect(
        client.send({
          message: "test",
          userId: "u",
          sessionId: "s",
        })
      ).rejects.toThrow("opencode 503: retry later");
    } finally {
      server.stop();
    }
  });

  it("throws when upstream returns malformed json", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    try {
      const client = new OpenCodeClient(`http://localhost:${server.port}`);
      await expect(
        client.send({
          message: "test",
          userId: "u",
          sessionId: "s",
        })
      ).rejects.toThrow();
    } finally {
      server.stop();
    }
  });

  it("maps abort errors to timeout errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new DOMException("aborted", "AbortError"))) as unknown as typeof fetch;

    try {
      const client = new OpenCodeClient("http://localhost:9999");
      await expect(
        client.send({
          message: "test",
          userId: "u",
          sessionId: "s",
        })
      ).rejects.toThrow("opencode timeout");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
