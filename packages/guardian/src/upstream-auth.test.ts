/**
 * #563 D2 — guardian upstream Basic auth to the assistant.
 *
 * Red reason: `resolveAssistantUpstreamAuth` / `withAssistantUpstreamAuth` do
 * not exist yet in `./config.ts` — this import fails, so EVERY test below
 * (pure and subprocess) fails at collection.
 *
 * Pure half mirrors the `parseDirectTlsEnv` fail-closed idiom (no subprocess).
 * Subprocess half mirrors `proxy.test.ts`'s spawn harness: temp secret files,
 * a mock assistant (`Bun.serve`), `waitForGuardianReady`.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OC_DOC_FIXTURE } from "./oc-doc-fixture";
import { resolveAssistantUpstreamAuth, withAssistantUpstreamAuth } from "./config.ts";

// ── Pure half (T38-T41): no subprocess, no disk — an injected readFileFn ────

describe("resolveAssistantUpstreamAuth (pure, fail-closed boot contract)", () => {
  it("T38: disabled/unset OPENCODE_AUTH yields null even when a password file is set", () => {
    expect(
      resolveAssistantUpstreamAuth(
        { OPENCODE_SERVER_PASSWORD_FILE: "/fake/opencode_server_password" },
        () => "s3cret\n",
      ),
    ).toBeNull();
    expect(
      resolveAssistantUpstreamAuth(
        { OPENCODE_AUTH: "false", OPENCODE_SERVER_PASSWORD_FILE: "/fake/opencode_server_password" },
        () => "s3cret\n",
      ),
    ).toBeNull();
  });

  it("T39: enabled auth reads the file, strips the trailing newline, and builds Basic opencode:<pw>", () => {
    const expected = `Basic ${Buffer.from("opencode:s3cret", "utf-8").toString("base64")}`;
    for (const truthy of ["true", "1", "yes", "TRUE", "Yes"]) {
      const result = resolveAssistantUpstreamAuth(
        { OPENCODE_AUTH: truthy, OPENCODE_SERVER_PASSWORD_FILE: "/fake/opencode_server_password" },
        () => "s3cret\n",
      );
      expect(result, `truthy value ${truthy} must enable upstream auth`).not.toBeNull();
      expect(result?.authorization).toBe(expected);
    }
  });

  it("T39b (PR #564 r3566888272): preserves surrounding spaces in the password to match the assistant entrypoint", () => {
    // The assistant entrypoint reads the same secret with $(cat ...), which
    // strips only trailing newlines — surrounding spaces are preserved. The
    // guardian must send the identical bytes or every upstream call 401s.
    const expected = `Basic ${Buffer.from("opencode:lanpass1 ", "utf-8").toString("base64")}`;
    const result = resolveAssistantUpstreamAuth(
      { OPENCODE_AUTH: "true", OPENCODE_SERVER_PASSWORD_FILE: "/fake/opencode_server_password" },
      () => "lanpass1 \n",
    );
    expect(result?.authorization).toBe(expected);
  });

  it("T39c (PR #564 r3566889740): honors OPENCODE_SERVER_USERNAME instead of hardcoding 'opencode'", () => {
    const expected = `Basic ${Buffer.from("alice:s3cret", "utf-8").toString("base64")}`;
    const result = resolveAssistantUpstreamAuth(
      {
        OPENCODE_AUTH: "true",
        OPENCODE_SERVER_USERNAME: "alice",
        OPENCODE_SERVER_PASSWORD_FILE: "/fake/opencode_server_password",
      },
      () => "s3cret\n",
    );
    expect(result?.authorization).toBe(expected);
  });

  it("T40: enabled auth with a missing password-file var throws naming both env vars", () => {
    expect(() => resolveAssistantUpstreamAuth({ OPENCODE_AUTH: "true" }, () => "s3cret\n")).toThrow(
      /OPENCODE_AUTH/,
    );
    expect(() => resolveAssistantUpstreamAuth({ OPENCODE_AUTH: "true" }, () => "s3cret\n")).toThrow(
      /OPENCODE_SERVER_PASSWORD_FILE/,
    );
  });

  it("T40: enabled auth with an unreadable file throws", () => {
    const throwingReadFn = () => {
      throw new Error("ENOENT: no such file or directory");
    };
    expect(() =>
      resolveAssistantUpstreamAuth(
        { OPENCODE_AUTH: "true", OPENCODE_SERVER_PASSWORD_FILE: "/fake/opencode_server_password" },
        throwingReadFn,
      ),
    ).toThrow();
  });

  it("T40: enabled auth with an empty (whitespace-only) file throws", () => {
    expect(() =>
      resolveAssistantUpstreamAuth(
        { OPENCODE_AUTH: "true", OPENCODE_SERVER_PASSWORD_FILE: "/fake/opencode_server_password" },
        () => "   \n",
      ),
    ).toThrow();
  });

  it("T41: withAssistantUpstreamAuth sets the authorization header only when configured (default-posture branch; the positive/configured branch is proven end-to-end by T42's subprocess harness, since ASSISTANT_UPSTREAM_AUTH is resolved once from the real process env at module load)", () => {
    const headers = new Headers();
    const result = withAssistantUpstreamAuth(headers);
    expect(result).toBe(headers); // same Headers instance, mutated in place
    expect(result.has("authorization")).toBe(false);
  });
});

// ── Subprocess half (T42-T43): mirror proxy.test.ts's spawn harness ────────

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

const TEST_SECRET = "test-secret-value-1234";
const TEST_PORTAL = "test";
const UPSTREAM_PASSWORD = "assistant-upstream-pw-9999";
const EXPECTED_UPSTREAM_AUTH = `Basic ${Buffer.from(`opencode:${UPSTREAM_PASSWORD}`, "utf-8").toString("base64")}`;

async function waitForGuardianReady(guardianUrl: string, guardianProc: Subprocess, adminToken: string): Promise<void> {
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
}

function ocCall(
  guardianUrl: string,
  method: string,
  ocPath: string,
  opts: { userId?: string; body?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const userId = opts.userId ?? "user-a";
  const body = opts.body ?? "";
  const headers = new Headers({
    authorization: `Basic ${Buffer.from(`${TEST_PORTAL}:${TEST_SECRET}`, "utf-8").toString("base64")}`,
    "x-openpalm-user": userId,
  });
  if (body) headers.set("content-type", "application/json");
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") init.body = body;
  if (opts.signal) init.signal = opts.signal;
  return fetch(`${guardianUrl}/oc${ocPath}`, init);
}

describe("guardian upstream auth (subprocess, T42) — authenticates every upstream surface when assistant auth is on", () => {
  let guardianProc: Subprocess;
  let mockAssistant: ReturnType<typeof Bun.serve>;
  let guardianUrl: string;
  let tmpDir: string;
  let adminToken: string;
  const authByPath: Record<string, string | null> = {};

  beforeAll(async () => {
    const assistantPort = await getAvailablePort();
    const guardianPort = await getAvailablePort();
    const directPort = await getAvailablePort();
    const adminPort = await getAvailablePort();
    adminToken = "admin-token-upstream-auth-test";

    tmpDir = mkdtempSync(join(tmpdir(), "guardian-upstream-auth-test-"));
    const secretPath = join(tmpDir, "test-secret");
    writeFileSync(secretPath, `${TEST_SECRET}\n`);
    const adminTokenPath = join(tmpDir, "admin-token");
    writeFileSync(adminTokenPath, `${adminToken}\n`);
    const upstreamPasswordPath = join(tmpDir, "opencode_server_password");
    writeFileSync(upstreamPasswordPath, `${UPSTREAM_PASSWORD}\n`);

    mockAssistant = Bun.serve({
      port: assistantPort,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const auth = req.headers.get("authorization");
        authByPath[url.pathname] = auth;
        if (auth !== EXPECTED_UPSTREAM_AUTH) {
          return new Response("unauthorized", { status: 401 });
        }
        if (url.pathname === "/doc" && req.method === "GET") {
          return Response.json(OC_DOC_FIXTURE);
        }
        if (url.pathname === "/event" && req.method === "GET") {
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const enc = new TextEncoder();
              while (!req.signal.aborted) {
                try {
                  controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "server.connected" })}\n\n`));
                } catch {
                  return;
                }
                await Bun.sleep(20);
              }
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
        }
        if (url.pathname === "/session" && req.method === "POST") {
          return Response.json({ id: "ses_upstream_auth_1" });
        }
        return new Response("not found", { status: 404 });
      },
    });

    guardianProc = Bun.spawn(["bun", "run", "src/server.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PORT: String(guardianPort),
        GUARDIAN_DIRECT_PORT: String(directPort),
        GUARDIAN_ADMIN_PORT: String(adminPort),
        GUARDIAN_STATE_DB_PATH: join(tmpDir, "state.db"),
        GUARDIAN_ADMIN_TOKEN_FILE: adminTokenPath,
        PORTAL_TEST_SECRET_FILE: secretPath,
        OP_ASSISTANT_URL: `http://127.0.0.1:${assistantPort}`,
        GUARDIAN_AUDIT_PATH: join(tmpDir, "audit.log"),
        OPENCODE_AUTH: "true",
        OPENCODE_SERVER_PASSWORD_FILE: upstreamPasswordPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    guardianUrl = `http://127.0.0.1:${guardianPort}`;
    await waitForGuardianReady(guardianUrl, guardianProc, adminToken);
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

  it("T42: a proxied POST /oc/session succeeds (proves the proxy path attaches upstream auth)", async () => {
    const resp = await ocCall(guardianUrl, "POST", "/session", { body: JSON.stringify({ title: "auth-test" }) });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { id: string };
    expect(data.id).toBe("ses_upstream_auth_1");
    expect(authByPath["/session"]).toBe(EXPECTED_UPSTREAM_AUTH);
  });

  it("T42: opening /oc/event records auth on the upstream /event subscription", async () => {
    const ac = new AbortController();
    const resp = await ocCall(guardianUrl, "GET", "/event", { signal: ac.signal });
    expect(resp.status).toBe(200);
    // Read a little of the stream so the upstream subscription is actually
    // established before asserting on the recorded auth header.
    const reader = resp.body?.getReader();
    await Promise.race([reader?.read(), Bun.sleep(500)]);
    ac.abort();
    await resp.body?.cancel().catch(() => {});
    expect(authByPath["/event"]).toBe(EXPECTED_UPSTREAM_AUTH);
  });
});

describe("guardian upstream auth (subprocess, T43, pin) — no upstream authorization when auth is not configured", () => {
  let guardianProc: Subprocess;
  let mockAssistant: ReturnType<typeof Bun.serve>;
  let guardianUrl: string;
  let tmpDir: string;
  let adminToken: string;
  let recordedAuth: string | null | undefined;

  beforeAll(async () => {
    const assistantPort = await getAvailablePort();
    const guardianPort = await getAvailablePort();
    const directPort = await getAvailablePort();
    const adminPort = await getAvailablePort();
    adminToken = "admin-token-no-auth-test";

    tmpDir = mkdtempSync(join(tmpdir(), "guardian-no-upstream-auth-test-"));
    const secretPath = join(tmpDir, "test-secret");
    writeFileSync(secretPath, `${TEST_SECRET}\n`);
    const adminTokenPath = join(tmpDir, "admin-token");
    writeFileSync(adminTokenPath, `${adminToken}\n`);

    mockAssistant = Bun.serve({
      port: assistantPort,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/doc" && req.method === "GET") {
          return Response.json(OC_DOC_FIXTURE);
        }
        if (url.pathname === "/session" && req.method === "POST") {
          recordedAuth = req.headers.get("authorization");
          return Response.json({ id: "ses_no_auth_1" });
        }
        return new Response("not found", { status: 404 });
      },
    });

    // No OPENCODE_AUTH / OPENCODE_SERVER_PASSWORD_FILE in this spawn's env —
    // the default posture (D2: gating on OPENCODE_AUTH keeps behavior
    // byte-identical when it is unset/false).
    guardianProc = Bun.spawn(["bun", "run", "src/server.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PORT: String(guardianPort),
        GUARDIAN_DIRECT_PORT: String(directPort),
        GUARDIAN_ADMIN_PORT: String(adminPort),
        GUARDIAN_STATE_DB_PATH: join(tmpDir, "state.db"),
        GUARDIAN_ADMIN_TOKEN_FILE: adminTokenPath,
        PORTAL_TEST_SECRET_FILE: secretPath,
        OP_ASSISTANT_URL: `http://127.0.0.1:${assistantPort}`,
        GUARDIAN_AUDIT_PATH: join(tmpDir, "audit.log"),
        OPENCODE_AUTH: "",
        OPENCODE_SERVER_PASSWORD_FILE: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    guardianUrl = `http://127.0.0.1:${guardianPort}`;
    await waitForGuardianReady(guardianUrl, guardianProc, adminToken);
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

  it("T43 (pin): a portal-authenticated ocCall reaches the mock with NO upstream authorization header, even though the CALLER presented Basic auth to the guardian", async () => {
    const resp = await ocCall(guardianUrl, "POST", "/session", {
      body: JSON.stringify({ title: "no-auth-test" }),
      // The caller DOES send Basic auth to the guardian's own ingress —
      // buildUpstreamHeaders must never forward inbound auth upstream, and
      // with OPENCODE_AUTH unset, no upstream auth is attached either.
    });
    expect(resp.status).toBe(200);
    expect(recordedAuth).toBeNull();
  });
});
