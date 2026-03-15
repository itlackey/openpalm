/**
 * Guardian security contract tests.
 *
 * Spawns guardian as a subprocess with controlled env vars, a temp secrets file,
 * and a mock assistant HTTP server. Validates all security invariants.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { signPayload } from "@openpalm/channels-sdk/crypto";
import type { Subprocess } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Helpers ────────────────────────────────────────────────────────────

const TEST_SECRET = "test-secret-value-1234";
const TEST_CHANNEL = "test";

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user1",
    channel: TEST_CHANNEL,
    text: "hello",
    nonce: crypto.randomUUID(),
    timestamp: Date.now(),
    ...overrides,
  };
}

function signedRequest(
  guardianUrl: string,
  body: Record<string, unknown>,
  secret = TEST_SECRET,
  headers: Record<string, string> = {},
): Promise<Response> {
  const raw = JSON.stringify(body);
  const sig = signPayload(secret, raw);
  return fetch(`${guardianUrl}/channel/inbound`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-channel-signature": sig,
      ...headers,
    },
    body: raw,
  });
}

// ── Test setup ─────────────────────────────────────────────────────────

let guardianProc: Subprocess;
let mockAssistantServer: ReturnType<typeof Bun.serve>;
let guardianUrl: string;
let tmpDir: string;
let sessionCreateCount = 0;
let messageCount = 0;

function resetAssistantCounters(): void {
  sessionCreateCount = 0;
  messageCount = 0;
}

// Pick random ports to avoid conflicts
const guardianPort = 19000 + Math.floor(Math.random() * 1000);
const assistantPort = 19000 + Math.floor(Math.random() * 1000) + 1000;

beforeAll(async () => {
  // Create temp secrets file
  tmpDir = mkdtempSync(join(tmpdir(), "guardian-test-"));
  const secretsPath = join(tmpDir, "secrets.env");
  writeFileSync(secretsPath, `CHANNEL_TEST_SECRET=${TEST_SECRET}\n`);

  const auditPath = join(tmpDir, "audit.log");

  // Start mock assistant
  mockAssistantServer = Bun.serve({
    port: assistantPort,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/session" && req.method === "POST") {
        sessionCreateCount += 1;
        return new Response(JSON.stringify({ id: `mock-session-${sessionCreateCount}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message") && req.method === "POST") {
        messageCount += 1;
        const sessionId = url.pathname.split("/")[2] ?? "unknown-session";
        return new Response(
          JSON.stringify({
            parts: [{ type: "text", text: `mock answer from ${sessionId}` }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });

  // Spawn guardian process
  guardianProc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(guardianPort),
      GUARDIAN_SECRETS_PATH: secretsPath,
      OPENPALM_ASSISTANT_URL: `http://localhost:${assistantPort}`,
      GUARDIAN_AUDIT_PATH: auditPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  guardianUrl = `http://localhost:${guardianPort}`;

  // Wait for guardian to be ready
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`${guardianUrl}/health`);
      if (resp.ok) break;
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
});

afterAll(() => {
  guardianProc?.kill();
  mockAssistantServer?.stop();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("Guardian security contract", () => {
  it("GET /health → 200 { ok: true }", async () => {
    const resp = await fetch(`${guardianUrl}/health`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
    expect(data.service).toBe("guardian");
  });

  it("valid signed payload → 200 with answer", async () => {
    resetAssistantCounters();
    const payload = makePayload();
    const resp = await signedRequest(guardianUrl, payload);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.answer).toBe("mock answer from mock-session-1");
    expect(data.userId).toBe("user1");
    expect(typeof data.sessionId).toBe("string");
  });

  it("metadata.sessionKey reuses the same cached session across different userIds", async () => {
    resetAssistantCounters();

    const sessionKey = `thread-${crypto.randomUUID()}`;
    const firstResp = await signedRequest(guardianUrl, makePayload({
      userId: `user-a-${crypto.randomUUID()}`,
      metadata: { sessionKey },
    }));
    expect(firstResp.status).toBe(200);
    const firstData = await firstResp.json();

    const secondResp = await signedRequest(guardianUrl, makePayload({
      userId: `user-b-${crypto.randomUUID()}`,
      text: "follow-up",
      metadata: { sessionKey },
    }));
    expect(secondResp.status).toBe(200);
    const secondData = await secondResp.json();

    expect(firstData.sessionId).toBe("mock-session-1");
    expect(secondData.sessionId).toBe("mock-session-1");
    expect(secondData.answer).toBe("mock answer from mock-session-1");
    expect(sessionCreateCount).toBe(1);
    expect(messageCount).toBe(2);
  });

  it("metadata.clearSession clears the resolved cached session without calling assistant", async () => {
    resetAssistantCounters();

    const sessionKey = `clear-${crypto.randomUUID()}`;
    const initialResp = await signedRequest(guardianUrl, makePayload({
      userId: `user-clear-${crypto.randomUUID()}`,
      metadata: { sessionKey },
    }));
    expect(initialResp.status).toBe(200);
    const initialData = await initialResp.json();
    expect(initialData.sessionId).toBe("mock-session-1");
    expect(sessionCreateCount).toBe(1);
    expect(messageCount).toBe(1);

    const clearResp = await signedRequest(guardianUrl, makePayload({
      userId: `other-user-${crypto.randomUUID()}`,
      text: "clear session",
      metadata: { sessionKey, clearSession: true },
    }));
    expect(clearResp.status).toBe(200);
    const clearData = await clearResp.json();
    expect(clearData.cleared).toBe(true);
    expect(clearData.userId).toMatch(/^other-user-/);
    expect(sessionCreateCount).toBe(1);
    expect(messageCount).toBe(1);

    const afterClearResp = await signedRequest(guardianUrl, makePayload({
      userId: `third-user-${crypto.randomUUID()}`,
      text: "new session after clear",
      metadata: { sessionKey },
    }));
    expect(afterClearResp.status).toBe(200);
    const afterClearData = await afterClearResp.json();

    expect(afterClearData.sessionId).toBe("mock-session-2");
    expect(afterClearData.answer).toBe("mock answer from mock-session-2");
    expect(sessionCreateCount).toBe(2);
    expect(messageCount).toBe(2);
  });

  it("invalid signature → 403 invalid_signature", async () => {
    const payload = makePayload();
    const raw = JSON.stringify(payload);
    const resp = await fetch(`${guardianUrl}/channel/inbound`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": "deadbeef",
      },
      body: raw,
    });
    expect(resp.status).toBe(403);
    const data = await resp.json();
    expect(data.error).toBe("invalid_signature");
  });

  it("missing x-channel-signature header → 403", async () => {
    const payload = makePayload();
    const resp = await fetch(`${guardianUrl}/channel/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(resp.status).toBe(403);
    const data = await resp.json();
    expect(data.error).toBe("invalid_signature");
  });

  it("unknown channel name → 403 invalid_signature (no enumeration oracle)", async () => {
    const payload = makePayload({ channel: "nonexistent" });
    const resp = await signedRequest(guardianUrl, payload, "any-secret");
    expect(resp.status).toBe(403);
    const data = await resp.json();
    expect(data.error).toBe("invalid_signature");
  });

  it("replay (same nonce twice) → first 200, second 409", async () => {
    const nonce = crypto.randomUUID();
    const payload1 = makePayload({ nonce });
    const resp1 = await signedRequest(guardianUrl, payload1);
    expect(resp1.status).toBe(200);

    const payload2 = makePayload({ nonce });
    const resp2 = await signedRequest(guardianUrl, payload2);
    expect(resp2.status).toBe(409);
    const data = await resp2.json();
    expect(data.error).toBe("replay_detected");
  });

  it("expired timestamp (>5min old) → 409", async () => {
    const payload = makePayload({ timestamp: Date.now() - 6 * 60 * 1000 });
    const resp = await signedRequest(guardianUrl, payload);
    expect(resp.status).toBe(409);
    const data = await resp.json();
    expect(data.error).toBe("replay_detected");
  });

  it("rate limit exceeded (121 requests same userId) → 429", async () => {
    // Use a unique userId to avoid conflicts with other tests
    const userId = `ratelimit-${crypto.randomUUID()}`;
    let hitLimit = false;

    for (let i = 0; i < 121; i++) {
      const payload = makePayload({ userId });
      const resp = await signedRequest(guardianUrl, payload);
      if (resp.status === 429) {
        const data = await resp.json();
        expect(data.error).toBe("rate_limited");
        hitLimit = true;
        break;
      }
    }
    expect(hitLimit).toBe(true);
  });

  it("invalid JSON body → 400 invalid_json", async () => {
    const resp = await fetch(`${guardianUrl}/channel/inbound`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": "anything",
      },
      body: "not json{{{",
    });
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toBe("invalid_json");
  });

  it("missing required payload fields → 400 invalid_payload", async () => {
    const resp = await signedRequest(guardianUrl, { userId: "u1" });
    expect(resp.status).toBe(400);
    const data = await resp.json();
    expect(data.error).toBe("invalid_payload");
  });

  it("unknown route → 404", async () => {
    const resp = await fetch(`${guardianUrl}/unknown`);
    expect(resp.status).toBe(404);
    const data = await resp.json();
    expect(data.error).toBe("not_found");
  });

  it("mock assistant returns error → 502 assistant_unavailable", async () => {
    // Stop the mock assistant and wait for port to be released
    mockAssistantServer.stop(true);
    await Bun.sleep(100);

    try {
      const payload = makePayload();
      const resp = await signedRequest(guardianUrl, payload);
      expect(resp.status).toBe(502);
      const data = await resp.json();
      expect(data.error).toBe("assistant_unavailable");
    } finally {
      // Restart the mock assistant
      mockAssistantServer = Bun.serve({
        port: assistantPort,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/session" && req.method === "POST") {
            sessionCreateCount += 1;
            return new Response(JSON.stringify({ id: `mock-session-${sessionCreateCount}` }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message") && req.method === "POST") {
            messageCount += 1;
            const sessionId = url.pathname.split("/")[2] ?? "unknown-session";
            return new Response(
              JSON.stringify({
                parts: [{ type: "text", text: `mock answer from ${sessionId}` }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response("not found", { status: 404 });
        },
      });
    }
  });
});
