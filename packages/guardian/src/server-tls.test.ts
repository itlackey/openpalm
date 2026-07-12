/**
 * Subprocess integration tests for the guardian direct listener's opt-in mTLS
 * — spec 435 § 2.3. Mirrors the `cors.test.ts` harness (mock assistant +
 * `GUARDIAN_DIRECT_INGRESS: 'true'` + ephemeral ports via
 * `Bun.spawn(['bun','run','src/server.ts'], { env })`), plus: writes the
 * fixture PEMs into `tmpDir` in `beforeAll` and points
 * `GUARDIAN_TLS_CERT_FILE`/`GUARDIAN_TLS_KEY_FILE`/`GUARDIAN_MTLS_CA_FILE` at
 * those paths; captures the child's stdout/stderr for log assertions.
 *
 * RED (main describe): pre-implementation the guardian ignores the TLS env
 * entirely and binds the direct listener as plain HTTP (`server.ts:271-275`)
 * — every HTTPS fetch against the direct port fails to establish TLS at all
 * (ECONNRESET / protocol error), and the plain-HTTP request that SHOULD now
 * fail instead succeeds, so the assertions below fail for the intended
 * reason.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OC_DOC_FIXTURE } from "./oc-doc-fixture.ts";
import {
  CA_CERT_PEM,
  CLIENT_CERT_PEM,
  CLIENT_KEY_PEM,
  SERVER_CERT_PEM,
  SERVER_KEY_PEM,
  WRONG_CA_CLIENT_CERT_PEM,
  WRONG_CA_CLIENT_KEY_PEM,
} from "./tls-test-fixtures.ts";

const TEST_SECRET = "tls-secret-value-1234";
const TEST_PRINCIPAL = "tls-direct";
const TEST_ADMIN_TOKEN = "tls-admin-token-abcd";

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

function authorization(secret = TEST_SECRET, principalId = TEST_PRINCIPAL): string {
  return `Basic ${Buffer.from(`${principalId}:${secret}`, "utf-8").toString("base64")}`;
}

function startMockAssistant(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/doc" && req.method === "GET") return Response.json(OC_DOC_FIXTURE);
      if (url.pathname === "/session" && req.method === "GET") return Response.json([]);
      if (url.pathname === "/session" && req.method === "POST") return Response.json({ id: "tls-session-1" });
      if (url.pathname.startsWith("/session/") && req.method === "GET") return Response.json({ id: "tls-session-1" });
      if (url.pathname.startsWith("/session/") && url.pathname.endsWith("/message") && req.method === "POST") {
        return Response.json({ parts: [{ type: "text", text: "ok" }] });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

let tmpDir: string;
let caPath: string;
let certPath: string;
let keyPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "guardian-server-tls-test-"));
  caPath = join(tmpDir, "ca-cert.pem");
  certPath = join(tmpDir, "server-cert.pem");
  keyPath = join(tmpDir, "server-key.pem");
  writeFileSync(caPath, CA_CERT_PEM);
  writeFileSync(certPath, SERVER_CERT_PEM);
  writeFileSync(keyPath, SERVER_KEY_PEM);
});

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("Guardian direct listener — opt-in mTLS", () => {
  let assistantPort: number;
  let internalPort: number;
  let directPort: number;
  let adminPort: number;
  let mockAssistantServer: ReturnType<typeof Bun.serve>;
  let guardianProc: Subprocess;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let adminUrl: string;

  async function readStreamsInBackground(proc: Subprocess) {
    (async () => {
      if (!proc.stdout || typeof proc.stdout === "number") return;
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        stdoutChunks.push(new TextDecoder().decode(chunk));
      }
    })();
    (async () => {
      if (!proc.stderr || typeof proc.stderr === "number") return;
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        stderrChunks.push(new TextDecoder().decode(chunk));
      }
    })();
  }

  beforeAll(async () => {
    assistantPort = await getAvailablePort();
    internalPort = await getAvailablePort();
    directPort = await getAvailablePort();
    adminPort = await getAvailablePort();

    const secretPath = join(tmpDir, "portal-secret");
    const adminTokenPath = join(tmpDir, "admin-token");
    writeFileSync(secretPath, `${TEST_SECRET}\n`);
    writeFileSync(adminTokenPath, `${TEST_ADMIN_TOKEN}\n`);

    mockAssistantServer = startMockAssistant(assistantPort);
    adminUrl = `http://127.0.0.1:${adminPort}`;

    guardianProc = Bun.spawn(["bun", "run", "src/server.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PORT: String(internalPort),
        GUARDIAN_DIRECT_PORT: String(directPort),
        GUARDIAN_ADMIN_PORT: String(adminPort),
        GUARDIAN_DIRECT_INGRESS: "true",
        GUARDIAN_STATE_DB_PATH: join(tmpDir, "state.db"),
        GUARDIAN_ADMIN_TOKEN_FILE: adminTokenPath,
        GUARDIAN_INTERNAL_HOST: "127.0.0.1",
        OP_ASSISTANT_URL: `http://127.0.0.1:${assistantPort}`,
        GUARDIAN_AUDIT_PATH: join(tmpDir, "audit.log"),
        GUARDIAN_TLS_CERT_FILE: certPath,
        GUARDIAN_TLS_KEY_FILE: keyPath,
        GUARDIAN_MTLS_CA_FILE: caPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    readStreamsInBackground(guardianProc);

    // Wait for readiness by polling the ADMIN listener (stays plain HTTP
    // even in mtls mode) rather than the direct listener, since whether the
    // direct listener accepts HTTPS is exactly what's under test.
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (guardianProc.exitCode !== null) {
        throw new Error(`guardian exited before ready with code ${guardianProc.exitCode}: ${stderrChunks.join("")}`);
      }
      try {
        const resp = await fetch(`${adminUrl}/health`);
        if (resp.ok) {
          ready = true;
          break;
        }
      } catch {
        // not ready yet
      }
      await Bun.sleep(100);
    }
    if (!ready) throw new Error(`guardian (admin listener) did not become ready: ${stderrChunks.join("")}`);

    // Seed the direct principal used by the Basic-auth-over-mTLS test.
    const seedResp = await fetch(`${adminUrl}/admin/principals`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ id: TEST_PRINCIPAL, kind: "direct", token: TEST_SECRET, label: "mTLS direct test client" }),
    });
    if (!seedResp.ok) throw new Error(`failed to seed direct principal: ${seedResp.status} ${await seedResp.text()}`);
  });

  afterAll(() => {
    guardianProc?.kill();
    mockAssistantServer?.stop(true);
  });

  it("serves /health over mTLS to a CA-signed client", async () => {
    const resp = await fetch(`https://127.0.0.1:${directPort}/health`, {
      tls: { ca: CA_CERT_PEM, cert: CLIENT_CERT_PEM, key: CLIENT_KEY_PEM },
    } as RequestInit);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.ok).toBe(true);
  });

  it("authenticates /oc via Basic auth over the mTLS transport (principal from Basic, transport from mTLS — D2)", async () => {
    const withAuth = await fetch(`https://127.0.0.1:${directPort}/oc/session`, {
      method: "POST",
      headers: { authorization: authorization(), "content-type": "application/json", "x-openpalm-user": "tls-user" },
      body: JSON.stringify({}),
      tls: { ca: CA_CERT_PEM, cert: CLIENT_CERT_PEM, key: CLIENT_KEY_PEM },
    } as RequestInit);
    expect(withAuth.status).toBe(200);

    const withoutAuth = await fetch(`https://127.0.0.1:${directPort}/oc/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openpalm-user": "tls-user" },
      body: JSON.stringify({}),
      tls: { ca: CA_CERT_PEM, cert: CLIENT_CERT_PEM, key: CLIENT_KEY_PEM },
    } as RequestInit);
    expect(withoutAuth.status).toBe(401);
  });

  it("rejects a client without a certificate at handshake", async () => {
    await expect(
      fetch(`https://127.0.0.1:${directPort}/health`, { tls: { ca: CA_CERT_PEM } } as RequestInit),
    ).rejects.toBeTruthy();
  });

  it("rejects a wrong-CA client certificate at handshake", async () => {
    await expect(
      fetch(`https://127.0.0.1:${directPort}/health`, {
        tls: { ca: CA_CERT_PEM, cert: WRONG_CA_CLIENT_CERT_PEM, key: WRONG_CA_CLIENT_KEY_PEM },
      } as RequestInit),
    ).rejects.toBeTruthy();
  });

  it("plain-HTTP requests to the direct port fail", async () => {
    await expect(fetch(`http://127.0.0.1:${directPort}/health`)).rejects.toBeTruthy();
  });

  it("internal and admin listeners stay plain HTTP", async () => {
    const internalResp = await fetch(`http://127.0.0.1:${internalPort}/health`);
    expect(internalResp.status).toBe(200);
    const adminResp = await fetch(`${adminUrl}/health`);
    expect(adminResp.status).toBe(200);
  });

  it("started log reports directTls: 'mtls' and leaks no key material", async () => {
    // Give the background stdout reader a moment to catch up.
    await Bun.sleep(200);
    const stdout = stdoutChunks.join("");
    expect(stdout).toContain('"directTls":"mtls"');
    expect(stdout).not.toContain("PRIVATE KEY");
    expect(stdout).not.toContain(SERVER_KEY_PEM.trim());
    expect(stdout).not.toContain(SERVER_CERT_PEM.trim());
    const stderr = stderrChunks.join("");
    expect(stderr).not.toContain("PRIVATE KEY");
  });
});

describe("Guardian direct listener — fail-closed boot on invalid TLS config", () => {
  it("exits non-zero with a clear boot error on partial TLS config (cert+key, no CA)", async () => {
    const assistantPort = await getAvailablePort();
    const internalPort = await getAvailablePort();
    const directPort = await getAvailablePort();
    const adminPort = await getAvailablePort();
    const mockAssistantServer = startMockAssistant(assistantPort);
    const adminTokenPath = join(tmpDir, "partial-admin-token");
    writeFileSync(adminTokenPath, `${TEST_ADMIN_TOKEN}\n`);

    const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PORT: String(internalPort),
        GUARDIAN_DIRECT_PORT: String(directPort),
        GUARDIAN_ADMIN_PORT: String(adminPort),
        GUARDIAN_DIRECT_INGRESS: "true",
        GUARDIAN_STATE_DB_PATH: join(tmpDir, "state-partial.db"),
        GUARDIAN_ADMIN_TOKEN_FILE: adminTokenPath,
        GUARDIAN_INTERNAL_HOST: "127.0.0.1",
        OP_ASSISTANT_URL: `http://127.0.0.1:${assistantPort}`,
        GUARDIAN_AUDIT_PATH: join(tmpDir, "audit-partial.log"),
        GUARDIAN_TLS_CERT_FILE: certPath,
        GUARDIAN_TLS_KEY_FILE: keyPath,
        // GUARDIAN_MTLS_CA_FILE intentionally omitted.
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const exitCode = await Promise.race([
        proc.exited,
        Bun.sleep(5000).then(() => {
          throw new Error("guardian did not exit within 5s on partial TLS config");
        }),
      ]);
      expect(exitCode).not.toBe(0);
      const stderrText = await new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
      expect(stderrText).toContain("GUARDIAN_MTLS_CA_FILE");
    } finally {
      if (proc.exitCode === null) proc.kill();
      mockAssistantServer.stop(true);
    }
  });

  it("exits non-zero when a configured TLS file is missing", async () => {
    const assistantPort = await getAvailablePort();
    const internalPort = await getAvailablePort();
    const directPort = await getAvailablePort();
    const adminPort = await getAvailablePort();
    const mockAssistantServer = startMockAssistant(assistantPort);
    const adminTokenPath = join(tmpDir, "missing-admin-token");
    writeFileSync(adminTokenPath, `${TEST_ADMIN_TOKEN}\n`);
    const missingCaPath = join(tmpDir, "does-not-exist-ca.pem");

    const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PORT: String(internalPort),
        GUARDIAN_DIRECT_PORT: String(directPort),
        GUARDIAN_ADMIN_PORT: String(adminPort),
        GUARDIAN_DIRECT_INGRESS: "true",
        GUARDIAN_STATE_DB_PATH: join(tmpDir, "state-missing.db"),
        GUARDIAN_ADMIN_TOKEN_FILE: adminTokenPath,
        GUARDIAN_INTERNAL_HOST: "127.0.0.1",
        OP_ASSISTANT_URL: `http://127.0.0.1:${assistantPort}`,
        GUARDIAN_AUDIT_PATH: join(tmpDir, "audit-missing.log"),
        GUARDIAN_TLS_CERT_FILE: certPath,
        GUARDIAN_TLS_KEY_FILE: keyPath,
        GUARDIAN_MTLS_CA_FILE: missingCaPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const exitCode = await Promise.race([
        proc.exited,
        Bun.sleep(5000).then(() => {
          throw new Error("guardian did not exit within 5s on a missing TLS file");
        }),
      ]);
      expect(exitCode).not.toBe(0);
      const stderrText = await new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
      expect(stderrText).toContain("GUARDIAN_MTLS_CA_FILE");
    } finally {
      if (proc.exitCode === null) proc.kill();
      mockAssistantServer.stop(true);
    }
  });
});
