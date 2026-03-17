import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { executeAssistantAction } from "./assistant.js";
import type { AutomationAction } from "@openpalm/lib";

describe("executeAssistantAction", () => {
  let originalFetch: typeof globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.OPENCODE_API_URL = "http://assistant:4096";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("should create session and send message", async () => {
    const calls: Array<{ url: string; body: string }> = [];

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body as string;
      calls.push({ url, body });

      if (url.endsWith("/session")) {
        return new Response(JSON.stringify({ id: "test-session-123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/session/test-session-123/message")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "assistant",
      content: "Run daily cleanup",
      agent: "maintenance",
    };

    await executeAssistantAction(action);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("http://assistant:4096/session");
    expect(JSON.parse(calls[0].body).title).toBe("automation/maintenance");
    expect(calls[1].url).toBe("http://assistant:4096/session/test-session-123/message");
    expect(JSON.parse(calls[1].body).parts[0].text).toBe("Run daily cleanup");
  });

  it("should throw when content is missing", async () => {
    const action: AutomationAction = {
      type: "assistant",
    };

    expect(executeAssistantAction(action)).rejects.toThrow(
      "assistant action requires a non-empty 'content' field",
    );
  });

  it("should throw when session creation fails", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("error", { status: 500, statusText: "Internal Server Error" });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "assistant",
      content: "test",
    };

    expect(executeAssistantAction(action)).rejects.toThrow("OpenCode POST /session 500");
  });

  it("should reject invalid session IDs", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ id: "invalid id with spaces" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "assistant",
      content: "test",
    };

    expect(executeAssistantAction(action)).rejects.toThrow("Invalid session ID");
  });
});
