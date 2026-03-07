import { describe, expect, it } from "bun:test";
import { askAssistant } from "./assistant-client.ts";

describe("askAssistant", () => {
  it("returns joined text and builds UTF-8 basic auth header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/session")) {
        return new Response(JSON.stringify({ id: "session_1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          parts: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const result = await askAssistant(
        {
          baseUrl: "http://assistant",
          username: "tést",
          password: "päss",
        },
        "title",
        "prompt",
      );

      expect(result).toBe("hello\nworld");
      expect(calls.length).toBe(2);
      expect(calls[0]?.init?.headers).toMatchObject({
        authorization: "Basic dMOpc3Q6cMOkc3M=",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on non-200 session create response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("bad request", { status: 400 })) as typeof fetch;
    try {
      await expect(
        askAssistant({ baseUrl: "http://assistant" }, "title", "prompt"),
      ).rejects.toThrow("assistant POST /session 400");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on invalid session id", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/session")) {
        return new Response(JSON.stringify({ id: "bad/id" }), { status: 200 });
      }
      return new Response(JSON.stringify({ parts: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await expect(
        askAssistant({ baseUrl: "http://assistant" }, "title", "prompt"),
      ).rejects.toThrow("Invalid session ID");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on non-200 message response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/session")) {
        return new Response(JSON.stringify({ id: "session_1" }), { status: 200 });
      }
      return new Response("upstream error", { status: 502 });
    }) as typeof fetch;
    try {
      await expect(
        askAssistant({ baseUrl: "http://assistant" }, "title", "prompt"),
      ).rejects.toThrow("/message 502");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts on message timeout", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/session")) {
        return new Response(JSON.stringify({ id: "session_1" }), { status: 200 });
      }
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    }) as typeof fetch;
    try {
      await expect(
        askAssistant(
          { baseUrl: "http://assistant", messageTimeoutMs: 5 },
          "title",
          "prompt",
        ),
      ).rejects.toThrow("aborted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
