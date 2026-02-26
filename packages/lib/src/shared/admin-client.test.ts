import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test";
import {
  AdminApiClient,
  resolveAdminBaseUrl,
  resolveAdminToken,
  validateAdminBaseUrl,
} from "./admin-client.ts";

describe("admin-client helpers", () => {
  it("prefers OPENPALM_ADMIN_API_URL over other base URL env vars", () => {
    const baseUrl = resolveAdminBaseUrl({
      OPENPALM_ADMIN_API_URL: "http://admin:8100/",
      ADMIN_APP_URL: "http://localhost:8100",
      GATEWAY_URL: "http://gateway:8080",
    });
    expect(baseUrl).toBe("http://admin:8100");
  });

  it("falls back to ADMIN_TOKEN when OPENPALM_ADMIN_TOKEN is not set", () => {
    const token = resolveAdminToken({
      OPENPALM_ADMIN_TOKEN: "",
      ADMIN_TOKEN: "admin-secret",
    });
    expect(token).toBe("admin-secret");
  });

  it("rejects insecure public HTTP URLs by default", () => {
    expect(() => validateAdminBaseUrl("http://example.com:8100")).toThrow("insecure_admin_api_url");
  });

  it("treats whitespace-only OPENPALM_ADMIN_TOKEN as empty", () => {
    const token = resolveAdminToken({
      OPENPALM_ADMIN_TOKEN: "   ",
      ADMIN_TOKEN: "fallback-token",
    });
    expect(token).toBe("fallback-token");
  });

  it("allows private network HTTP URLs", () => {
    expect(() => validateAdminBaseUrl("http://admin:8100")).not.toThrow();
    expect(() => validateAdminBaseUrl("http://127.0.0.1:8100")).not.toThrow();
  });

  it("allows public HTTP URLs when explicitly enabled", () => {
    expect(() => validateAdminBaseUrl("http://example.com:8100", true)).not.toThrow();
  });
});

describe("AdminApiClient REST methods", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof mock>;

  function createClient() {
    return new AdminApiClient({
      baseUrl: "http://localhost:8100",
      token: "test-token",
      timeoutMs: 5000,
    });
  }

  function mockFetchResponse(status: number, body: unknown) {
    fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }))
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  }

  beforeEach(() => {
    fetchMock = mock(() => Promise.resolve(new Response("{}", { status: 200 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("health() sends GET /health", async () => {
    mockFetchResponse(200, { ok: true, status: "healthy" });
    const client = createClient();
    const result = await client.health();
    expect(result).toEqual({ ok: true, status: "healthy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/health");
    expect(options.method).toBe("GET");
    expect(options.headers["x-admin-token"]).toBe("test-token");
  });

  it("listContainers() sends GET /containers", async () => {
    mockFetchResponse(200, { ok: true, containers: [] });
    const client = createClient();
    const result = await client.listContainers();
    expect(result).toEqual({ ok: true, containers: [] });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/containers");
    expect(options.method).toBe("GET");
  });

  it("containerUp() sends POST /containers/up with service name", async () => {
    mockFetchResponse(200, { ok: true, action: "up", service: "admin" });
    const client = createClient();
    const result = await client.containerUp("admin");
    expect(result).toEqual({ ok: true, action: "up", service: "admin" });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/containers/up");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ service: "admin" });
  });

  it("containerStop() sends POST /containers/stop with service name", async () => {
    mockFetchResponse(200, { ok: true, action: "stop", service: "admin" });
    const client = createClient();
    await client.containerStop("admin");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/containers/stop");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ service: "admin" });
  });

  it("containerRestart() sends POST /containers/restart with service name", async () => {
    mockFetchResponse(200, { ok: true, action: "restart", service: "gateway" });
    const client = createClient();
    await client.containerRestart("gateway");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/containers/restart");
    expect(JSON.parse(options.body)).toEqual({ service: "gateway" });
  });

  it("containerUpdate() sends POST /containers/update with service name", async () => {
    mockFetchResponse(200, { ok: true, action: "update", service: "gateway" });
    const client = createClient();
    await client.containerUpdate("gateway");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/containers/update");
    expect(JSON.parse(options.body)).toEqual({ service: "gateway" });
  });

  it("serviceLogs() sends POST /containers/service-logs with service and optional tail", async () => {
    mockFetchResponse(200, { ok: true, service: "admin", tail: 100, logs: "line1\nline2" });
    const client = createClient();
    await client.serviceLogs("admin", 100);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/containers/service-logs");
    expect(JSON.parse(options.body)).toEqual({ service: "admin", tail: 100 });
  });

  it("serviceLogs() omits tail when not provided", async () => {
    mockFetchResponse(200, { ok: true, service: "admin", logs: "" });
    const client = createClient();
    await client.serviceLogs("admin");
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ service: "admin" });
  });

  it("listChannels() sends GET /channels", async () => {
    mockFetchResponse(200, { ok: true, channels: {} });
    const client = createClient();
    await client.listChannels();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/channels");
    expect(options.method).toBe("GET");
  });

  it("getStackSpec() sends GET /stack/spec", async () => {
    mockFetchResponse(200, { ok: true, spec: {}, yaml: "" });
    const client = createClient();
    await client.getStackSpec();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/stack/spec");
    expect(options.method).toBe("GET");
  });

  it("setStackSpec() sends POST /stack/spec with spec", async () => {
    mockFetchResponse(200, { ok: true });
    const client = createClient();
    const spec = { channels: { chat: { enabled: true } } };
    await client.setStackSpec(spec);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/stack/spec");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ spec });
  });

  it("applyStack() sends POST /stack/apply", async () => {
    mockFetchResponse(200, { ok: true });
    const client = createClient();
    await client.applyStack();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/stack/apply");
    expect(options.method).toBe("POST");
  });

  it("throws on non-OK responses with error from body", async () => {
    mockFetchResponse(403, { error: "forbidden" });
    const client = createClient();
    await expect(client.health()).rejects.toThrow("forbidden");
  });

  it("throws generic http error when no error message in body", async () => {
    fetchMock = mock(() =>
      Promise.resolve(new Response("", { status: 500 }))
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const client = createClient();
    await expect(client.health()).rejects.toThrow("http_500");
  });

  it("strips trailing slashes from base URL", async () => {
    mockFetchResponse(200, { ok: true });
    const client = new AdminApiClient({
      baseUrl: "http://localhost:8100///",
      token: "test-token",
    });
    await client.health();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8100/health");
  });
});
