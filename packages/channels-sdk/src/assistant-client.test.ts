import { describe, expect, it } from "bun:test";
import { askAssistant, createSession, sendMessage } from "./assistant-client.ts";

// ── Helper ─────────────────────────────────────────────────────────────

function withMockFetch<T>(mock: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return fn().finally(() => { globalThis.fetch = original; });
}

// ── createSession tests ────────────────────────────────────────────────

describe("createSession", () => {
  it("returns session id on success", async () => {
    const result = await withMockFetch(
      (async () => new Response(JSON.stringify({ id: "sess_42" }), { status: 200 })) as typeof fetch,
      () => createSession({ baseUrl: "http://assistant" }, "title"),
    );
    expect(result).toBe("sess_42");
  });

  it("throws on non-200 response", async () => {
    await withMockFetch(
      (async () => new Response("bad", { status: 500 })) as typeof fetch,
      async () => {
        await expect(createSession({ baseUrl: "http://assistant" }, "t")).rejects.toThrow("500");
      },
    );
  });

  it("throws on invalid session id", async () => {
    await withMockFetch(
      (async () => new Response(JSON.stringify({ id: "../bad" }), { status: 200 })) as typeof fetch,
      async () => {
        await expect(createSession({ baseUrl: "http://assistant" }, "t")).rejects.toThrow("Invalid session ID");
      },
    );
  });
});

// ── sendMessage tests ──────────────────────────────────────────────────

describe("sendMessage", () => {
  it("returns joined text parts", async () => {
    const result = await withMockFetch(
      (async () => new Response(JSON.stringify({
        parts: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      }), { status: 200 })) as typeof fetch,
      () => sendMessage({ baseUrl: "http://assistant" }, "sess1", "prompt"),
    );
    expect(result).toBe("a\nb");
  });

  it("returns (no response) when parts are empty", async () => {
    const result = await withMockFetch(
      (async () => new Response(JSON.stringify({ parts: [] }), { status: 200 })) as typeof fetch,
      () => sendMessage({ baseUrl: "http://assistant" }, "sess1", "prompt"),
    );
    expect(result).toBe("(no response)");
  });

  it("throws on non-200 response", async () => {
    await withMockFetch(
      (async () => new Response("err", { status: 502 })) as typeof fetch,
      async () => {
        await expect(sendMessage({ baseUrl: "http://assistant" }, "sess1", "p")).rejects.toThrow("502");
      },
    );
  });
});

// ── askAssistant tests (preserved from original) ───────────────────────

describe("askAssistant", () => {
  it("returns joined text and builds UTF-8 basic auth header", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await withMockFetch(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
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
      }) as typeof fetch,
      () => askAssistant(
        { baseUrl: "http://assistant", username: "tést", password: "päss" },
        "title",
        "prompt",
      ),
    );

    expect(result).toBe("hello\nworld");
    expect(calls.length).toBe(2);
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Basic dMOpc3Q6cMOkc3M=",
    });
  });

  it("throws on non-200 session create response", async () => {
    await withMockFetch(
      (async () => new Response("bad request", { status: 400 })) as typeof fetch,
      async () => {
        await expect(askAssistant({ baseUrl: "http://assistant" }, "title", "prompt")).rejects.toThrow("assistant POST /session 400");
      },
    );
  });

  it("throws on invalid session id", async () => {
    await withMockFetch(
      (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/session")) {
          return new Response(JSON.stringify({ id: "bad/id" }), { status: 200 });
        }
        return new Response(JSON.stringify({ parts: [] }), { status: 200 });
      }) as typeof fetch,
      async () => {
        await expect(askAssistant({ baseUrl: "http://assistant" }, "title", "prompt")).rejects.toThrow("Invalid session ID");
      },
    );
  });

  it("throws on non-200 message response", async () => {
    await withMockFetch(
      (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/session")) {
          return new Response(JSON.stringify({ id: "session_1" }), { status: 200 });
        }
        return new Response("upstream error", { status: 502 });
      }) as typeof fetch,
      async () => {
        await expect(askAssistant({ baseUrl: "http://assistant" }, "title", "prompt")).rejects.toThrow("/message 502");
      },
    );
  });

  it("aborts on message timeout", async () => {
    await withMockFetch(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/session")) {
          return new Response(JSON.stringify({ id: "session_1" }), { status: 200 });
        }
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      }) as typeof fetch,
      async () => {
        await expect(
          askAssistant({ baseUrl: "http://assistant", messageTimeoutMs: 5 }, "title", "prompt"),
        ).rejects.toThrow("aborted");
      },
    );
  });
});
