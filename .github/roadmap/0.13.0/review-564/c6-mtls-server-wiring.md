# c6-mtls-server-wiring: guardian server.ts mTLS: propagate client IP + fix MCP self-dial port

_Severity: major. PR #564 review (fwdslsh-dev, 2026-07-12)._

## Findings

### 🟠 `packages/guardian/src/server.ts:307` (r3566888940)

In mTLS mode every direct request's client IP collapses to 127.0.0.1 → shared pre-auth rate bucket (cross-client DoS) + audit logs lose the real source. When DIRECT_TLS.mode==='mtls' the plain-HTTP direct handler moves to a loopback ephemeral Bun.serve (303-308) fronted by the raw-byte TLS passthrough, which does not preserve the client IP. So server.requestIP(req)?.address is always 127.0.0.1. allowPreAuth(clientIp) keys the per-IP pre-auth budget on ip:127.0.0.1 — one adapter exceeding PREAUTH_RATE_LIMIT (600/min) trips a shared 429 for all mTLS clients; aggregate throughput capped at 600/min total. deny()/audit records log 127.0.0.1 instead of the real peer. Fix: carry the verified client's remoteAddress from the TLS passthrough to the loopback handler (e.g. PROXY-protocol header or an injected trusted header) and key rate-limiting/audit on that.

### 🟠 `packages/guardian/src/server.ts:303` (r3566889234)

mTLS moves the plain-HTTP direct handler to an ephemeral port, but the MCP self-dial is still hardcoded to 3830 → every MCP askAssistant fails under mTLS. This branch binds the plain-HTTP direct server on port:0 (ephemeral) and puts the TLS passthrough on DIRECT_PORT (3830). But mcp.ts:18 computes DIRECT_BASE_URL as http://127.0.0.1:${DIRECT_PORT} and fetches ${DIRECT_BASE_URL}/oc/session (mcp.ts:98) and /oc/session/{id}/message (mcp.ts:121). With GUARDIAN_MCP=true + mTLS, those plain-HTTP fetches hit the TLS listener on 3830 → handshake fails → every MCP tool call returns guardian_unreachable/502. Fix: point the MCP self-dial at the actual loopback plain-HTTP port (direct.port in mTLS mode) rather than the public DIRECT_PORT.

## Verification gates

- `cd packages/guardian && bun test --no-orphans`
