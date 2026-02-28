/**
 * Tests for assistant-client.ts — OpenCode session/message client.
 *
 * Uses globalThis.fetch mocking to test the two-step session flow
 * without a real assistant service.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { sendPromptToAssistant } from "./assistant-client.js";

// ── Fetch mock helpers ─────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = vi.fn(handler) as typeof fetch;
}

beforeEach(() => {
  // Reset to original fetch before each test
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ── sendPromptToAssistant ──────────────────────────────────────────────

describe("sendPromptToAssistant", () => {
  test("successfully creates session and sends message", async () => {
    mockFetch(async (url: string) => {
      if (url.endsWith("/session")) {
        return jsonResponse({ id: "test-session-123" });
      }
      if (url.includes("/session/test-session-123/message")) {
        return jsonResponse({
          info: {},
          parts: [
            { type: "text", text: "Hello from assistant" },
            { type: "text", text: "Additional context" },
          ],
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await sendPromptToAssistant("What is the status?", {
      title: "test-job",
    });

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe("test-session-123");
    expect(result.text).toBe("Hello from assistant\nAdditional context");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  test("returns ok with (no response) when parts are empty", async () => {
    mockFetch(async (url: string) => {
      if (url.endsWith("/session")) {
        return jsonResponse({ id: "sess-empty" });
      }
      if (url.includes("/message")) {
        return jsonResponse({ info: {}, parts: [] });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await sendPromptToAssistant("test");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("(no response)");
  });

  test("returns error when session creation fails", async () => {
    mockFetch(async () => {
      return new Response("Service unavailable", { status: 503 });
    });

    const result = await sendPromptToAssistant("test");
    expect(result.ok).toBe(false);
    expect(result.sessionId).toBeNull();
    expect(result.error).toContain("503");
  });

  test("returns error when message send fails", async () => {
    mockFetch(async (url: string) => {
      if (url.endsWith("/session")) {
        return jsonResponse({ id: "sess-fail" });
      }
      return new Response("Internal error", { status: 500 });
    });

    const result = await sendPromptToAssistant("test");
    expect(result.ok).toBe(false);
    expect(result.sessionId).toBe("sess-fail");
    expect(result.error).toContain("500");
  });

  test("returns error when fetch throws (network error)", async () => {
    mockFetch(async () => {
      throw new Error("Connection refused");
    });

    const result = await sendPromptToAssistant("test");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Connection refused");
  });

  test("returns error when session ID is invalid", async () => {
    mockFetch(async (url: string) => {
      if (url.endsWith("/session")) {
        return jsonResponse({ id: "../../etc/passwd" });
      }
      return new Response("Not found", { status: 404 });
    });

    const result = await sendPromptToAssistant("test");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid session ID");
  });

  test("passes title to session creation", async () => {
    let capturedBody: string | null = null;
    mockFetch(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) {
        capturedBody = init?.body as string;
        return jsonResponse({ id: "sess-title" });
      }
      if (url.includes("/message")) {
        return jsonResponse({ info: {}, parts: [{ type: "text", text: "ok" }] });
      }
      return new Response("Not found", { status: 404 });
    });

    await sendPromptToAssistant("test", { title: "my-automation" });
    expect(capturedBody).not.toBeNull();
    expect(JSON.parse(capturedBody!).title).toBe("my-automation");
  });

  test("sends prompt in correct format", async () => {
    let capturedBody: string | null = null;
    mockFetch(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) {
        return jsonResponse({ id: "sess-prompt" });
      }
      if (url.includes("/message")) {
        capturedBody = init?.body as string;
        return jsonResponse({ info: {}, parts: [{ type: "text", text: "ok" }] });
      }
      return new Response("Not found", { status: 404 });
    });

    await sendPromptToAssistant("Run a health check");
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.parts).toEqual([{ type: "text", text: "Run a health check" }]);
  });
});
