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
        return new Response(JSON.stringify({ id: "mock-session-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message") && req.method === "POST") {
        return new Response(
          JSON.stringify({
            parts: [{ type: "text", text: "mock answer" }],
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
    const payload = makePayload();
    const resp = await signedRequest(guardianUrl, payload);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.answer).toBe("mock answer");
    expect(data.userId).toBe("user1");
    expect(typeof data.sessionId).toBe("string");
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

  it("GET /stats → 200 with diagnostic state", async () => {
    const resp = await fetch(`${guardianUrl}/stats`);
    expect(resp.status).toBe(200);
    const data = await resp.json();

    // Verify top-level structure
    expect(typeof data.uptime_seconds).toBe("number");
    expect(data.uptime_seconds).toBeGreaterThanOrEqual(0);

    // Rate limits config + active counts
    expect(data.rate_limits.user_window_ms).toBe(60_000);
    expect(data.rate_limits.user_max_requests).toBe(120);
    expect(data.rate_limits.channel_window_ms).toBe(60_000);
    expect(data.rate_limits.channel_max_requests).toBe(200);
    expect(typeof data.rate_limits.active_user_limiters).toBe("number");
    expect(typeof data.rate_limits.active_channel_limiters).toBe("number");

    // Nonce cache
    expect(typeof data.nonce_cache.size).toBe("number");
    expect(data.nonce_cache.max_size).toBe(50_000);
    expect(data.nonce_cache.window_ms).toBe(300_000);

    // Sessions
    expect(typeof data.sessions.active).toBe("number");
    expect(data.sessions.max_size).toBe(10_000);
    expect(data.sessions.ttl_ms).toBe(15 * 60_000);

    // Request counters (previous tests will have generated some)
    expect(typeof data.requests.total).toBe("number");
    expect(data.requests.total).toBeGreaterThan(0);
    expect(typeof data.requests.by_status).toBe("object");
    expect(typeof data.requests.by_channel).toBe("object");
  });

  it("GET /stats with valid admin token → 200", async () => {
    // No OPENPALM_ADMIN_TOKEN is set in test env, so any request should succeed
    const resp = await fetch(`${guardianUrl}/stats`, {
      headers: { "x-admin-token": "any-value" },
    });
    expect(resp.status).toBe(200);
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
            return new Response(JSON.stringify({ id: "mock-session-1" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message") && req.method === "POST") {
            return new Response(
              JSON.stringify({
                parts: [{ type: "text", text: "mock answer" }],
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
