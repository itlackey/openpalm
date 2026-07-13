/**
 * In-process tests of `startTlsPassthrough()` — spec 435 § 2.2.
 *
 * A loopback upstream `Bun.serve` (started in `beforeAll`) stands in for the
 * guardian's plain-HTTP direct listener. The passthrough under test is the
 * TLS-terminating `Bun.listen` front door: `Bun.fetch`'s `tls: { ca, cert,
 * key }` extension drives the client side, exactly as the pre-spec spike did
 * (see spec 435 D1 and docs/technical/guardian-direct-mtls.md once written).
 *
 * RED: `./tls-passthrough.ts` does not exist yet — the import below throws
 * (module not found), failing every test in this file until spec 435's
 * tls-passthrough.ts module lands.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { connect } from "node:net";
import { startTlsPassthrough, type TlsPassthrough } from "./tls-passthrough.ts";
import {
  CA_CERT_PEM,
  CLIENT_CERT_PEM,
  CLIENT_KEY_PEM,
  SERVER_CERT_PEM,
  SERVER_KEY_PEM,
  WRONG_CA_CLIENT_CERT_PEM,
  WRONG_CA_CLIENT_KEY_PEM,
} from "./tls-test-fixtures.ts";

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

let upstream: ReturnType<typeof Bun.serve>;
let upstreamPort: number;
let upstreamRequestCount = 0;
let passthrough: TlsPassthrough | undefined;
let passthroughPort: number;

beforeAll(async () => {
  upstreamPort = await getAvailablePort();
  upstream = Bun.serve({
    port: upstreamPort,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req, server) {
      upstreamRequestCount += 1;
      const url = new URL(req.url);
      if (url.pathname === "/whoami") {
        // The loopback peer port here is the passthrough's connect localPort;
        // resolveClientIp maps it back to the verified client's real IP.
        const port = server.requestIP(req)?.port ?? -1;
        return Response.json({ clientIp: passthrough?.resolveClientIp(port) ?? null });
      }
      if (url.pathname === "/echo") {
        return Response.json({ ok: true, path: url.pathname });
      }
      if (url.pathname === "/stream") {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode("data: chunk-1\n\n"));
            await Bun.sleep(20);
            controller.enqueue(encoder.encode("data: chunk-2\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  upstream?.stop(true);
});

afterEach(() => {
  passthrough?.stop();
  passthrough = undefined;
});

async function startPassthrough(): Promise<TlsPassthrough> {
  passthroughPort = await getAvailablePort();
  passthrough = startTlsPassthrough({
    port: passthroughPort,
    hostname: "127.0.0.1",
    upstreamPort,
    upstreamHostname: "127.0.0.1",
    cert: SERVER_CERT_PEM,
    key: SERVER_KEY_PEM,
    ca: CA_CERT_PEM,
  });
  return passthrough;
}

describe("startTlsPassthrough", () => {
  it("forwards a CA-signed client to the upstream", async () => {
    await startPassthrough();
    const before = upstreamRequestCount;
    const resp = await fetch(`https://127.0.0.1:${passthroughPort}/echo`, {
      tls: { ca: CA_CERT_PEM, cert: CLIENT_CERT_PEM, key: CLIENT_KEY_PEM },
    } as RequestInit);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, path: "/echo" });
    expect(upstreamRequestCount).toBe(before + 1);
  });

  it("pipes streaming (SSE) bodies through incrementally", async () => {
    await startPassthrough();
    const resp = await fetch(`https://127.0.0.1:${passthroughPort}/stream`, {
      tls: { ca: CA_CERT_PEM, cert: CLIENT_CERT_PEM, key: CLIENT_KEY_PEM },
    } as RequestInit);
    expect(resp.status).toBe(200);
    const reader = resp.body?.getReader();
    if (!reader) throw new Error("expected a readable stream body");
    const decoder = new TextDecoder();
    let chunks = 0;
    let received = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks += 1;
      received += decoder.decode(value, { stream: true });
    }
    expect(chunks).toBeGreaterThanOrEqual(2);
    expect(received).toContain("chunk-1");
    expect(received).toContain("chunk-2");
  });

  it("rejects a client with no certificate at handshake", async () => {
    await startPassthrough();
    await expect(
      fetch(`https://127.0.0.1:${passthroughPort}/echo`, {
        tls: { ca: CA_CERT_PEM },
      } as RequestInit),
    ).rejects.toBeTruthy();
  });

  it("rejects a client certificate signed by a different CA", async () => {
    // The fail-closed authorizationError check — the case naive `Bun.serve
    // tls:` can never pass (spike D1): it accepts a wrong-CA client cert.
    await startPassthrough();
    await expect(
      fetch(`https://127.0.0.1:${passthroughPort}/echo`, {
        tls: { ca: CA_CERT_PEM, cert: WRONG_CA_CLIENT_CERT_PEM, key: WRONG_CA_CLIENT_KEY_PEM },
      } as RequestInit),
    ).rejects.toBeTruthy();
  });

  it("never forwards bytes upstream on a rejected handshake", async () => {
    await startPassthrough();
    const before = upstreamRequestCount;
    await fetch(`https://127.0.0.1:${passthroughPort}/echo`, { tls: { ca: CA_CERT_PEM } } as RequestInit).catch(() => {});
    await fetch(`https://127.0.0.1:${passthroughPort}/echo`, {
      tls: { ca: CA_CERT_PEM, cert: WRONG_CA_CLIENT_CERT_PEM, key: WRONG_CA_CLIENT_KEY_PEM },
    } as RequestInit).catch(() => {});
    // Give any (incorrectly) forwarded bytes time to reach the upstream.
    await Bun.sleep(100);
    expect(upstreamRequestCount).toBe(before);
  });

  it("stop() releases the port", async () => {
    const pt = await startPassthrough();
    pt.stop();
    passthrough = undefined;

    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port: passthroughPort }, () => {
          socket.destroy();
          reject(new Error("connection unexpectedly succeeded after stop()"));
        });
        socket.once("error", () => resolve());
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves the real client IP for a forwarded connection (PR #564 r3566888940)", async () => {
    await startPassthrough();
    const resp = await fetch(`https://127.0.0.1:${passthroughPort}/whoami`, {
      tls: { ca: CA_CERT_PEM, cert: CLIENT_CERT_PEM, key: CLIENT_KEY_PEM },
    } as RequestInit);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { clientIp: string | null };
    // The verified client connects from loopback in-test; the point is that the
    // passthrough recovered a real per-connection IP (not undefined), so the
    // direct handler keys rate-limiting/audit on it instead of 127.0.0.1-always.
    expect(body.clientIp).toBe("127.0.0.1");
  });

  it("reaps a connection that never completes the TLS handshake (slowloris, PR #564 r3566890804)", async () => {
    const port = await getAvailablePort();
    const pt = startTlsPassthrough({
      port,
      hostname: "127.0.0.1",
      upstreamPort,
      upstreamHostname: "127.0.0.1",
      cert: SERVER_CERT_PEM,
      key: SERVER_KEY_PEM,
      ca: CA_CERT_PEM,
      handshakeTimeoutSeconds: 1,
    });
    try {
      const reaped = await new Promise<boolean>((resolve) => {
        // Raw TCP, no TLS ClientHello — the `handshake` callback never fires.
        const socket = connect({ host: "127.0.0.1", port }, () => {
          /* connected; deliberately send nothing */
        });
        socket.on("close", () => resolve(true));
        socket.on("error", () => resolve(true));
        setTimeout(() => resolve(false), 3000);
      });
      expect(reaped).toBe(true);
    } finally {
      pt.stop();
    }
  });
});
