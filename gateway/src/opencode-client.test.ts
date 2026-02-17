import { describe, expect, it, mock } from "bun:test";
import { OpenCodeClient } from "./opencode-client.ts";

describe("OpenCodeClient", () => {
  it("sends a message and parses the response", async () => {
    // Start a local mock server
    const server = Bun.serve({
      port: 0,
      fetch(req) {
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

  it("throws on non-ok response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("service unavailable", { status: 503 });
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
      ).rejects.toThrow("opencode 503");
    } finally {
      server.stop();
    }
  });
});
