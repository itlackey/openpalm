import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { executeApiAction } from "./api.js";
import type { AutomationAction } from "@openpalm/lib";

describe("executeApiAction", () => {
  let originalFetch: typeof globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.OPENPALM_ADMIN_API_URL = "http://admin:8100";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("should call admin API with token header", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "api",
      path: "/admin/health",
      method: "GET",
    };

    await executeApiAction(action, "test-token");

    expect(capturedUrl).toBe("http://admin:8100/admin/health");
    expect(capturedHeaders?.["x-admin-token"]).toBe("test-token");
    expect(capturedHeaders?.["x-requested-by"]).toBe("automation");
  });

  it("should reject unsafe paths", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "api",
      path: "/etc/passwd",
      method: "GET",
    };

    // Should not throw, but silently skip
    await executeApiAction(action, "test-token");

    // fetch should not have been called
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("should reject paths with ..", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "api",
      path: "/admin/../etc/passwd",
      method: "GET",
    };

    await executeApiAction(action, "test-token");

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("should gracefully skip when admin is unreachable", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "api",
      path: "/admin/health",
      method: "GET",
    };

    // Should not throw — graceful skip
    await executeApiAction(action, "test-token");
  });

  it("should throw on non-connection errors", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("error", { status: 500, statusText: "Internal Server Error" });
    }) as typeof fetch;

    const action: AutomationAction = {
      type: "api",
      path: "/admin/health",
      method: "GET",
    };

    expect(executeApiAction(action, "test-token")).rejects.toThrow("HTTP 500");
  });
});
