/**
 * TLS-terminating TCP passthrough for the guardian direct listener (spec 435,
 * D1).
 *
 * Why this exists instead of `Bun.serve({ tls: ... })` or `node:https`: a
 * pre-spec spike (recorded in docs/technical/guardian-direct-mtls.md) found
 * both accept a client certificate signed by ANY CA — on Bun 1.3.11 —
 * when `requestCert`/`rejectUnauthorized` are set. Shipping either would be a
 * false security claim. The one mechanism that reliably surfaces chain
 * verification is `Bun.listen`'s `handshake(socket, success,
 * authorizationError)` callback: `authorizationError` (NOT
 * `socket.authorized`, which reports `true` even on verification failure) is
 * the fail-closed signal. This module binds `Bun.listen` with client-cert
 * verification on the public port, and on a verified handshake pipes raw
 * bytes to a loopback plain-HTTP `Bun.serve` instance — no HTTP parsing, no
 * new dependency.
 */
import { connect, listen, type Socket, type TCPSocketListener } from 'bun';
import { createLogger } from './logger.ts';

const logger = createLogger('guardian.mtls');

/**
 * Per-direction userspace relay-queue cap (PR #564 r3566890023). A verified
 * client that reads slowly while the upstream produces at full speed (or vice
 * versa) would otherwise accumulate every undelivered byte in a JS array →
 * unbounded heap → OOM. Past this many buffered bytes we drop the connection
 * rather than the guardian.
 */
const MAX_RELAY_QUEUE_BYTES = 8 * 1024 * 1024;

/**
 * Seconds a connection may stay open WITHOUT completing the TLS handshake
 * (PR #564 r3566890804). Reaps slowloris / half-open pre-handshake sockets that
 * never trigger the `handshake` callback. Cleared once the handshake resolves.
 */
const HANDSHAKE_TIMEOUT_SECONDS = 15;

/** Total queued bytes across a relay buffer. */
function queuedBytes(queue: Uint8Array[]): number {
  let total = 0;
  for (const chunk of queue) total += chunk.byteLength;
  return total;
}

export interface TlsPassthroughOptions {
  /** Public bind port (DIRECT_PORT). */
  port: number;
  /** Public bind interface. Default: all interfaces (container semantics unchanged). */
  hostname?: string;
  /** Loopback plain-HTTP direct server port to relay verified traffic to. */
  upstreamPort: number;
  /** Loopback upstream hostname. Default '127.0.0.1'. */
  upstreamHostname?: string;
  /** PEM contents — already read, fail-closed, by the caller (server.ts). */
  cert: string;
  key: string;
  ca: string;
  /** Pre-handshake reap timeout in seconds (PR #564 r3566890804). Test seam;
   *  defaults to HANDSHAKE_TIMEOUT_SECONDS. */
  handshakeTimeoutSeconds?: number;
}

export interface TlsPassthrough {
  readonly port: number;
  stop(): void;
  /**
   * Resolve the verified client's real IP for a loopback connection, keyed on
   * the loopback peer port the direct `Bun.serve` sees via `requestIP()`
   * (PR #564 r3566888940). The passthrough relays raw bytes, so without this
   * the direct handler would see every mTLS client as `127.0.0.1` — collapsing
   * the per-IP pre-auth rate bucket and blanking audit source IPs. Returns
   * undefined when the port is unknown (caller falls back to the peer address).
   */
  resolveClientIp(loopbackPort: number): string | undefined;
}

interface ClientSocketData {
  /** Set once the handshake explicitly rejects — stops any further relay. */
  rejected: boolean;
  /** Set once the client socket has closed. Guards the connect-window race
   *  (PR #564 r3566890583): if the upstream finishes connecting after the
   *  client is already gone, it must be torn down, not attached+orphaned. */
  clientClosed: boolean;
  /** Set once the upstream has closed and we are draining the remaining
   *  client-bound bytes before ending the client (PR #564 r3566890224). */
  upstreamClosed: boolean;
  /** Pre-handshake reap timer (PR #564 r3566890804); cleared once the handshake
   *  callback fires. A plain JS timer — Bun's socket.timeout() does not reap a
   *  TLS socket that never sends a ClientHello. */
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  upstream: Socket<UpstreamSocketData> | null;
  /**
   * Client bytes not yet relayed to the upstream: pre-connect buffer, write
   * backpressure, AND (see `data()` below) bytes that arrive before the
   * `handshake` callback has resolved. On Bun 1.3.11 the `data` event for a
   * TLS socket is not guaranteed to fire after `handshake` — a client that
   * completes its TLS ClientHello can push application bytes that Bun
   * delivers to `data` before the JS `handshake` callback runs. Buffering
   * unconditionally here (rather than gating on a "verified" flag) avoids
   * dropping/rejecting a connection that is in fact about to be accepted.
   * Fail-closed is still preserved by construction: this buffer is only
   * ever flushed to the upstream from the `handshake` accept branch, which
   * is also the only place `Bun.connect` to the upstream is called — a
   * rejected handshake ends the socket and this buffer is simply discarded
   * with it, never reaching the upstream.
   */
  pendingToUpstream: Uint8Array[];
  /** Upstream bytes not yet relayed to the client (write backpressure only). */
  pendingToClient: Uint8Array[];
}

interface UpstreamSocketData {
  client: Socket<ClientSocketData>;
}

/**
 * Push `chunk` onto `queue` and drain what `write()` accepts. Returns false and
 * leaves the queue intact when the buffered backlog exceeds
 * MAX_RELAY_QUEUE_BYTES — the caller drops the connection (PR #564 r3566890023).
 */
function queueAndTryWrite(target: Socket<unknown>, queue: Uint8Array[], chunk: Uint8Array): boolean {
  queue.push(chunk);
  flushPending(target, queue);
  return queuedBytes(queue) <= MAX_RELAY_QUEUE_BYTES;
}

/** Drain as much of `queue` into `target` as `write()` currently accepts, honoring backpressure. */
function flushPending(target: Socket<unknown>, queue: Uint8Array[]): void {
  while (queue.length > 0) {
    const next = queue[0];
    const written = target.write(next);
    if (written < 0) {
      // Target closed/shutting down — drop the queue; the peer's close()
      // handler tears down the other side.
      queue.length = 0;
      return;
    }
    if (written < next.byteLength) {
      // Backpressure: keep the unwritten remainder at the front and wait
      // for the next `drain` event before retrying.
      queue[0] = next.subarray(written);
      return;
    }
    queue.shift();
  }
}

export function startTlsPassthrough(options: TlsPassthroughOptions): TlsPassthrough {
  const upstreamHostname = options.upstreamHostname ?? '127.0.0.1';
  const handshakeTimeoutSeconds = options.handshakeTimeoutSeconds ?? HANDSHAKE_TIMEOUT_SECONDS;

  // PR #564 r3566888940: map the loopback upstream connection's local port
  // (which the direct Bun.serve sees as its peer's `requestIP().port`) to the
  // verified client's real IP, so per-IP rate limiting + audit are accurate.
  const clientIpByLoopbackPort = new Map<number, string>();

  const server: TCPSocketListener<ClientSocketData> = listen<ClientSocketData>({
    hostname: options.hostname ?? '0.0.0.0',
    port: options.port,
    tls: {
      cert: options.cert,
      key: options.key,
      ca: options.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    socket: {
      open(socket) {
        socket.data = {
          rejected: false,
          clientClosed: false,
          upstreamClosed: false,
          handshakeTimer: null,
          upstream: null,
          pendingToUpstream: [],
          pendingToClient: [],
        };
        // PR #564 r3566890804: reap a connection that never completes its TLS
        // handshake (slowloris). Cleared on the first `handshake` callback.
        socket.data.handshakeTimer = setTimeout(() => {
          logger.warn('mtls_handshake_timeout', { remoteAddress: socket.remoteAddress });
          socket.end();
        }, handshakeTimeoutSeconds * 1000);
      },
      handshake(socket, success, authorizationError) {
        // Handshake resolved — clear the pre-handshake reap timer.
        if (socket.data.handshakeTimer) {
          clearTimeout(socket.data.handshakeTimer);
          socket.data.handshakeTimer = null;
        }
        // Fail-closed acceptance condition (spec 435 D1): both `success`
        // AND a null `authorizationError` are required. `socket.authorized`
        // is NOT trusted here — the spike found it reports `true` even when
        // `authorizationError` names a real chain-verification failure.
        if (!success || authorizationError !== null) {
          logger.warn('mtls_handshake_rejected', {
            remoteAddress: socket.remoteAddress,
            error: authorizationError ? authorizationError.message : 'handshake_failed',
          });
          socket.data.rejected = true;
          socket.data.pendingToUpstream = [];
          socket.end();
          return;
        }

        let subject: string | undefined;
        let fingerprint256: string | undefined;
        try {
          const peerCert = socket.getPeerX509Certificate();
          subject = peerCert.subject;
          fingerprint256 = peerCert.fingerprint256;
        } catch {
          // Certificate details are best-effort logging only; verification
          // already succeeded above.
        }
        logger.info('mtls_handshake_accepted', {
          remoteAddress: socket.remoteAddress,
          subject,
          fingerprint256,
        });

        // Open the upstream connection now that the client is verified. No
        // byte from the client reaches the upstream before this point — any
        // bytes buffered in `pendingToUpstream` while the handshake was
        // still resolving are flushed only once `open()` below fires.
        connect<UpstreamSocketData>({
          hostname: upstreamHostname,
          port: options.upstreamPort,
          data: { client: socket },
          socket: {
            open(upstreamSocket) {
              // PR #564 r3566890583: the client may have disconnected while
              // this upstream was still connecting. Attaching + flushing to a
              // dead client would orphan this upstream forever (idleTimeout:0).
              // Tear it down instead.
              if (socket.data.clientClosed) {
                upstreamSocket.end();
                return;
              }
              socket.data.upstream = upstreamSocket;
              // Correlate this loopback connection's local port → real client IP
              // (PR #564 r3566888940).
              const loopbackPort = (upstreamSocket as unknown as { localPort?: number }).localPort;
              if (typeof loopbackPort === 'number' && socket.remoteAddress) {
                clientIpByLoopbackPort.set(loopbackPort, socket.remoteAddress);
              }
              flushPending(upstreamSocket, socket.data.pendingToUpstream);
            },
            data(upstreamSocket, chunk) {
              const client = upstreamSocket.data.client;
              if (!queueAndTryWrite(client, client.data.pendingToClient, chunk)) {
                logger.warn('mtls_relay_queue_overflow', { direction: 'upstream_to_client' });
                upstreamSocket.end(); // drop the connection (close handlers tear down both)
              }
            },
            drain(upstreamSocket) {
              // The upstream socket is writable again — retry the bytes queued
              // FOR the upstream (client→upstream), not the client-bound queue.
              const client = upstreamSocket.data.client;
              flushPending(upstreamSocket, client.data.pendingToUpstream);
            },
            close(upstreamSocket) {
              const loopbackPort = (upstreamSocket as unknown as { localPort?: number }).localPort;
              if (typeof loopbackPort === 'number') clientIpByLoopbackPort.delete(loopbackPort);
              // PR #564 r3566890224: flush any client-bound bytes still queued
              // (userspace backpressure buffer) before ending the client, so a
              // slow reader's response body isn't truncated. If the queue can't
              // fully drain now, mark half-closed and finish on the client drain.
              const client = upstreamSocket.data.client;
              flushPending(client, client.data.pendingToClient);
              if (client.data.pendingToClient.length === 0) {
                client.end();
              } else {
                client.data.upstreamClosed = true;
              }
            },
            error(upstreamSocket, error) {
              logger.warn('mtls_upstream_error', { error: error.message });
              upstreamSocket.data.client.end();
            },
          },
        }).catch((error: Error) => {
          logger.warn('mtls_upstream_connect_error', { error: error.message });
          socket.end();
        });
      },
      data(socket, chunk) {
        if (socket.data.rejected) {
          socket.end();
          return;
        }
        if (!socket.data.upstream) {
          // Either the handshake hasn't resolved yet, or it has accepted but
          // the upstream connection is still opening — buffer either way.
          // Only the accept branch of `handshake` ever opens the upstream,
          // so this buffer never reaches it unless the handshake accepted
          // (fail-closed by construction). Still bound the buffer (PR #564
          // r3566890023) — a client can flood before the upstream opens.
          socket.data.pendingToUpstream.push(chunk);
          if (queuedBytes(socket.data.pendingToUpstream) > MAX_RELAY_QUEUE_BYTES) {
            logger.warn('mtls_relay_queue_overflow', { direction: 'client_to_upstream_preconnect' });
            socket.end();
          }
          return;
        }
        if (!queueAndTryWrite(socket.data.upstream, socket.data.pendingToUpstream, chunk)) {
          logger.warn('mtls_relay_queue_overflow', { direction: 'client_to_upstream' });
          socket.end(); // drop the connection (close handlers tear down both)
        }
      },
      drain(socket) {
        // The client socket is writable again — retry the bytes queued FOR the
        // client (upstream→client), not the upstream-bound queue.
        flushPending(socket, socket.data.pendingToClient);
        // PR #564 r3566890224: if the upstream already closed and we were only
        // holding to drain the tail, end the client once the queue is empty.
        if (socket.data.upstreamClosed && socket.data.pendingToClient.length === 0) {
          socket.end();
        }
      },
      close(socket) {
        // PR #564 r3566890583: record the client is gone so a still-connecting
        // upstream tears itself down instead of attaching to a dead client.
        socket.data.clientClosed = true;
        if (socket.data.handshakeTimer) {
          clearTimeout(socket.data.handshakeTimer);
          socket.data.handshakeTimer = null;
        }
        socket.data.upstream?.end();
      },
      error(socket, error) {
        logger.warn('mtls_client_error', { error: error.message });
        socket.data.clientClosed = true;
        socket.data.upstream?.end();
      },
    },
  });

  return {
    port: server.port,
    stop() {
      server.stop(true);
    },
    resolveClientIp(loopbackPort: number): string | undefined {
      return clientIpByLoopbackPort.get(loopbackPort);
    },
  };
}
