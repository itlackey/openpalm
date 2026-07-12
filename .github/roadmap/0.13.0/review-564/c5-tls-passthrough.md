# c5-tls-passthrough: guardian tls-passthrough: flow control, flush-on-close, orphan-upstream, handshake timeout

_Severity: major. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🟠 `packages/guardian/src/tls-passthrough.ts:162` (r3566890023)

Relay queues grow without bound (no flow control) → guardian OOM from a single slow mTLS client. queueAndTryWrite pushes every upstream chunk onto pendingToClient and drains only what write() accepts now; on backpressure the remainder stays queued and the reading side is never paused. No size cap, no pause() of the source socket. A verified adapter opening a large/streaming response (/oc/event, big history) and reading slowly makes the loopback upstream produce full speed while the client drains a trickle — every undelivered byte accumulates. N slow clients × stream size → unbounded heap → OOM. (client→upstream direction pendingToUpstream has the same exposure on uploads.) Fix: apply flow control — pause/ref the source socket while the destination queue is non-empty (resume on drain), or cap the queue and drop the connection past a threshold.

### 🟠 `packages/guardian/src/tls-passthrough.ts:171` (r3566890224)

Upstream close() ends the client before flushing queued bytes → truncated response body. When the loopback upstream finishes and closes, this handler calls upstreamSocket.data.client.end() immediately. But pendingToClient is a userspace queue of bytes write() hasn't accepted yet. end() closes and discards them. Trigger: a slow mTLS client requesting a response larger than its socket send buffer with Connection: close — client receives a truncated/invalid body. Symmetric case at line 205 (close(socket)→upstream?.end()) for pendingToUpstream. Fix: on peer close, flush the remaining queue before end() (or end() only once the queue is empty via a half-closed draining state).

### 🟠 `packages/guardian/src/tls-passthrough.ts:205` (r3566890583)

Client disconnect during the upstream connect window orphans the upstream socket → loopback fd/connection leak. close(socket) tears down the upstream via socket.data.upstream?.end(), but upstream is only set later in the async connect(...).open() callback (line 157). If a verified client completes the handshake then immediately disconnects (RST) while Bun.connect is still resolving, close(socket) runs with socket.data.upstream===null → ?.end() is a no-op. Then open(upstreamSocket) fires, stores the upstream on the already-dead client, flushes — but nothing tears that upstream down. With idleTimeout:0 (server.ts:306) it persists indefinitely → one fd/socket leak per occurrence. Fix: in open(upstreamSocket), if the client is already closed/rejected, immediately end() the upstream instead of attaching it (track a clientClosed flag on socket.data).

### 🟡 `packages/guardian/src/tls-passthrough.ts:101` (r3566890804)

Public TLS listener has no handshake/idle timeout → slowloris fd exhaustion. listen(...) sets no socket.timeout and no idle deadline. A client that opens a TCP connection to DIRECT_PORT and never sends a complete ClientHello never triggers the handshake callback, so the socket stays open indefinitely. Many such connections → fd exhaustion. Fix: set a handshake/idle timeout on the listener (e.g. socket.timeout(...) in open, cleared on successful handshake) so half-open pre-handshake connections are reaped.

## Verification gates

- `cd packages/guardian && bun test --no-orphans`
