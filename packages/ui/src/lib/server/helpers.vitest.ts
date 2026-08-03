/**
 * Tests for helpers.ts — shared API response helpers and auth middleware.
 *
 * Verifies:
 * 1. jsonResponse builds correct Response objects with headers
 * 2. errorResponse builds structured error envelopes per api-spec.md
 * 3. getRequestId extracts from header or generates UUID
 * 4. requireAdmin enforces timing-safe token comparison (security invariant)
 * 5. parseJsonBody returns discriminated result with data or error type
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  jsonResponse,
  errorResponse,
  getRequestId,
  requireAdmin,
  identifyCallerByToken,
  parseJsonBody,
} from "./helpers.js";
import { resetState } from "./test-helpers.js";

// ── Mock RequestEvent ───────────────────────────────────────────────────

function makeEvent(headers: Record<string, string> = {}): {
  request: Request;
} {
  const h = new Headers(headers);
  return {
    request: new Request("http://localhost:8100/admin/test", { headers: h })
  };
}

// ── jsonResponse ────────────────────────────────────────────────────────

describe("jsonResponse", () => {
  test("returns Response with correct status and JSON body", async () => {
    const res = jsonResponse(200, { ok: true, data: "test" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, data: "test" });
  });

  test("sets content-type header to application/json", () => {
    const res = jsonResponse(200, {});
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  test("includes x-request-id when provided", () => {
    const res = jsonResponse(200, {}, "req-123");
    expect(res.headers.get("x-request-id")).toBe("req-123");
  });

  test("omits x-request-id when not provided", () => {
    const res = jsonResponse(200, {});
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  test("supports error status codes", async () => {
    const res = jsonResponse(500, { error: "fail" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("fail");
  });
});

// ── errorResponse ───────────────────────────────────────────────────────

describe("errorResponse", () => {
  test("builds structured error envelope per api-spec.md", async () => {
    const res = errorResponse(401, "unauthorized", "Missing token", {}, "req-1");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("unauthorized");
    expect(body.message).toBe("Missing token");
    expect(body.details).toEqual({});
    expect(body.requestId).toBe("req-1");
  });

  test("includes details when provided", async () => {
    const res = errorResponse(
      400, "bad_request", "Invalid input",
      { field: "name", reason: "too long" }, "req-2"
    );
    const body = await res.json();
    expect(body.details.field).toBe("name");
    expect(body.details.reason).toBe("too long");
  });

  test("sets x-request-id header", () => {
    const res = errorResponse(500, "internal", "Something broke", {}, "req-3");
    expect(res.headers.get("x-request-id")).toBe("req-3");
  });

  test("defaults details to empty object", async () => {
    const res = errorResponse(400, "bad", "msg");
    const body = await res.json();
    expect(body.details).toEqual({});
  });
});

// ── getRequestId ────────────────────────────────────────────────────────

describe("getRequestId", () => {
  test("extracts x-request-id from header", () => {
    const event = makeEvent({ "x-request-id": "custom-id-123" });
    expect(getRequestId(event as never)).toBe("custom-id-123");
  });

  test("generates UUID when header not present", () => {
    const event = makeEvent({});
    const id = getRequestId(event as never);
    // UUID v4 format check
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("generates UUID for empty header value", () => {
    const event = makeEvent({ "x-request-id": "" });
    const id = getRequestId(event as never);
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });
});

// ── requireAdmin ────────────────────────────────────────────────────────

describe("requireAdmin", () => {
  beforeEach(() => {
    resetState("test-admin-token-12345");
  });

  test("returns null (pass) for valid admin token via cookie", () => {
    const event = makeEvent({ cookie: "op_session=test-admin-token-12345" });
    const result = requireAdmin(event as never, "req-1");
    expect(result).toBeNull();
  });

  // Phase 2 (auth/proxy refactor): the x-admin-token header fallback was
  // removed. requireAdmin is cookie-only; presenting the secret in the legacy
  // header MUST be rejected.
  test("rejects valid admin token presented via x-admin-token header (legacy fallback removed)", async () => {
    const event = makeEvent({ "x-admin-token": "test-admin-token-12345" });
    const result = requireAdmin(event as never, "req-1-header");
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
    const body = await result?.json();
    expect(body.error).toBe("unauthorized");
  });

  test("rejects valid admin token presented via Authorization: Bearer (legacy fallback removed)", async () => {
    const event = makeEvent({ authorization: "Bearer test-admin-token-12345" });
    const result = requireAdmin(event as never, "req-1-bearer");
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  test("returns 401 for missing token", async () => {
    const event = makeEvent({});
    const result = requireAdmin(event as never, "req-2");
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
    const body = await result?.json();
    expect(body.error).toBe("unauthorized");
  });

  test("returns 401 for wrong token (cookie)", async () => {
    const event = makeEvent({ cookie: "op_session=wrong-token" });
    const result = requireAdmin(event as never, "req-3");
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  test("returns 401 for empty cookie value", async () => {
    const event = makeEvent({ cookie: "op_session=" });
    const result = requireAdmin(event as never, "req-4");
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  test("rejects token that differs only in length (timing-safe)", async () => {
    const event = makeEvent({ cookie: "op_session=test-admin-token-1234" }); // one char shorter
    const result = requireAdmin(event as never, "req-5");
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  test("includes requestId in error response", async () => {
    const event = makeEvent({});
    const result = requireAdmin(event as never, "my-request-id");
    const body = await result?.json();
    expect(body.requestId).toBe("my-request-id");
  });
});

describe("identifyCallerByToken / requireAdmin (cookie-only after Phase 2)", () => {
  beforeEach(() => {
    resetState("test-admin-token-12345");
  });

  test("identifyCallerByToken returns 'admin' for admin token via cookie", () => {
    const event = makeEvent({ cookie: "op_session=test-admin-token-12345" });
    expect(identifyCallerByToken(event as never)).toBe("admin");
  });

  test("identifyCallerByToken rejects admin token presented via x-admin-token header", () => {
    const event = makeEvent({ "x-admin-token": "test-admin-token-12345" });
    expect(identifyCallerByToken(event as never)).toBeNull();
  });

  // Phase 4: assistantToken was deleted entirely. A cookie carrying any
  // value other than the UI login password is rejected.
  test("identifyCallerByToken rejects unknown cookie values", () => {
    resetState("test-admin-token-12345");
    const event = makeEvent({ cookie: "op_session=some-stale-value" });
    expect(identifyCallerByToken(event as never)).toBeNull();
  });

  test("requireAdmin rejects unknown cookie values", async () => {
    resetState("test-admin-token-12345");
    const event = makeEvent({ cookie: "op_session=some-stale-value" });
    const result = requireAdmin(event as never, "req-stale");
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  test("requireAdmin rejects admin token presented via x-admin-token header", async () => {
    const event = makeEvent({ "x-admin-token": "test-admin-token-12345" });
    const result = requireAdmin(event as never, "req-header");
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
  });

  test("requireAdmin passes for admin token via cookie", () => {
    const event = makeEvent({ cookie: "op_session=test-admin-token-12345" });
    expect(requireAdmin(event as never, "req-admin")).toBeNull();
  });

  test("requireAdmin rejects unknown cookie value", async () => {
    const event = makeEvent({ cookie: "op_session=nope" });
    const result = requireAdmin(event as never, "req-bad");
    expect(result).not.toBeNull();
    expect(result?.status).toBe(401);
    const body = await result?.json();
    expect(body.requestId).toBe("req-bad");
  });
});

// ── parseJsonBody ───────────────────────────────────────────────────────

describe("parseJsonBody", () => {
  test("parses valid JSON body", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ key: "value" }),
      headers: { "content-type": "application/json" }
    });
    const result = await parseJsonBody(req);
    expect(result).toEqual({ data: { key: "value" } });
  });

  test("returns invalid_json error for invalid JSON", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" }
    });
    const result = await parseJsonBody(req);
    expect(result).toEqual({ error: "invalid_json" });
  });

  test("returns invalid_json error for empty body", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      body: ""
    });
    const result = await parseJsonBody(req);
    expect(result).toEqual({ error: "invalid_json" });
  });

  test("returns too_large error when content-length exceeds maxBytes", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ key: "value" }),
      headers: { "content-type": "application/json", "content-length": "2000000" }
    });
    const result = await parseJsonBody(req);
    expect(result).toEqual({ error: "too_large" });
  });

  test("returns too_large when streamed bytes exceed maxBytes despite a smaller content-length", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify({ key: "value" }),
      headers: { "content-type": "application/json", "content-length": "1" }
    });
    const result = await parseJsonBody(req, 8);
    expect(result).toEqual({ error: "too_large" });
  });

  test("counts actual UTF-8 bytes, accepting the exact limit and rejecting one byte over", async () => {
    const body = JSON.stringify({ key: "é" });
    const byteLength = new TextEncoder().encode(body).byteLength;
    const exact = new Request("http://localhost", { method: "POST", body });
    const over = new Request("http://localhost", { method: "POST", body });

    await expect(parseJsonBody(exact, byteLength)).resolves.toEqual({ data: { key: "é" } });
    await expect(parseJsonBody(over, byteLength - 1)).resolves.toEqual({ error: "too_large" });
  });

  test("rejects malformed UTF-8 instead of decoding replacement characters", async () => {
    const prefix = new TextEncoder().encode('{"key":"');
    const suffix = new TextEncoder().encode('"}');
    const body = new Uint8Array([...prefix, 0xc3, 0x28, ...suffix]);
    const req = new Request("http://localhost", { method: "POST", body });

    await expect(parseJsonBody(req)).resolves.toEqual({ error: "invalid_json" });
  });

  test("maps a streamed HTTP 413 error to too_large", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(Object.assign(new Error("body size limit exceeded"), { status: 413 }));
      },
    });
    const req = {
      headers: new Headers(),
      body,
    } as Request;

    await expect(parseJsonBody(req)).resolves.toEqual({ error: "too_large" });
  });

  test.each([null, [], "value", 1, true])("rejects non-object JSON: %j", async (body) => {
    const req = new Request("http://localhost", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await expect(parseJsonBody(req)).resolves.toEqual({ error: "invalid_json" });
  });
});
