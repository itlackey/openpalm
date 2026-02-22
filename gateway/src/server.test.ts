import { describe, expect, it, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { safeRequestId, validatePayload } from "./server-utils.ts";
import { createGatewayFetch, type GatewayDeps } from "./server.ts";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { AuditLog } from "./audit.ts";
import { OpenCodeClient } from "./assistant-client.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── safeRequestId ──────────────────────────────────────────────────

describe("safeRequestId", () => {
  it("valid alphanumeric header → returns it", () => {
    expect(safeRequestId("abc123")).toBe("abc123");
  });

  it("dashes/underscores → returns it", () => {
    expect(safeRequestId("req-id_01")).toBe("req-id_01");
  });

  it(">64 chars → returns UUID", () => {
    const long = "a".repeat(65);
    const result = safeRequestId(long);
    expect(result).not.toBe(long);
    expect(result).toMatch(/^[0-9a-f]{8}-/);
  });

  it("special characters → returns UUID", () => {
    const result = safeRequestId("req id!@#");
    expect(result).toMatch(/^[0-9a-f]{8}-/);
  });

  it("null → returns UUID", () => {
    expect(safeRequestId(null)).toMatch(/^[0-9a-f]{8}-/);
  });

  it("empty string → returns UUID", () => {
    expect(safeRequestId("")).toMatch(/^[0-9a-f]{8}-/);
  });
});

// ── validatePayload ────────────────────────────────────────────────

describe("validatePayload", () => {
  const valid = {
    userId: "user1",
    channel: "chat",
    text: "hello",
    nonce: "nonce-1",
    timestamp: Date.now(),
  };

  it("valid complete payload → true", () => {
    expect(validatePayload(valid)).toBe(true);
  });

  it("missing userId → false", () => {
    expect(validatePayload({ ...valid, userId: undefined })).toBe(false);
  });

  it("empty userId → false", () => {
    expect(validatePayload({ ...valid, userId: "  " })).toBe(false);
  });

  it("unknown channel → false", () => {
    expect(validatePayload({ ...valid, channel: "smoke-signal" })).toBe(false);
  });

  it("missing text → false", () => {
    expect(validatePayload({ ...valid, text: undefined })).toBe(false);
  });

  it("empty text → false", () => {
    expect(validatePayload({ ...valid, text: "   " })).toBe(false);
  });

  it("text >10000 chars → false", () => {
    expect(validatePayload({ ...valid, text: "x".repeat(10_001) })).toBe(false);
  });

  it("missing nonce → false", () => {
    expect(validatePayload({ ...valid, nonce: undefined })).toBe(false);
  });

  it("missing timestamp → false", () => {
    expect(validatePayload({ ...valid, timestamp: undefined })).toBe(false);
  });

  it("non-number timestamp → false", () => {
    expect(validatePayload({ ...valid, timestamp: "not-a-number" as unknown as number })).toBe(false);
  });
});

// ── gateway HTTP pipeline ──────────────────────────────────────────

describe("gateway HTTP pipeline", () => {
  const SECRET = "test-secret-abc";
  const auditDir = mkdtempSync(join(tmpdir(), "gw-test-audit-"));
  const audit = new AuditLog(join(auditDir, "audit.log"));

  // Mock assistant server: responds to /chat with intake then core responses
  let callCount = 0;
  const mockAssistant = Bun.serve({
    port: 0,
    async fetch(req) {
      callCount++;
      if (callCount % 2 === 1) {
        // Intake call
        return new Response(JSON.stringify({
          response: JSON.stringify({ valid: true, summary: "test summary", reason: "" }),
          session_id: "s1",
        }));
      }
      // Core call
      return new Response(JSON.stringify({
        response: "core answer",
        session_id: "s1",
        metadata: {},
      }));
    },
  });

  const openCode = new OpenCodeClient(`http://localhost:${mockAssistant.port}`);
  const deps: GatewayDeps = {
    channelSecrets: { chat: SECRET, discord: SECRET },
    openCode,
    audit,
  };

  const gatewayFetch = createGatewayFetch(deps);

  // Helper to build a signed request
  function signedRequest(payload: Record<string, unknown>, secret = SECRET) {
    const body = JSON.stringify(payload);
    const sig = signPayload(secret, body);
    return new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": sig,
      },
      body,
    });
  }

  function freshPayload(overrides?: Record<string, unknown>) {
    return {
      userId: "u1",
      channel: "chat",
      text: "hello",
      nonce: randomUUID(),
      timestamp: Date.now(),
      metadata: {},
      ...overrides,
    };
  }

  afterAll(() => {
    mockAssistant.stop(true);
  });

  it("GET /health → 200 {ok:true, service:'gateway'}", async () => {
    const resp = await gatewayFetch(new Request("http://gateway/health", { method: "GET" }));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("gateway");
  });

  it("POST /channel/inbound valid HMAC + valid payload → 200 with answer", async () => {
    callCount = 0;
    const resp = await gatewayFetch(signedRequest(freshPayload()));
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.answer).toBe("core answer");
    expect(body.requestId).toBeDefined();
  });

  it("POST /channel/inbound missing signature → 403 invalid_signature", async () => {
    const req = new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(freshPayload()),
    });
    const resp = await gatewayFetch(req);
    expect(resp.status).toBe(403);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid_signature");
  });

  it("POST /channel/inbound wrong signature → 403 invalid_signature", async () => {
    const body = JSON.stringify(freshPayload());
    const req = new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": "deadbeef",
      },
      body,
    });
    const resp = await gatewayFetch(req);
    expect(resp.status).toBe(403);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.error).toBe("invalid_signature");
  });

  it("POST /channel/inbound unknown channel → 403 channel_not_configured", async () => {
    const payload = freshPayload({ channel: "smoke-signal" });
    const body = JSON.stringify(payload);
    const req = new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": signPayload("irrelevant", body),
      },
      body,
    });
    const resp = await gatewayFetch(req);
    expect(resp.status).toBe(403);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.error).toBe("channel_not_configured");
  });

  it("POST /channel/inbound empty channel → 403 channel_not_configured", async () => {
    const payload = freshPayload({ channel: "" });
    const body = JSON.stringify(payload);
    const req = new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": signPayload("irrelevant", body),
      },
      body,
    });
    const resp = await gatewayFetch(req);
    expect(resp.status).toBe(403);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.error).toBe("channel_not_configured");
  });

  it("POST /channel/inbound valid HMAC + invalid payload → 400 invalid_payload", async () => {
    const payload = freshPayload({ text: "" });
    const resp = await gatewayFetch(signedRequest(payload));
    expect(resp.status).toBe(400);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.error).toBe("invalid_payload");
  });

  it("unknown path → 404", async () => {
    const resp = await gatewayFetch(new Request("http://gateway/nope"));
    expect(resp.status).toBe(404);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.error).toBe("not_found");
  });

  it("malformed JSON → 500 internal_error", async () => {
    const req = new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": "anything",
      },
      body: "not-json{{{",
    });
    const resp = await gatewayFetch(req);
    expect(resp.status).toBe(500);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.error).toBe("internal_error");
  });

  it("x-request-id echoed when valid", async () => {
    callCount = 0;
    const payload = freshPayload();
    const body = JSON.stringify(payload);
    const sig = signPayload(SECRET, body);
    const req = new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": sig,
        "x-request-id": "my-valid-id",
      },
      body,
    });
    const resp = await gatewayFetch(req);
    expect(resp.status).toBe(200);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.requestId).toBe("my-valid-id");
  });

  it("x-request-id replaced when invalid", async () => {
    const payload = freshPayload();
    const body = JSON.stringify(payload);
    const sig = signPayload(SECRET, body);
    const req = new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": sig,
        "x-request-id": "bad id!@#",
      },
      body,
    });
    callCount = 0;
    const resp = await gatewayFetch(req);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.requestId).not.toBe("bad id!@#");
    expect(typeof data.requestId).toBe("string");
  });
});
