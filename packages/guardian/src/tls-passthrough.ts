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
}

export interface TlsPassthrough {
  readonly port: number;
  stop(): void;
}

interface ClientSocketData {
  /** Set once the handshake explicitly rejects — stops any further relay. */
  rejected: boolean;
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

/** Push `chunk` onto `queue` and attempt to drain it into `target` immediately. */
function queueAndTryWrite(target: Socket<unknown>, queue: Uint8Array[], chunk: Uint8Array): void {
  queue.push(chunk);
  flushPending(target, queue);
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
        socket.data = { rejected: false, upstream: null, pendingToUpstream: [], pendingToClient: [] };
      },
      handshake(socket, success, authorizationError) {
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
              socket.data.upstream = upstreamSocket;
              flushPending(upstreamSocket, socket.data.pendingToUpstream);
            },
            data(upstreamSocket, chunk) {
              const client = upstreamSocket.data.client;
              queueAndTryWrite(client, client.data.pendingToClient, chunk);
            },
            drain(upstreamSocket) {
              const client = upstreamSocket.data.client;
              flushPending(client, client.data.pendingToClient);
            },
            close(upstreamSocket) {
              upstreamSocket.data.client.end();
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
          // (fail-closed by construction).
          socket.data.pendingToUpstream.push(chunk);
          return;
        }
        queueAndTryWrite(socket.data.upstream, socket.data.pendingToUpstream, chunk);
      },
      drain(socket) {
        if (socket.data.upstream) flushPending(socket.data.upstream, socket.data.pendingToUpstream);
      },
      close(socket) {
        socket.data.upstream?.end();
      },
      error(socket, error) {
        logger.warn('mtls_client_error', { error: error.message });
        socket.data.upstream?.end();
      },
    },
  });

  return {
    port: server.port,
    stop() {
      server.stop(true);
    },
  };
}
