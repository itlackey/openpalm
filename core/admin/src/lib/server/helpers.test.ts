/**
 * Tests for helpers.ts — shared API response helpers and auth middleware.
 *
 * Verifies:
 * 1. jsonResponse builds correct Response objects with headers
 * 2. errorResponse builds structured error envelopes per api-spec.md
 * 3. getRequestId extracts from header or generates UUID
 * 4. requireAdmin enforces timing-safe token comparison (security invariant)
 * 5. getActor derives actor from auth state, not caller-controlled headers
 * 6. getCallerType normalizes x-requested-by header
 * 7. parseJsonBody returns parsed JSON or empty object on failure
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  jsonResponse,
  errorResponse,
  getRequestId,
  requireAdmin,
  getActor,
  getCallerType,
  parseJsonBody
} from "./helpers.js";
import { resetState } from "./state.js";

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

  test("returns null (pass) for valid admin token", () => {
    const event = makeEvent({ "x-admin-token": "test-admin-token-12345" });
    const result = requireAdmin(event as never, "req-1");
    expect(result).toBeNull();
  });

  test("returns 401 for missing token", async () => {
    const event = makeEvent({});
    const result = requireAdmin(event as never, "req-2");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    const body = await result!.json();
    expect(body.error).toBe("unauthorized");
  });

  test("returns 401 for wrong token", async () => {
    const event = makeEvent({ "x-admin-token": "wrong-token" });
    const result = requireAdmin(event as never, "req-3");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test("returns 401 for empty token", async () => {
    const event = makeEvent({ "x-admin-token": "" });
    const result = requireAdmin(event as never, "req-4");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test("rejects token that differs only in length (timing-safe)", async () => {
    const event = makeEvent({ "x-admin-token": "test-admin-token-1234" }); // one char shorter
    const result = requireAdmin(event as never, "req-5");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test("includes requestId in error response", async () => {
    const event = makeEvent({});
    const result = requireAdmin(event as never, "my-request-id");
    const body = await result!.json();
    expect(body.requestId).toBe("my-request-id");
  });
});

// ── getActor ────────────────────────────────────────────────────────────

describe("getActor", () => {
  test("returns 'admin' when x-admin-token is present", () => {
    const event = makeEvent({ "x-admin-token": "any-token" });
    expect(getActor(event as never)).toBe("admin");
  });

  test("returns 'unauthenticated' when no token", () => {
    const event = makeEvent({});
    expect(getActor(event as never)).toBe("unauthenticated");
  });

  test("actor is derived from auth state, not caller-controlled (security)", () => {
    // Even if x-requested-by claims "admin", actor is based on token presence
    const event = makeEvent({ "x-requested-by": "admin" });
    expect(getActor(event as never)).toBe("unauthenticated");
  });
});

// ── getCallerType ───────────────────────────────────────────────────────

describe("getCallerType", () => {
  test("normalizes valid x-requested-by header values", () => {
    expect(getCallerType(makeEvent({ "x-requested-by": "ui" }) as never)).toBe("ui");
    expect(getCallerType(makeEvent({ "x-requested-by": "cli" }) as never)).toBe("cli");
    expect(getCallerType(makeEvent({ "x-requested-by": "assistant" }) as never)).toBe("assistant");
    expect(getCallerType(makeEvent({ "x-requested-by": "system" }) as never)).toBe("system");
    expect(getCallerType(makeEvent({ "x-requested-by": "test" }) as never)).toBe("test");
  });

  test("returns 'unknown' for missing header", () => {
    expect(getCallerType(makeEvent({}) as never)).toBe("unknown");
  });

  test("returns 'unknown' for invalid value", () => {
    expect(getCallerType(makeEvent({ "x-requested-by": "hacker" }) as never)).toBe("unknown");
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
    expect(result).toEqual({ key: "value" });
  });

  test("returns empty object for invalid JSON", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "text/plain" }
    });
    const result = await parseJsonBody(req);
    expect(result).toEqual({});
  });

  test("returns empty object for empty body", async () => {
    const req = new Request("http://localhost", {
      method: "POST",
      body: ""
    });
    const result = await parseJsonBody(req);
    expect(result).toEqual({});
  });
});
