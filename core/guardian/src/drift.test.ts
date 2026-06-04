/**
 * Guardian fail-closed drift guard — unit + integration tests (design §5, Stage 7).
 *
 * Unit (pure assertDocCompatible):
 *   - the good fixture passes;
 *   - a /doc missing an allowlisted path fails;
 *   - a /doc missing an allowlisted method fails;
 *   - a /doc missing `sessionID` / `parts` / `text` fails;
 *   - a non-object / paths-less /doc fails.
 *
 * Integration (real guardian subprocess + mock assistant whose /doc has DRIFTED):
 *   - the /oc/* proxy route is DISABLED → 503;
 *   - the legacy buffered /channel/inbound path STAYS UP → 200.
 *
 * This proves the guard is FAIL-CLOSED for the proxy only, not warning-only.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { signPayload } from "@openpalm/channels-sdk/crypto";
import type { Subprocess } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertDocCompatible } from "./drift";
import { OC_DOC_FIXTURE } from "./oc-doc-fixture";

// ── Unit: pure assertion ───────────────────────────────────────────────────

/** Deep clone the frozen fixture so a test can mutate it freely. */
function cloneDoc(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(OC_DOC_FIXTURE));
}

describe("assertDocCompatible (pure, §5)", () => {
  it("the good fixture passes", () => {
    const result = assertDocCompatible(cloneDoc());
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("a /doc missing an allowlisted path FAILS (drift)", () => {
    const doc = cloneDoc();
    delete (doc.paths as Record<string, unknown>)["/event"];
    const result = assertDocCompatible(doc);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("/event"))).toBe(true);
  });

  it("a /doc missing an allowlisted METHOD on an existing path FAILS", () => {
    const doc = cloneDoc();
    // /session exists but drop its POST → POST /session is now unsupported.
    delete (doc.paths as Record<string, Record<string, unknown>>)["/session"].post;
    const result = assertDocCompatible(doc);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("POST /session"))).toBe(true);
  });

  it("a /doc with no `sessionID` property FAILS (§3.2 coupling)", () => {
    const doc = cloneDoc();
    // Remove the event schema that carries sessionID.
    delete (doc.components as Record<string, Record<string, unknown>>).schemas.Event;
    const result = assertDocCompatible(doc);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("sessionID"))).toBe(true);
  });

  it("a /doc with no `parts`/`text` property FAILS (§3.5 coupling)", () => {
    const doc = cloneDoc();
    // Strip the message request-body schema that defines parts/text.
    delete (doc.paths as Record<string, Record<string, Record<string, unknown>>>)["/session/{id}/message"].post.requestBody;
    const result = assertDocCompatible(doc);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("parts"))).toBe(true);
    expect(result.failures.some((f) => f.includes("text"))).toBe(true);
  });

  it("a non-object doc / missing paths FAILS", () => {
    expect(assertDocCompatible(null).ok).toBe(false);
    expect(assertDocCompatible({}).ok).toBe(false);
    expect(assertDocCompatible({ paths: "nope" }).ok).toBe(false);
  });

  it("structural path match tolerates a different param NAME in /doc", () => {
    const doc = cloneDoc();
    const paths = doc.paths as Record<string, unknown>;
    // Rename the param in the doc path; structural match must still accept it.
    paths["/session/{sessionId}"] = paths["/session/{id}"];
    delete paths["/session/{id}"];
    const result = assertDocCompatible(doc);
    expect(result.ok).toBe(true);
  });
});

// ── Integration: drifted /doc disables the proxy but not the buffered path ──

const TEST_SECRET = "drift-secret-value-9876";
const TEST_CHANNEL = "test";

let guardianProc: Subprocess;
let mockAssistant: ReturnType<typeof Bun.serve>;
let guardianUrl: string;
let tmpDir: string;

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = addr;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

beforeAll(async () => {
  const assistantPort = await getAvailablePort();
  const guardianPort = await getAvailablePort();

  tmpDir = mkdtempSync(join(tmpdir(), "guardian-drift-"));
  const secretPath = join(tmpDir, "secret");
  writeFileSync(secretPath, `${TEST_SECRET}\n`);

  // A DRIFTED /doc: drop an allowlisted path (/event) so assertDocCompatible
  // fails → the boot-time guard disables the proxy. The buffered path (/session
  // POST + /message) is still served so /channel/inbound keeps working.
  const driftedDoc = JSON.parse(JSON.stringify(OC_DOC_FIXTURE));
  delete driftedDoc.paths["/event"];

  let sessionSeq = 0;
  mockAssistant = Bun.serve({
    port: assistantPort,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/doc" && req.method === "GET") {
        return Response.json(driftedDoc);
      }
      if (url.pathname === "/session" && req.method === "POST") {
        await req.json().catch(() => null);
        sessionSeq += 1;
        return Response.json({ id: `ses_${sessionSeq}` });
      }
      if (url.pathname === "/session" && req.method === "GET") {
        return Response.json([]);
      }
      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message") && req.method === "POST") {
        const id = url.pathname.split("/")[2];
        return Response.json({ parts: [{ type: "text", text: `answer ${id}` }] });
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
      GUARDIAN_AUDIT_PATH: join(tmpDir, "audit.log"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  guardianUrl = `http://127.0.0.1:${guardianPort}`;
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (guardianProc.exitCode !== null) throw new Error(`guardian exited: ${guardianProc.exitCode}`);
    try {
      const r = await fetch(`${guardianUrl}/health`);
      if (r.ok) { ready = true; break; }
    } catch { /* not ready */ }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("guardian not ready");

  // Wait for the boot drift check to RESOLVE to disabled (it ran the /doc fetch).
  let settled = false;
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${guardianUrl}/stats`);
    if (r.ok) {
      const data = await r.json();
      // The check has run once the /doc fetch completed; enabled must be false.
      if (data.oc_proxy?.enabled === false) { settled = true; break; }
    }
    await Bun.sleep(100);
  }
  if (!settled) throw new Error("drift check did not settle to disabled");
});

afterAll(() => {
  guardianProc?.kill();
  mockAssistant?.stop();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("drift guard — proxy fail-closed, buffered path up (§5, Stage 7)", () => {
  it("/stats reports oc_proxy.enabled === false on drift", async () => {
    const resp = await fetch(`${guardianUrl}/stats`);
    expect(resp.status).toBe(200);
    expect((await resp.json()).oc_proxy.enabled).toBe(false);
  });

  it("a signed /oc/* call is rejected 503 oc_proxy_disabled", async () => {
    // A fully valid signed call (using legacy whole-body signing is enough — the
    // route returns 503 BEFORE any signature work because the proxy is disabled).
    const resp = await fetch(`${guardianUrl}/oc/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-name": TEST_CHANNEL,
        "x-channel-user-id": "drift-u",
        "x-channel-nonce": crypto.randomUUID(),
        "x-channel-timestamp": String(Date.now()),
        "x-channel-signature": "anything",
      },
      body: "{}",
    });
    expect(resp.status).toBe(503);
    expect((await resp.json()).error).toBe("oc_proxy_disabled");
  });

  it("the legacy buffered /channel/inbound path STILL works (200)", async () => {
    const body = {
      userId: "buffered-u",
      channel: TEST_CHANNEL,
      text: "hello despite drift",
      nonce: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    const raw = JSON.stringify(body);
    const resp = await fetch(`${guardianUrl}/channel/inbound`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-channel-signature": signPayload(TEST_SECRET, raw),
      },
      body: raw,
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(typeof data.answer).toBe("string");
    expect(data.userId).toBe("buffered-u");
  });
});
