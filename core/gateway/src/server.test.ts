import { describe, expect, it, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { safeRequestId, validatePayload } from "./server-utils.ts";
import { createGatewayFetch, discoverChannelSecretsFromState, type GatewayDeps } from "./server.ts";
import { signPayload } from "@openpalm/lib/shared/crypto.ts";
import { AuditLog } from "./audit.ts";
import { OpenCodeClient } from "./assistant-client.ts";
import { NonceCache } from "./nonce-cache.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

  const invalidCases: [string, string | null][] = [
    [">64 chars", "a".repeat(65)],
    ["special characters", "req id!@#"],
    ["null", null],
    ["empty string", ""],
  ];

  for (const [label, input] of invalidCases) {
    it(`${label} → returns UUID`, () => {
      const result = safeRequestId(input);
      if (input) expect(result).not.toBe(input);
      expect(result).toMatch(/^[0-9a-f]{8}-/);
    });
  }
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

  it("non-empty arbitrary channel → true", () => {
    expect(validatePayload({ ...valid, channel: "smoke-signal" })).toBe(true);
  });

  const invalidCases: [string, Record<string, unknown>][] = [
    ["missing userId", { userId: undefined }],
    ["empty userId", { userId: "  " }],
    ["missing text", { text: undefined }],
    ["empty text", { text: "   " }],
    ["text >10000 chars", { text: "x".repeat(10_001) }],
    ["missing nonce", { nonce: undefined }],
    ["missing timestamp", { timestamp: undefined }],
    ["non-number timestamp", { timestamp: "not-a-number" }],
  ];

  for (const [label, overrides] of invalidCases) {
    it(`${label} → false`, () => {
      expect(validatePayload({ ...valid, ...overrides })).toBe(false);
    });
  }
});


describe("discoverChannelSecretsFromState", () => {
  it("loads shared secrets from /state/channel-*/.env files", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gw-state-"));
    try {
      mkdirSync(join(stateDir, "channel-community-slack"), { recursive: true });
      writeFileSync(
        join(stateDir, "channel-community-slack", ".env"),
        "CHANNEL_COMMUNITY_SLACK_SECRET=secret-123\nOTHER=value\n",
        "utf8",
      );

      const secrets = discoverChannelSecretsFromState(stateDir);
      expect(secrets["community-slack"]).toBe("secret-123");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("falls back to provided env when channel env file does not contain default key", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gw-state-"));
    try {
      mkdirSync(join(stateDir, "channel-custom"), { recursive: true });
      writeFileSync(join(stateDir, "channel-custom", ".env"), "FOO=bar\n", "utf8");

      const secrets = discoverChannelSecretsFromState(stateDir, {
        CHANNEL_CUSTOM_SECRET: "from-env",
      });
      expect(secrets.custom).toBe("from-env");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
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
  const nonceCache = new NonceCache();
  const deps: GatewayDeps = {
    channelSecrets: { chat: SECRET },
    openCode,
    audit,
    nonceCache,
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
    nonceCache.destroy();
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

  it("malformed JSON → 400 invalid_json", async () => {
    const req = new Request("http://gateway/channel/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": "anything",
      },
      body: "not-json{{{",
    });
    const resp = await gatewayFetch(req);
    expect(resp.status).toBe(400);
    const data = await resp.json() as Record<string, unknown>;
    expect(data.error).toBe("invalid_json");
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
