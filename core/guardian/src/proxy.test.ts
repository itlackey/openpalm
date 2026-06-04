/**
 * Guardian /oc/* proxy — Stage 1 integration tests (design §3.1, §3.3, §3.4, §7).
 *
 * Spawns the real guardian as a subprocess with a temp channel-secret file and a
 * mock OpenCode assistant. Signs each native call with signRequest (signed
 * userId). Asserts: allowlist default-deny + hardened matching, session-ownership
 * authz (A cannot touch B's session), POST /session create-body rewrite, and
 * GET /session response filtering. Mirrors server.test.ts harness conventions.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { signRequest } from "@openpalm/channels-sdk/crypto";
import type { Subprocess } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OC_DOC_FIXTURE } from "./oc-doc-fixture";

const TEST_SECRET = "test-secret-value-1234";
const TEST_CHANNEL = "test";

let guardianProc: Subprocess;
let mockAssistant: ReturnType<typeof Bun.serve>;
let guardianUrl: string;
let tmpDir: string;
let secretPath: string;
let guardianPort = 0;
let assistantPort = 0;

// Mock assistant state: created sessions with their (rewritten) titles.
let sessionSeq = 0;
const sessions = new Map<string, { title: string }>();
let lastCreateBody: unknown = null;
// Controllable SSE source for the /event integration test.
let eventFrames: string[] = [];
let eventStop = false;

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to resolve test port"));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Sign + send a native proxy call. Returns the Response. */
function ocCall(
  method: string,
  ocPath: string,
  opts: { userId?: string; channel?: string; body?: string; sessionKey?: string; headerOverrides?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> {
  const userId = opts.userId ?? "user-a";
  const channel = opts.channel ?? TEST_CHANNEL;
  const body = opts.body ?? "";
  const nonce = crypto.randomUUID();
  const timestamp = Date.now();
  const pathWithQuery = ocPath; // no query in these tests
  const sig = signRequest(TEST_SECRET, { method, pathWithQuery, body, nonce, timestamp, userId });

  const headers: Record<string, string> = {
    "x-channel-signature": sig,
    "x-channel-name": channel,
    "x-channel-user-id": userId,
    "x-channel-nonce": nonce,
    "x-channel-timestamp": String(timestamp),
  };
  if (opts.sessionKey) headers["x-channel-session-key"] = opts.sessionKey;
  if (body) headers["content-type"] = "application/json";
  Object.assign(headers, opts.headerOverrides ?? {});

  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") init.body = body;
  if (opts.signal) init.signal = opts.signal;
  return fetch(`${guardianUrl}/oc${ocPath}`, init);
}

beforeAll(async () => {
  assistantPort = await getAvailablePort();
  guardianPort = await getAvailablePort();

  tmpDir = mkdtempSync(join(tmpdir(), "guardian-proxy-test-"));
  secretPath = join(tmpDir, "test-secret");
  writeFileSync(secretPath, `${TEST_SECRET}\n`);
  const auditPath = join(tmpDir, "audit.log");

  mockAssistant = Bun.serve({
    port: assistantPort,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/doc" && req.method === "GET") {
        return Response.json(OC_DOC_FIXTURE);
      }
      if (url.pathname === "/event" && req.method === "GET") {
        // A controllable SSE source: continuously flushes any frames the test
        // queued in `eventFrames`, holding the connection open until the test
        // sets `eventStop`. Holding open (rather than auto-closing) avoids
        // triggering the guardian's upstream-reset broadcast mid-test.
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            const sent = new Set<string>();
            for (let i = 0; i < 600 && !eventStop && !req.signal.aborted; i++) {
              for (const f of eventFrames) {
                if (sent.has(f)) continue;
                sent.add(f);
                controller.enqueue(enc.encode(`data: ${f}\n\n`));
              }
              await Bun.sleep(10);
            }
            try { controller.close(); } catch { /* already closed */ }
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname === "/session" && req.method === "POST") {
        lastCreateBody = await req.json().catch(() => null);
        sessionSeq += 1;
        const id = `ses_${sessionSeq}`;
        const title = (lastCreateBody as { title?: unknown })?.title;
        sessions.set(id, { title: typeof title === "string" ? title : "" });
        return Response.json({ id });
      }
      if (url.pathname === "/session" && req.method === "GET") {
        return Response.json([...sessions.entries()].map(([id, s]) => ({ id, title: s.title })));
      }
      if (url.pathname.startsWith("/session/") && req.method === "GET") {
        const id = url.pathname.split("/")[2];
        return Response.json({ id, title: sessions.get(id)?.title ?? "" });
      }
      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message") && req.method === "POST") {
        const id = url.pathname.split("/")[2];
        return Response.json({ parts: [{ type: "text", text: `answer ${id}` }] });
      }
      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/abort") && req.method === "POST") {
        return new Response("true", { headers: { "content-type": "application/json" } });
      }
      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/prompt_async") && req.method === "POST") {
        // Non-blocking turn → 204 (matches OpenCode 1.15.13).
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith("/permission/") && url.pathname.endsWith("/reply") && req.method === "POST") {
        return new Response("true", { headers: { "content-type": "application/json" } });
      }
      if (url.pathname.startsWith("/question/") && (url.pathname.endsWith("/reply") || url.pathname.endsWith("/reject")) && req.method === "POST") {
        return new Response("true", { headers: { "content-type": "application/json" } });
      }
      if (url.pathname.startsWith("/session/") && req.method === "DELETE") {
        const id = url.pathname.split("/")[2];
        sessions.delete(id);
        return new Response("true", { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  });

  guardianProc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PORT: String(guardianPort),
      CHANNEL_TEST_SECRET_FILE: secretPath,
      OP_ASSISTANT_URL: `http://127.0.0.1:${assistantPort}`,
      GUARDIAN_AUDIT_PATH: auditPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  guardianUrl = `http://127.0.0.1:${guardianPort}`;
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (guardianProc.exitCode !== null) {
      throw new Error(`guardian exited before ready with code ${guardianProc.exitCode}`);
    }
    try {
      const resp = await fetch(`${guardianUrl}/health`);
      if (resp.ok) {
        ready = true;
        break;
      }
    } catch {
      // not ready
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error(`guardian did not become ready on ${guardianUrl}`);

  // The drift guard (§5, Stage 7) runs at boot and ENABLES the /oc/* proxy only
  // after the assistant /doc passes. Wait for it before exercising /oc/* routes.
  let proxyOn = false;
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${guardianUrl}/stats`);
    if (r.ok && (await r.json()).oc_proxy?.enabled === true) { proxyOn = true; break; }
    await Bun.sleep(100);
  }
  if (!proxyOn) throw new Error("guardian /oc proxy did not enable (drift guard)");
});

afterAll(() => {
  guardianProc?.kill();
  mockAssistant?.stop();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

/** Create a session for a principal; returns its sessionId. */
async function createSessionFor(userId: string, sessionKey?: string): Promise<string> {
  const resp = await ocCall("POST", "/session", { userId, body: JSON.stringify({ title: "CLIENT-CHOSEN" }), sessionKey });
  expect(resp.status).toBe(200);
  const data = await resp.json() as { id: string };
  return data.id;
}

describe("/oc proxy — authentication (§3.1)", () => {
  it("valid signed POST /session → 200 and records ownership", async () => {
    const resp = await ocCall("POST", "/session", { userId: "auth-ok", body: JSON.stringify({}) });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(typeof data.id).toBe("string");
  });

  it("bad signature → 403 invalid_signature", async () => {
    const resp = await ocCall("POST", "/session", {
      userId: "auth-bad",
      body: JSON.stringify({}),
      headerOverrides: { "x-channel-signature": "deadbeef" },
    });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("invalid_signature");
  });

  it("unknown channel → 403 invalid_signature (no enumeration oracle)", async () => {
    // Sign with the right secret but claim a channel that has no grant.
    const resp = await ocCall("GET", "/session", { userId: "u", channel: "nonexistent" });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("invalid_signature");
  });

  it("swapped userId (reusing another field's signed material) → 403", async () => {
    // Sign for userId=alice, then send the header as userId=mallory.
    const method = "GET";
    const ocPath = "/session";
    const nonce = crypto.randomUUID();
    const timestamp = Date.now();
    const sig = signRequest(TEST_SECRET, { method, pathWithQuery: ocPath, body: "", nonce, timestamp, userId: "alice" });
    const resp = await fetch(`${guardianUrl}/oc${ocPath}`, {
      method,
      headers: {
        "x-channel-signature": sig,
        "x-channel-name": TEST_CHANNEL,
        "x-channel-user-id": "mallory", // swapped
        "x-channel-nonce": nonce,
        "x-channel-timestamp": String(timestamp),
      },
    });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("invalid_signature");
  });

  it("missing signed headers → 403", async () => {
    const resp = await fetch(`${guardianUrl}/oc/session`, {
      method: "GET",
      headers: { "x-channel-signature": "x", "x-channel-name": TEST_CHANNEL },
    });
    expect(resp.status).toBe(403);
  });
});

describe("/oc proxy — endpoint allowlist deny-tests (§3.3)", () => {
  const denyVectors: Array<[string, string]> = [
    ["POST", "/session/ses_1/shell"],
    ["POST", "/session/ses_1/pty"],
    ["POST", "/session/ses_1/share"],
    ["POST", "/session/ses_1/fork"],
    ["POST", "/session/ses_1/command"],
    ["POST", "/session/ses_1/revert"],
    ["PATCH", "/session/ses_1/message/m_1/part/p_1"], // file-edit family
    ["GET", "/global/event"],
  ];
  for (const [method, path] of denyVectors) {
    it(`${method} ${path} → 403 forbidden_endpoint`, async () => {
      const resp = await ocCall(method, path, { userId: "deny-u", body: method === "GET" ? "" : "{}" });
      expect(resp.status).toBe(403);
      expect((await resp.json()).error).toBe("forbidden_endpoint");
    });
  }

  it("GET /session/{id} does NOT match /session/{id}/shell", async () => {
    // The shell path is denied even though /session/{id} is allowed — {id} has no slashes.
    const resp = await ocCall("GET", "/session/abc/shell", { userId: "deny-u" });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("forbidden_endpoint");
  });

  // NOTE: literal `..` and `%2e%2e` traversal are collapsed by the HTTP CLIENT
  // (fetch/WHATWG URL) before transmission — they arrive already-normalized, so
  // they cannot be exercised over the wire here. The allowlist's reject-on-
  // non-canonical defense for raw-byte clients is covered by the pure
  // oc-allowlist.test.ts unit tests. The wire-transmittable vector is %2f
  // (encoded slash), which fetch preserves verbatim:
  it("encoded-slash smuggling /session/abc%2fshell → 403 (cannot smuggle a sub-path)", async () => {
    const resp = await ocCall("GET", "/session/abc%2fshell", { userId: "deny-u" });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("forbidden_endpoint");
  });

  it("trailing slash /session/ → 403", async () => {
    const resp = await ocCall("GET", "/session/", { userId: "deny-u" });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("forbidden_endpoint");
  });
});

describe("/oc proxy — session-ownership authz (§3.4)", () => {
  it("create-body is REWRITTEN: client title discarded, guardian title used", async () => {
    await createSessionFor("owner-rewrite", "thread-xyz");
    const title = (lastCreateBody as { title?: string }).title;
    expect(title).toBe(`${TEST_CHANNEL}/thread-xyz`); // unified to the buffered `/` form
    expect(title).not.toBe("CLIENT-CHOSEN");
  });

  it("principal A cannot address principal B's session id (GET)", async () => {
    const idB = await createSessionFor("principal-B");
    const resp = await ocCall("GET", `/session/${idB}`, { userId: "principal-A" });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("forbidden_session");
  });

  it("principal A cannot message principal B's session", async () => {
    const idB = await createSessionFor("principal-B2");
    const resp = await ocCall("POST", `/session/${idB}/message`, {
      userId: "principal-A2",
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("forbidden_session");
  });

  it("principal A cannot abort principal B's session", async () => {
    const idB = await createSessionFor("principal-B3");
    const resp = await ocCall("POST", `/session/${idB}/abort`, { userId: "principal-A3", body: "{}" });
    expect(resp.status).toBe(403);
  });

  it("principal A cannot delete principal B's session", async () => {
    const idB = await createSessionFor("principal-B4");
    const resp = await ocCall("DELETE", `/session/${idB}`, { userId: "principal-A4" });
    expect(resp.status).toBe(403);
  });

  it("owner CAN address its own session (GET/message/abort/delete)", async () => {
    const id = await createSessionFor("self-owner");
    expect((await ocCall("GET", `/session/${id}`, { userId: "self-owner" })).status).toBe(200);
    const msg = await ocCall("POST", `/session/${id}/message`, {
      userId: "self-owner",
      body: JSON.stringify({ parts: [{ type: "text", text: "hi" }] }),
    });
    expect(msg.status).toBe(200);
    expect((await ocCall("POST", `/session/${id}/abort`, { userId: "self-owner", body: "{}" })).status).toBe(200);
    const del = await ocCall("DELETE", `/session/${id}`, { userId: "self-owner" });
    expect(del.status).toBe(200);
    // After delete, ownership is forgotten → a subsequent owner call 403s.
    const again = await ocCall("GET", `/session/${id}`, { userId: "self-owner" });
    expect(again.status).toBe(403);
  });

  it("GET /session is filtered to the principal's own sessions", async () => {
    const mine = await createSessionFor("list-owner", "list-thread");
    await createSessionFor("other-list-owner", "other-thread");
    const resp = await ocCall("GET", "/session", { userId: "list-owner" });
    expect(resp.status).toBe(200);
    const list = await resp.json() as Array<{ id: string }>;
    const ids = list.map((s) => s.id);
    expect(ids).toContain(mine);
    // None of the other principal's sessions appear.
    for (const s of list) {
      expect(s.id).toBe(mine);
    }
  });
});

describe("/oc proxy — permission reply fail-closed (§3.4)", () => {
  it("reply to an unrelayed requestID → 403 forbidden_permission (Stage 2 seam)", async () => {
    const resp = await ocCall("POST", "/permission/per_unknown/reply", {
      userId: "perm-u",
      body: JSON.stringify({ reply: "once" }),
    });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("forbidden_permission");
  });

  it("permission-reply ownership: A can answer the requestID relayed to A; B cannot (§3.4)", async () => {
    // A and B each own a session; the assistant emits a permission.asked frame
    // for A's session, so the guardian records requestID→A at relay time.
    const idA = await createSessionFor("perm-alice");
    const idB = await createSessionFor("perm-bob");
    const requestID = "per_alice_req";
    const askedFrame = JSON.stringify({
      type: "permission.asked",
      properties: { id: requestID, sessionID: idA, permission: "bash" },
    });
    eventStop = false;
    eventFrames = [askedFrame];

    // A opens its filtered /event stream → guardian relays the permission.asked
    // (owned by A) and records requestID→A. Read enough to ensure relay happened.
    const acA = new AbortController();
    const respA = await ocCall("GET", "/event", { userId: "perm-alice", signal: acA.signal });
    expect(respA.status).toBe(200);
    const seenA = await readStreamFor(respA, 700);
    expect(seenA).toContain(requestID);
    acA.abort();
    await respA.body?.cancel().catch(() => {});

    // B (a DIFFERENT principal) cannot answer A's requestID.
    const replyB = await ocCall("POST", `/permission/${requestID}/reply`, {
      userId: "perm-bob",
      body: JSON.stringify({ reply: "once" }),
    });
    expect(replyB.status).toBe(403);
    expect((await replyB.json()).error).toBe("forbidden_permission");

    // A — to whom the request was relayed — CAN answer it (forwarded → 200).
    const replyA = await ocCall("POST", `/permission/${requestID}/reply`, {
      userId: "perm-alice",
      body: JSON.stringify({ reply: "once" }),
    });
    expect(replyA.status).toBe(200);

    eventStop = true;
    eventFrames = [];
    void idB; // (B's session id is only needed to make B a real owning principal)
  });

  it("question-reply ownership: A can answer a relayed que_ id; B cannot (§ question tool)", async () => {
    const idA = await createSessionFor("q-alice");
    const requestID = "que_alice_req";
    const askedFrame = JSON.stringify({
      type: "question.asked",
      properties: { id: requestID, sessionID: idA, questions: [{ question: "Pick", header: "h", options: [{ label: "x", description: "" }] }] },
    });
    eventStop = false;
    eventFrames = [askedFrame];
    const acA = new AbortController();
    const respA = await ocCall("GET", "/event", { userId: "q-alice", signal: acA.signal });
    const seenA = await readStreamFor(respA, 700);
    expect(seenA).toContain(requestID);
    acA.abort();
    await respA.body?.cancel().catch(() => {});

    // B cannot answer A's question; A can.
    const replyB = await ocCall("POST", `/question/${requestID}/reply`, { userId: "q-bob", body: JSON.stringify({ answers: [["x"]] }) });
    expect(replyB.status).toBe(403);
    expect((await replyB.json()).error).toBe("forbidden_question");
    const replyA = await ocCall("POST", `/question/${requestID}/reply`, { userId: "q-alice", body: JSON.stringify({ answers: [["x"]] }) });
    expect(replyA.status).toBe(200);

    eventStop = true;
    eventFrames = [];
  });
});

describe("/oc proxy — session reuse is idempotent per (channel, sessionKey) (root-cause fix)", () => {
  it("two POST /session for the same sessionKey return the SAME id (one upstream create)", async () => {
    const before = sessionSeq;
    const id1 = await createSessionFor("reuse-u", "thread-reuse-1");
    const created = sessionSeq - before; // upstream creates that happened
    const id2 = await createSessionFor("reuse-u", "thread-reuse-1");
    expect(id1).toBe(id2);                 // same session reused
    expect(created).toBe(1);               // first call created
    expect(sessionSeq - before).toBe(1);   // second call did NOT create another
  });
});

describe("/oc proxy — resource bounds (§3.6)", () => {
  it("concurrent /event streams capped at 1 per principal → second open 429", async () => {
    eventStop = false;
    eventFrames = [];
    const ac1 = new AbortController();
    const resp1 = await ocCall("GET", "/event", { userId: "bound-stream-u", signal: ac1.signal });
    expect(resp1.status).toBe(200);

    // A SECOND concurrent open by the same principal is rejected.
    const ac2 = new AbortController();
    const resp2 = await ocCall("GET", "/event", { userId: "bound-stream-u", signal: ac2.signal });
    expect(resp2.status).toBe(429);
    expect((await resp2.json()).error).toBe("too_many_event_streams");
    ac2.abort();

    // Closing the first frees the slot → a fresh open succeeds again.
    ac1.abort();
    await resp1.body?.cancel().catch(() => {});
    await Bun.sleep(50);
    const ac3 = new AbortController();
    const resp3 = await ocCall("GET", "/event", { userId: "bound-stream-u", signal: ac3.signal });
    expect(resp3.status).toBe(200);
    ac3.abort();
    await resp3.body?.cancel().catch(() => {});
  });

  it("in-flight turns capped per principal → overflow 429 too_many_inflight_turns", async () => {
    // Use prompt_async (mock returns 204 immediately) but stack concurrent turns
    // by firing the cap+1 in parallel so they overlap in flight. The mock's 204
    // is near-instant, so to reliably observe the cap we fire many in parallel
    // and assert AT LEAST one is rejected with the bound's error.
    const id = await createSessionFor("inflight-u");
    const body = JSON.stringify({ messageID: "^msg1", parts: [{ type: "text", text: "hi" }] });
    const N = 12; // well above OC_MAX_INFLIGHT_TURNS (4)
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        ocCall("POST", `/session/${id}/prompt_async`, { userId: "inflight-u", body }),
      ),
    );
    const statuses = results.map((r) => r.status);
    const rejected = results.filter((r) => r.status === 429);
    // At least one overflow turn must be rejected by the in-flight cap.
    expect(rejected.length).toBeGreaterThan(0);
    const rejectedBody = await rejected[0].json();
    expect(rejectedBody.error).toBe("too_many_inflight_turns");
    // And at least the cap's worth succeeded (204 forwarded as 204).
    expect(statuses.filter((s) => s === 204).length).toBeGreaterThan(0);
  });
});

describe("/oc proxy — /event filtered stream (§3.2)", () => {
  it("GET /event → 200 text/event-stream (filtered fan-out, not a transparent passthrough)", async () => {
    eventStop = false;
    eventFrames = [];
    const ac = new AbortController();
    const resp = await ocCall("GET", "/event", { userId: "event-u", signal: ac.signal });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("text/event-stream");
    // Abort the client request → guardian's req.signal fires → drops subscriber,
    // aborts the single upstream subscription.
    ac.abort();
    eventStop = true;
  });

  it("TWO-PRINCIPAL cross-leak: each principal sees only its own session's frames; no-sessionID dropped", async () => {
    // Create one session per principal through the proxy → records ownership.
    const idA = await createSessionFor("evt-alice");
    const idB = await createSessionFor("evt-bob");

    // Queue: a frame for A, a frame for B, and a GLOBAL no-sessionID frame.
    const frameA = JSON.stringify({ type: "message.part.delta", properties: { sessionID: idA, delta: "for-A" } });
    const frameB = JSON.stringify({ type: "message.part.delta", properties: { sessionID: idB, delta: "for-B" } });
    const globalFrame = JSON.stringify({ type: "server.heartbeat", properties: {} });
    eventStop = false;
    eventFrames = [frameA, globalFrame, frameB];

    // Open both filtered streams. The guardian holds ONE upstream subscription.
    const acA = new AbortController();
    const acB = new AbortController();
    const [respA, respB] = await Promise.all([
      ocCall("GET", "/event", { userId: "evt-alice", signal: acA.signal }),
      ocCall("GET", "/event", { userId: "evt-bob", signal: acB.signal }),
    ]);
    expect(respA.status).toBe(200);
    expect(respB.status).toBe(200);

    const seenA = await readStreamFor(respA, 700);
    const seenB = await readStreamFor(respB, 700);
    acA.abort();
    acB.abort();

    // A sees ONLY its own frame; never B's, never the global one.
    expect(seenA).toContain("for-A");
    expect(seenA).not.toContain("for-B");
    expect(seenA).not.toContain("server.heartbeat");
    // B sees ONLY its own frame.
    expect(seenB).toContain("for-B");
    expect(seenB).not.toContain("for-A");
    expect(seenB).not.toContain("server.heartbeat");

    eventStop = true;
    await respA.body?.cancel().catch(() => {});
    await respB.body?.cancel().catch(() => {});
    eventFrames = [];
  });
});

/** Read an SSE response for up to `ms`, returning the concatenated text. */
async function readStreamFor(resp: Response, ms: number): Promise<string> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => "timeout" as const),
    ]);
    if (result === "timeout") break;
    if (result.done) break;
    out += decoder.decode(result.value, { stream: true });
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  return out;
}
