import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { executeHttpAction } from "./http.js";
import type { AutomationAction } from "@openpalm/lib";

describe("executeHttpAction", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should make a GET request to the provided URL", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "http",
      url: "https://example.com/webhook",
      method: "GET",
    };

    await executeHttpAction(action);

    expect(capturedUrl).toBe("https://example.com/webhook");
    expect(capturedInit?.method).toBe("GET");
  });

  it("should POST with JSON body when body is provided", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "http",
      url: "https://example.com/api",
      method: "POST",
      body: { key: "value" },
    };

    await executeHttpAction(action);

    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.body).toBe('{"key":"value"}');
    expect((capturedInit?.headers as Record<string, string>)?.["content-type"]).toBe(
      "application/json",
    );
  });

  it("should throw on non-ok response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("error", { status: 500, statusText: "Internal Server Error" });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "http",
      url: "https://example.com/fail",
    };

    expect(executeHttpAction(action)).rejects.toThrow("HTTP 500");
  });

  it("should throw when url is missing", async () => {
    const action: AutomationAction = {
      type: "http",
    };

    expect(executeHttpAction(action)).rejects.toThrow("http action requires a 'url' field");
  });

  it("should pass custom headers", async () => {
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "http",
      url: "https://example.com/api",
      headers: { "x-custom": "value" },
    };

    await executeHttpAction(action);

    expect(capturedHeaders?.["x-custom"]).toBe("value");
  });
});
