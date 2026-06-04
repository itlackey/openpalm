# Auth & Proxy Refactor Plan

> Status: **HISTORICAL DESIGN DOCUMENT** — Phase 2 (cookie auth, `op_session`,
> removal of `x-admin-token` / `OP_ASSISTANT_TOKEN` fallback) has **landed** in
> v0.11.0. This document records the rationale and phased plan; the
> implementation details are now in the shipped code.
> Authoritative rules in [`core-principles.md`](./core-principles.md) take
> precedence over anything here.

## What changed in v3

- **Drop OpenPalm-side audit logging entirely.** OpenCode session/event logs are
  authoritative for chat + tool activity, and admin actions are now mostly
  OpenCode tool calls (D3) which OpenCode logs natively. The few SvelteKit
  endpoints that remain (login, endpoint CRUD, setup writes) are user-initiated
  UI actions where the operator *is* the actor — no separate audit trail
  needed. Saves the entire `appendAudit` plumbing plus the `/admin/audit` route
  family.
- **Drop multi-tab endpoint pinning.** OpenPalm UI runs in an Electron
  BrowserWindow — there's no multi-tab scenario worth designing for. Active
  endpoint stays server-side state; no `?endpoint=<id>` URL parameter.
- **CSP enforced from day one** (not report-only). The codebase has no
  third-party JS, no analytics, no extensions; nothing to surprise us in a
  report-only window. Tight policy:
  `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`.

## What we got wrong in v1 of this plan

v1 (D1 dated 2026-05-22) said: "drop the proxy, use a session-exchange endpoint
that hands OpenCode Basic auth to the browser, browser talks to OpenCode
directly." We reversed that in v2. The load-bearing correction:

1. **The SDK already does fetch+ReadableStream SSE.** v1 treated "EventSource can't
   set Authorization" as an architectural forcing function ("therefore we need a
   server-side proxy OR a session-exchange to push the credential to JS"). It is
   not. `@opencode-ai/sdk` ships `serverSentEvents.gen.js` that does
   `fetch(url, {headers, signal}).then(r => r.body.pipeThrough(TextDecoderStream))`
   — auth in headers, `Last-Event-ID`, exponential-backoff reconnects, abort
   signals. Verified at
   `node_modules/.bun/@opencode-ai+sdk@1.15.13/node_modules/@opencode-ai/sdk/dist/gen/core/serverSentEvents.gen.js`.
   SSE-with-headers is **not** an architectural decision driver in either
   direction.

2. **v1 invented a file that does not exist.** `packages/ui/src/lib/opencode/client.server.ts`
   is referenced throughout v1's code-to-delete inventory. It is not in the tree.
   The only `lib/opencode/` files are `provider-models.ts` (+ its vitest). v1's
   LOC accounting was wrong by ~80 LOC.

3. **v1 conceded the wrong tradeoff.** v1 wrote: "an XSS payload could call the
   proxy in a loop and achieve the same outcome [as stealing the password]…
   the proxy was XSS-resistance theater past the point of 'rotate the credential
   on detection.'" This is wrong. A proxy backed by `op_session`
   contains the credential to the server process; XSS gets a session,
   revoking the session stops the attack, and the OpenCode password is never
   exfiltratable. v1's "direct" path lets XSS read the password from JS memory
   and post it to attacker infrastructure for persistent access until manual
   password rotation. Categorically different blast radius.

4. **OpenCode upstream's "password in browser localStorage" pattern is not
   guidance for OpenPalm.** Upstream is a single-user desktop tool with no
   server in the request path. OpenPalm is a multi-user, multi-host, channel-fronted
   self-hosted platform with a SvelteKit server already on every request path.
   The broker is free here; it costs a lot upstream. Different threat model,
   different decision.

v2 keeps the proxy as a deliberate credential broker, deletes the dead admin
proxy and the dead `OP_ADMIN_OPENCODE_INTERNAL_URL` path, and trims the
broker's one real bug (response buffering).

## TL;DR

- **Keep the assistant proxy as a credential broker. Delete the dead admin proxy.**
  The existing `packages/ui/src/routes/proxy/assistant/[...path]/+server.ts` (79
  LOC) does the load-bearing security work: the OpenCode endpoint password
  lives in a `config/endpoints.json` file (0600) read by the SvelteKit server
  per request, and is never seen by JS. The cookie `op_session` (HttpOnly,
  SameSite=Strict) is the only credential the browser holds; XSS cannot read it.
  This is the strongest containment posture available without changes to
  OpenCode upstream.
- **Fix the one real broker bug.** The proxy currently does
  `await upstream.arrayBuffer()` before returning, which buffers entire SSE
  streams and breaks streaming completions. Replace with a 5-line streaming
  passthrough (return `upstream.body` directly with status + headers copied).
  No new files; trim the existing one.
- **Delete the dead admin proxy.** `packages/ui/src/routes/proxy/admin/[...path]/+server.ts`
  reads `OP_ADMIN_OPENCODE_INTERNAL_URL` which is set in zero places repo-wide
  (verified). No callers exist (verified). 71 LOC dead code.
- **Drop `OP_ASSISTANT_TOKEN` and the `x-admin-token` header fallback. Keep
  `op_session` and the OpenCode endpoint password.** Two credentials at rest
  (UI login → cookie; OpenCode endpoint password → server-side file). Zero
  credentials in JS. Zero "admin token" UI.
- **The ephemeral local OpenCode (Electron-spawned) is in.** Per-launch random
  password, set in spawn env, never written to disk, never logged. Tool calls
  are logged by OpenCode itself (session log under
  `~/.openpalm/data/admin-opencode/log/`) — no OpenPalm-side audit wrapping.
  Killed on Electron quit + reaped via `process.on('exit')` and a pidfile
  sweep at next launch. **Routed through the same broker** as remote OpenCode
  — broker reads the per-launch password from an Electron-written runtime
  file (`data/local-opencode.runtime.json`, 0600, deleted at quit).
- **Connection list lives in `config/`, not `data/`.** User's instinct here
  is right. It is user-owned configuration; it must be portable; it survives
  `data/` wipes. Existing `data/admin/endpoints.json` migrates one-way.
- **Net delta: ~ -900 LOC (impl) / -1300 LOC (with tests).** Remove the dead
  admin proxy, AuthGate, `ControlPlaneState.adminToken` + `assistantToken`,
  the `OP_ADMIN_OPENCODE_INTERNAL_URL` path, the `x-admin-token` fallback in
  `requireAdmin()`, the wizard token UI. Add ~250 LOC: streaming-passthrough fix
  + Electron spawn + admin-tools plugin + migration.

---

## Decisions

### D1. Keep the assistant proxy as a credential broker. Fix its one bug. Delete the dead admin proxy.

**Decision:** The existing `packages/ui/src/routes/proxy/assistant/[...path]/+server.ts`
stays. The OpenCode endpoint password lives server-side in
`config/endpoints.json` (0600) and is never seen by browser JS. The browser
authenticates to *the UI server* with `op_session` (HttpOnly, SameSite=Strict).
The UI server adds `Authorization: Basic :<password>` per request before
forwarding to OpenCode. Same-origin everywhere; no CORS concerns; XSS gets a
session, not a password.

The dead `packages/ui/src/routes/proxy/admin/[...path]/+server.ts` and its
`OP_ADMIN_OPENCODE_INTERNAL_URL` env var are deleted. They are never set,
never called.

**Why this beats the v1 "drop the proxy" decision:**

1. **The proxy IS the credential boundary, not a wrapper around one.** With
   the broker in place, browser-side XSS can replay arbitrary requests in the
   victim's session, but cannot read the OpenCode password and cannot persist
   beyond `op_session` revocation. In v1's "direct" model, XSS reads the
   password from JS memory, POSTs it to attacker infrastructure, and retains
   access until the user manually rotates the OpenCode password. Both designs
   give XSS capability while the tab is open. Only the broker contains the
   credential. That is a categorical difference in incident response (revoke
   one cookie vs. rotate every endpoint password).

2. **The v1 SSE argument is moot.** v1 argued for a session-exchange + browser
   `direct-client.ts` partly because "the browser still has to use
   fetch+ReadableStream for streaming completions, so we're paying that cost
   anyway." Wrong inference: the SDK already ships fetch+ReadableStream SSE
   that works *through* the broker (the broker passes `response.body` through
   unchanged once we fix the `arrayBuffer()` bug). The browser uses the SDK
   normally with `baseUrl: '/proxy/assistant'`. No new client, no manual SSE
   parsing in the UI.

3. **The proxy is small.** The current implementation is 79 LOC. v1's
   replacement was: `+~80 LOC exchange endpoint, +~120 LOC direct-client,
   +~20 LOC CSP hook, +session-token storage, +token-rotation logic,
   +CSRF for the exchange endpoint.* That is more code and more concepts to
   maintain than the broker it replaces. The "drop the proxy for simplicity"
   framing was inverted.

4. **OpenPalm's request path already includes a server.** Unlike upstream
   OpenCode (a single-user desktop app where any in-process server is pure
   overhead), OpenPalm's UI is SvelteKit on adapter-node. Every page load,
   every API call, every Docker action goes through this server already. The
   broker adds one `fetch()` and an Authorization header — measured cost is
   one hop on loopback.

**The one bug the broker has today (and the fix):**

`proxy/assistant/[...path]/+server.ts:47` does
`const responseBody = await upstream.arrayBuffer();` before returning. This
buffers entire SSE streams in memory, breaking streaming completions. Fix in
the same file:

```ts
// Before
const responseBody = await upstream.arrayBuffer();
return new Response(responseBody, { status: upstream.status, headers: {...} });

// After
return new Response(upstream.body, {
  status: upstream.status,
  headers: {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'x-request-id': requestId,
    'x-endpoint-id': endpoint.id,
    'x-endpoint-label': encodeURIComponent(endpoint.label),
    ...(upstream.headers.get('cache-control') ? { 'cache-control': upstream.headers.get('cache-control')! } : {}),
  },
});
```

Five-line patch. No new file. `upstream.body` is a `ReadableStream<Uint8Array>`;
adapter-node forwards it unchanged. The `AbortSignal.timeout(150_000)` stays
on the request; SSE keepalives reset its socket-level read timer in practice.
For long-running streams beyond 150s we lift the timeout *for SSE responses
only* (detected via the `content-type: text/event-stream` Accept header on the
request) — this is the one bit of broker policy worth adding.

**Per-endpoint routing — broker stays per-request:**

The broker already reads `getActiveEndpoint()` per request from
`config/endpoints.json` (after D4 migration). Endpoint switching in the UI
takes effect on the next request without restarting the server. No session
state to invalidate.

**XSS posture (full disclosure):**

- Browser holds `op_session` (HttpOnly, SameSite=Strict, Path=/). XSS cannot
  read it.
- Browser holds zero OpenCode credentials.
- XSS *can* replay requests through the broker for the lifetime of
  `op_session` (default 24h, configurable). Detection → revoke `op_session` →
  attack stops immediately. No credential rotation required.
- For belt-and-suspenders we add a CSP hook in `packages/ui/src/hooks.server.ts`
  (~20 LOC): `Content-Security-Policy: default-src 'self'; script-src 'self';
  object-src 'none'; frame-ancestors 'none'; base-uri 'none'`. Adapter-node
  emits external chunks; verified by inspection of the build output (no inline
  scripts beyond Svelte's hydration which is `'self'`).

**What we are NOT doing (and why):**

- Not adding a session-exchange endpoint. Solves no problem the broker doesn't
  already solve.
- Not building a browser-side `direct-client.ts`. The SDK works through the
  broker unchanged once we set `baseUrl: '/proxy/assistant'`.
- Not pushing for upstream Bearer/JWT auth in OpenCode. Possible follow-on but
  not on the critical path; the broker pattern is correct regardless of which
  auth scheme the upstream OpenCode supports.
- Not relying on CSP as the primary XSS containment. CSP is a hardening layer.
  The credential boundary is the broker.

**Honest costs of v2 vs. v1:**

- We pay one server hop per OpenCode request. Loopback latency on
  adapter-node is sub-millisecond; against a remote endpoint the broker hop
  is dwarfed by the WAN RTT.
- The SvelteKit server must be running for the UI to talk to OpenCode. (True
  in v1 too — the UI itself ships from this server.)
- We must fix the streaming bug. (Five lines; would have been needed in v1's
  "direct" path anyway, just on the client side.)

### D2. `op_session` cookie is the only browser-visible credential. Drop the `x-admin-token` fallback everywhere.

**Decision:** `op_session` (HttpOnly, SameSite=Strict, Path=/) gates the
SvelteKit admin UI, all `/admin/*` API routes, and the `/proxy/assistant/*`
broker. The `x-admin-token` header fallback in
`packages/ui/src/lib/server/helpers.ts:77-128` and the `Bearer` token path are
removed. The UI server's `requireAdmin()` checks the cookie only.

**Why:** The UI server has privileged endpoints — endpoint list mutation,
secrets management, Docker compose actions — and now also the proxy. They all
need authentication that is hard for browser-side malware to steal. `op_session`
does that. The `x-admin-token` fallback exists for legacy out-of-process
callers (cron `action: api` automations); D5 retargets those to the OpenCode
endpoint password instead, removing the last need for the fallback.

**This contradicts the user's "no more admin token" line.** We push back: the
"admin token" the user wants to delete is the *bearer the browser knows*. We're
deleting that. What we keep is the *HttpOnly cookie* the browser cannot
read, which protects the UI server's own endpoints. The user's stated goal
(simplicity, no admin token in JS, no admin toggle button) is fully met.

**What goes away:** `Authorization: Bearer <admin-token>` header pattern,
`x-admin-token` header pattern, the `ADMIN_TOKEN` env var as a user-facing
credential, the `OP_UI_TOKEN` and `OP_ASSISTANT_TOKEN` env vars, `assistantToken`
field on `ControlPlaneState`, the wizard "show me the admin token" UI.

**What stays:** `op_session` cookie, `requireAdmin()`, the broker.
`requireAdmin()` now checks the cookie only (no token fallback). The login
endpoint (`packages/ui/src/routes/admin/auth/session/+server.ts`) keeps its
current shape but compares against a `OP_UI_LOGIN_PASSWORD` (renamed from
`ADMIN_TOKEN`) instead of a token, and issues the same `op_session` cookie.

### D3. Ephemeral local OpenCode: in, with strict lifecycle.

**Decision:** Implement the ephemeral local OpenCode as one entry in the
connections list, spawned by Electron at startup, killed at quit. Per-launch
random 32-byte password set via `OPENCODE_SERVER_PASSWORD` in spawn env.

**Spec:**

| Concern | Mechanism |
|---|---|
| Auth | Per-launch random 32-byte password, set in spawn env. Never written to disk. Never logged. Sent via `process.env` to `createOpencodeServer()`. |
| Port | Bind 127.0.0.1 only. Port 0 (kernel-assigned), parse stdout for actual port. |
| Plugins | Admin tools staged to `${HOME}/.local/state/openpalm/admin-opencode/` at Electron startup. `opencode.json` written with `plugin: ["@openpalm/admin-tools-plugin"]`. Same pattern as `packages/cli/src/lib/opencode-subprocess.ts:45-77`. |
| Logging | OpenCode writes its own session log + per-tool invocation record at `${OP_HOME}/data/admin-opencode/log/`. That IS the audit trail. No OpenPalm-side `appendAudit` wrapping. |
| Lifecycle (clean) | `app.on('will-quit')` sends SIGTERM, 5s grace, SIGKILL. PID written to `data/local-opencode.pid` at spawn. |
| Lifecycle (crash) | At Electron startup, read `data/local-opencode.pid`; if PID exists and is the wrong cmdline (or doesn't exist), unlink and continue. If it IS our process, kill it (we crashed last time without cleanup). |
| Connection-list entry | Synthesized at runtime by the UI server. Electron writes `data/local-opencode.runtime.json` (0600) with `{url, username, password, pid}` at spawn; the UI server reads it when building the endpoint list and the broker reads it per request when the active endpoint is the local one. File is unlinked at Electron quit. NOT persisted to `config/endpoints.json`. Marked `isLocal: true, isDefault: false`. Cannot be deleted or edited by the user. |
| Broker integration | The same broker (`/proxy/assistant/[...path]`) routes to the local OpenCode when its endpoint is active. No separate route; no second proxy. Browser sees one same-origin URL. |
| Not present in non-Electron | When the UI is served by `openpalm ui serve` (CLI, no Electron), `data/local-opencode.runtime.json` is absent and the local-OpenCode entry is omitted from the connection list. |

**Why per-launch random password and not "no auth on loopback":** Loopback is
not a security boundary on a multi-user host (rare for desktop, but cheap to
defend). Loopback is also not a security boundary against local malware running
as the user — but a per-launch password rotates blast radius to one process
lifetime, which is the best we can do without OS-level sandboxing.

### D4. Connection list location: `config/endpoints.json`, not `data/`.

**Decision:** Move from `data/admin/endpoints.json` to `config/endpoints.json`.

**Why config beats state:**

- It's user-owned configuration (URL, label, password). The user might want to
  edit it by hand. `config/` is the documented user-edit location per
  [`core-principles.md`](./core-principles.md#file-system).
- It must survive `data/` wipe operations (which we have — and they're
  documented as "regenerable data goes here").
- Per-user secrets (the passwords) are already in `config/auth.json`. Endpoint
  passwords belong next to provider credentials, not in service state.

**File policy:**

- Path: `${OP_HOME}/config/endpoints.json`
- Mode: 0600 (same as current `data/admin/endpoints.json`)
- Shape: unchanged — `{ activeId: string | null, endpoints: EndpointEntry[] }`
- Migration: at UI server startup, if `data/admin/endpoints.json` exists and
  `config/endpoints.json` does not, copy it across, then unlink the old.
  One-shot. No two-way sync.

### D5. The `action:api` automation path → keep, retarget at local-OpenCode.

**Decision:** Automations with `action: api` continue to work. They authenticate
to the in-container OpenCode (which is the assistant) via
`OPENCODE_SERVER_PASSWORD` (already plumbed through `stack.env`), not via
`OP_ASSISTANT_TOKEN`.

**Why:** Removing `OP_ASSISTANT_TOKEN` without a replacement breaks user
automations that exist in the wild (Report 2 confirms none in our bundled set
but user automations are out of our control). The OpenCode password is already
the right credential for this — the cron preamble in
`core/assistant/entrypoint.sh:123` is the only consumer and is easy to retarget.

**Migration:** `entrypoint.sh:123` changes from exporting `OP_ASSISTANT_TOKEN`
to exporting `OPENCODE_SERVER_PASSWORD` (already in env) under the name
automations expect (`OP_ASSISTANT_PASSWORD`, fully scoped). Document the change.

### D6a. Audit trail: OpenCode session logs are the single source of truth.

**Decision:** Delete all OpenPalm-side audit machinery. OpenCode's own session
+ tool invocation logs are the audit trail.

**Sources of truth after the refactor:**

| Activity | Where it's logged |
|---|---|
| Chat conversations + tool invocations on the assistant container | `${OP_HOME}/data/assistant/.local/state/opencode/` (OpenCode native) |
| Admin operations (compose, secrets, etc.) via local-OpenCode tools | `${OP_HOME}/data/admin-opencode/log/` (OpenCode native) |
| Channel ingress (HMAC verify, replay detection, rate limit) | `${OP_HOME}/data/logs/guardian-audit.log` (preserved — guardian's own audit) |
| UI login events (`op_session` issuance, logout) | Application stderr via `createLogger('admin.auth')` → captured by the host process logger (Electron's stderr pipe, journald in container mode). Not a separate jsonl. |
| Endpoint CRUD, setup writes | Same — operator-initiated UI actions logged at `info` via `createLogger`. |

**Why this works:**

- OpenCode records every tool call with arguments + result, every model
  request + response. That covers ~90% of what `appendAudit` was capturing.
- The remaining 10% (login events, config writes) are infrequent
  operator-initiated UI actions where the operator IS the actor; an
  application log at `info` level is sufficient.
- Guardian's audit covers external ingress and is untouched — that's
  the security boundary that needs structured tamper-evident logs.

**What goes away in this decision:**

- `packages/lib/src/control-plane/audit.ts` (the whole `appendAudit` module)
- `data/logs/admin-audit.jsonl` file format
- `/admin/audit` API route + `AuditTab.svelte` UI
- ~25 `appendAudit(state, actor, action, …)` call sites across admin routes
- The audit-related unit tests

**For incident response:** operators consult OpenCode session logs (chat +
tools), guardian-audit.log (channel ingress), and application stderr (login
events). Three sources, all with clear ownership. The previous "two
parallel audits" (`admin-audit.jsonl` + OpenCode session logs) is gone.

### D6. Backwards compatibility & migration.

**Decision:** On UI server first start under the new code, run a one-shot
migration:

1. If `OP_UI_TOKEN` is set in `stack.env` → generate a new `OPENCODE_SERVER_PASSWORD`
   (32 bytes random), write to `stack.env`, set `OPENCODE_AUTH=true`, recreate
   assistant container.
2. If `OP_ASSISTANT_TOKEN` is set → remove it from `stack.env` (it's now unused).
3. If `data/admin/endpoints.json` exists → copy to `config/endpoints.json`,
   unlink original.
4. Log a one-line summary to `data/logs/migration-0.11.0.log`.

Old installs: no UI access without re-login (the cookie semantics changed). User
re-runs through wizard or hits `/login`. We accept this UX hit.

---

## Architecture: before / after

### Before

```
Browser (UI)
    │ HttpOnly op_session cookie
    │ Bearer <admin-token>
    ▼
SvelteKit UI server (port 3880)
    │ requireAdmin()
    │ appendAudit()  ← removed in v3
    ├──────────────────┐
    │                  │
    │ HTTP fwd         │ direct docker
    │ Authorization:   │
    │ Basic :pass      │
    ▼                  ▼
OpenCode assistant     Docker socket
(container :4096)
(OPENCODE_AUTH=false today,
 password=blank)
```

### After

```
Browser (UI)
    │ HttpOnly op_session cookie (only credential the browser knows)
    │ same-origin requests to /admin/* and /proxy/assistant/*
    ▼
SvelteKit UI server (port 3880, adapter-node)
    │ requireAdmin() — cookie only, no x-admin-token fallback
    │ (no appendAudit — OpenCode session logs are the audit trail)
    ├── reads config/endpoints.json (0600) for active endpoint URL + password
    ├── reads data/local-opencode.runtime.json (0600) when local endpoint active
    ├── direct docker socket (compose, secrets, install, etc.)
    │
    │ /proxy/assistant/* broker:
    │   • adds Authorization: Basic :<endpoint-password>
    │   • streams response body through unchanged (fixed)
    │   • SSE timeout lifted for text/event-stream
    ▼
Active OpenCode endpoint (one of):
  • LOCAL ephemeral (Electron-spawned on 127.0.0.1:<random>, per-launch password)
  • Assistant container (:4096, OPENCODE_AUTH=true)
  • Remote OpenCode (user-added, HTTPS required for non-loopback)
```

Key shifts vs. before:

- Browser holds *only* `op_session`. The `x-admin-token` / `Bearer` fallback is
  gone. Zero credentials in JS.
- Dead admin proxy (`/proxy/admin/*`) removed.
- Broker fixed to stream responses (no `arrayBuffer` buffering); SSE works end
  to end.
- Local OpenCode is one of several entries in the connection list (synthesized
  from `data/local-opencode.runtime.json` at request time — the password is
  generated at spawn, not persisted to config).

---

## Phased migration plan

Each phase is shippable: tests green, no half-finished state. **Do not merge a
phase until the previous one is green on main.**

### Phase 0 — Prep (no behavior change)

- Add `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` plumbing to the
  guardian env block in `.openpalm/config/stack/core.compose.yml:120-127`. Today
  guardian reads these in `core/guardian/src/forward.ts:25-30` but the compose
  block doesn't set them. (Report 2 finding.)
- Add migration log path constant `data/logs/migration-0.11.0.log`.
- Add `config/endpoints.json` to the file-permissions test suite (mode 0600).
- Add a CSP middleware in `packages/ui/src/hooks.server.ts` setting
  `script-src 'self'; object-src 'none'; frame-ancestors 'none'`. Verify the
  Svelte 5 app builds without inline scripts (Vite emits external chunks; we're
  fine).

### Phase 1 — Fix the streaming bug; delete the dead admin proxy

- Patch `packages/ui/src/routes/proxy/assistant/[...path]/+server.ts` (~5
  changed lines): replace `await upstream.arrayBuffer()` with
  `return new Response(upstream.body, …)`. Lift the 150s `AbortSignal.timeout`
  for requests where the upstream response is `content-type: text/event-stream`
  (no client-side timeout for streams; rely on TCP keepalive + client abort).
- Delete `packages/ui/src/routes/proxy/admin/[...path]/+server.ts` (71 LOC,
  zero callers, references unset env var `OP_ADMIN_OPENCODE_INTERNAL_URL`).
- Remove the now-unused `OP_ADMIN_OPENCODE_INTERNAL_URL` documentation, if any.
- Add streaming integration test: chat completion through the broker yields
  incremental SSE events (not one buffered chunk).
- Update `docs/technical/api-spec.md` to remove the `/proxy/admin/*` route
  family. Leave `/proxy/assistant/*` documented as the broker.

### Phase 2 — Tighten `requireAdmin`: cookie only

- Remove the `x-admin-token` / `Bearer` fallback in
  `packages/ui/src/lib/server/helpers.ts:77-128`. `requireAdmin()` checks
  `op_session` only.
- Update the login endpoint
  (`packages/ui/src/routes/admin/auth/session/+server.ts`) to compare against
  `OP_UI_LOGIN_PASSWORD` (env) instead of `ADMIN_TOKEN`. Same cookie issuance
  semantics; just a rename and a removed fallback.
- Add CSP middleware in `packages/ui/src/hooks.server.ts` (~20 LOC):
  `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`.
  Verify the SvelteKit build emits no inline scripts that would need
  `'unsafe-inline'`; adapter-node does, by default.
- Tests: route smoke tests confirm 401 without cookie, 200 with cookie, 401
  with `x-admin-token` (legacy fallback removed).

### Phase 3 — Ephemeral local OpenCode (Electron only)

- New: `apps/electron/src/local-opencode.ts` (~180 LOC). Spawn, lifecycle, pidfile
  sweep. Imports `createOpencodeServer` from `@opencode-ai/sdk`. Random password,
  port 0, env injection. Writes `data/local-opencode.runtime.json` (0600) with
  `{url, username, password, pid}` at spawn; unlinks at quit.
- New: `packages/admin-tools-plugin/` package (or reuse `packages/assistant-tools/`
  with a `mode: admin` flag). Tools: `compose.up`, `compose.down`, `compose.ps`,
  `secrets.set`, `secrets.get`, `endpoints.list`, etc. No audit wrapping —
  OpenCode logs the tool invocation itself.
- Broker integration: `packages/ui/src/lib/server/endpoints.ts` synthesizes the
  local entry by reading `data/local-opencode.runtime.json` when present. The
  existing broker route picks up `endpoint.password` per request unchanged —
  no proxy code changes.
- Tests: Electron integration test for spawn → tool call → quit cleanup.

### Phase 4 — Delete the old token system

- Delete `OP_UI_TOKEN`, `OP_ASSISTANT_TOKEN` from:
  - `packages/lib/src/control-plane/types.ts` (`adminToken`, `assistantToken` fields)
  - `packages/lib/src/control-plane/lifecycle.ts:37-83`
  - `.openpalm/config/stack/core.compose.yml:66`
  - `core/assistant/entrypoint.sh:123` (replace with `OPENCODE_SERVER_PASSWORD`)
  - wizard token-display UI (`packages/ui/src/routes/setup/+page.svelte` token block)
- Delete `packages/ui/src/lib/components/AuthGate.svelte` (~120 LOC) — the
  admin/non-admin toggle is gone. Connection switcher replaces it.
- Confirm no remaining `x-admin-token` references in `packages/ui/src` outside
  of test files exercising the (removed) fallback. Update the tests in
  `packages/ui/src/lib/server/helpers.vitest.ts` to assert rejection instead
  of acceptance.

### Phase 5 — Move endpoints.json from data/ to config/

- `packages/ui/src/lib/server/endpoints.ts:38-40`: change `endpointsPath()` to
  use `getState().configDir` instead of runtime data paths.
- Add one-shot migration on first read (D6 step 3).
- Update `core-principles.md` filesystem table to show `config/endpoints.json`.

### Phase 6 — Tighten

- Enforce HTTPS for non-loopback endpoint URLs in
  `packages/ui/src/lib/server/endpoints.ts` `normalizeEndpointUrl()`. Reject
  `http://` for any host that is not `127.0.0.1`, `localhost`, or `::1`.
  Show a UI warning at endpoint-add time.
- Add a "rotate password" button per endpoint that PUTs a new password to the
  remote OpenCode (if reachable) and writes locally. Useful after suspected
  compromise.
- Delete the `/admin/audit` route + `AuditTab.svelte` + all `appendAudit` call
  sites + the `data/logs/admin-audit.jsonl` writer. Operators consult OpenCode
  session logs under `${OP_HOME}/data/{assistant,admin-opencode}/` for chat +
  tool history.

---

## Code-to-delete inventory

LOC are approximate (from Report 2 plus my read-through).

| Path | LOC | Reason |
|---|---:|---|
| `packages/ui/src/routes/proxy/admin/[...path]/+server.ts` | ~71 | Dead — `OP_ADMIN_OPENCODE_INTERNAL_URL` never set; zero callers. |
| `packages/ui/src/lib/components/AuthGate.svelte` | ~120 | Admin/non-admin toggle gone. |
| `packages/ui/src/routes/admin/auth/session/+server.ts` (token path) | ~20 | Token comparison stripped; password comparison stays. |
| `packages/ui/src/lib/server/helpers.ts` (token fallback in `requireAdmin`/`getRawToken`) | ~50 | `x-admin-token` / Bearer fallback removed. |
| `packages/lib/src/control-plane/types.ts` (`adminToken`, `assistantToken`) | ~30 | Two fields + getters. |
| `packages/lib/src/control-plane/lifecycle.ts:37-83` (token plumbing) | ~90 | State factory token wiring. |
| `packages/lib/src/control-plane/config-persistence.ts` (token writers) | ~30 | Persisted token blocks in stack.env. |
| `packages/ui/src/routes/setup/+page.svelte` (wizard token UI block) | ~40 | Wizard no longer displays admin token. |
| Per-route `requireAdmin` token-fallback branches | ~80 | ~38 routes; just the `else if (token)` branch in each. |
| `core/assistant/entrypoint.sh:123` `OP_ASSISTANT_TOKEN` export | ~10 | Replaced by `OPENCODE_SERVER_PASSWORD` export. |
| `packages/ui/src/routes/admin/audit/+server.ts` | ~60 | Audit API route. OpenCode session logs replace it. |
| `packages/ui/src/lib/components/AuditTab.svelte` | ~150 | Audit tab UI. Operator reads OpenCode session logs directly. |
| `appendAudit` call sites across `/admin/*` routes (~25 routes) | ~75 | One call per route after auth check. |
| `packages/lib/src/control-plane/audit.ts` (`appendAudit` impl + writer) | ~80 | The whole module. Channels-sdk + guardian have their own audit and are untouched. |
| Test suites covering the above | ~450 | Whole files in some cases; rewrites in others. |
| **Total** | **~1306 (impl) / ~1756 (with tests)** | |

## Code-to-add (or change) inventory

| Path | LOC | Purpose |
|---|---:|---|
| `packages/ui/src/routes/proxy/assistant/[...path]/+server.ts` (streaming fix + SSE timeout lift) | ~5 changed | Replace `arrayBuffer()` with `upstream.body`. Lift timeout for `text/event-stream`. |
| `packages/ui/src/hooks.server.ts` (CSP block) | ~20 | `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`. |
| `apps/electron/src/local-opencode.ts` | ~180 | Spawn / lifecycle / pidfile sweep / runtime.json writer. |
| `packages/ui/src/lib/server/endpoints.ts` (local-OpenCode synthesis) | ~40 | Read `data/local-opencode.runtime.json`, prepend synthetic entry to endpoint list. |
| `packages/admin-tools-plugin/src/index.ts` | ~180 | Admin tool implementations. No audit wrapping (OpenCode logs natively). |
| `packages/admin-tools-plugin/src/opencode-plugin.ts` | ~60 | OpenCode plugin manifest. |
| Migration script `packages/lib/src/control-plane/migrate-0.11.0.ts` | ~80 | One-shot token→password + data/→config/ migration. |
| Endpoint URL validator (HTTPS enforce for non-loopback) | ~30 | In existing `endpoints.ts`. |
| Tests | ~300 | streaming broker test, local-opencode lifecycle, migration, cookie-only `requireAdmin`. |
| **Total** | **~895** | |

Net delta: **~ -861 LOC with tests; ~ -411 LOC implementation only**. We delete
~1.3k LOC of token + audit + dead-proxy machinery and spend ~895 on the
Electron spawn, admin-tools plugin, broker streaming fix, CSP middleware, and
migration. The real win is **two credentials in the system (cookie + endpoint
password) instead of five (admin token, assistant token, UI token, cookie,
endpoint password)**, **zero credentials in JS**, and **a single audit
surface (OpenCode session logs) instead of two (`admin-audit.jsonl` +
OpenCode logs)**.

---

## Security checklist (must-pass before ship)

- [ ] CSP header set in ENFORCED mode (not `Content-Security-Policy-Report-Only`): `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`. Verified in `curl -I` against a built UI. Verified zero browser-console CSP violations on a full smoke walkthrough (login → chat → endpoint switch → admin actions).
- [ ] `op_session` cookie remains HttpOnly, SameSite=Strict, Path=/, Max-Age=86400. No JS-readable equivalent introduced.
- [ ] The browser holds zero OpenCode credentials. Verified by grepping `packages/ui/src` for `Authorization`, `Basic`, `Bearer`, and `password` outside of `src/routes/proxy/`, `src/routes/admin/auth/`, and component prop names.
- [ ] `/proxy/assistant/*` rejects requests without `op_session`. Verified by integration test.
- [ ] `/proxy/assistant/*` streams responses (no `arrayBuffer` buffering). Verified by an SSE integration test that asserts incremental chunks arrive before stream end.
- [ ] OpenCode local-ephemeral spawned with `OPENCODE_AUTH=true` AND random password from `crypto.randomBytes(32).toString('base64url')`.
- [ ] OpenCode local-ephemeral binds to 127.0.0.1 only; never 0.0.0.0; verified by `ss -tlnp` smoke test.
- [ ] Local-ephemeral password lives only in `data/local-opencode.runtime.json` (0600, mode-tested) for the duration of the Electron session; never logged at any level; redaction filter in `@openpalm/lib` logger covers `OPENCODE_SERVER_PASSWORD` and `password` keys.
- [ ] `data/local-opencode.runtime.json` and pidfile at `data/local-opencode.pid` mode 0600. Cleared on Electron quit. Stale-PID sweep on next startup.
- [ ] Endpoint URLs: HTTPS enforced for non-loopback. `http://` rejected for non-`127.0.0.1`/`localhost`/`::1` with a clear error.
- [ ] `config/endpoints.json` mode 0600. Verified by repo install test.
- [ ] Local-ephemeral OpenCode writes its session/tool log to `${OP_HOME}/data/admin-opencode/log/` and that path is readable for post-incident review. Log retention policy documented in `docs/technical/`.
- [ ] OpenPalm `appendAudit` / `data/logs/admin-audit.jsonl` machinery removed in full; `grep -rn 'appendAudit\|admin-audit.jsonl' packages/ui/src packages/lib/src` returns zero hits.
- [ ] Channels-sdk and guardian paths unchanged. Verified by running existing security tests (`bun run guardian:test`). (Note: guardian keeps its own `guardian-audit.log` — that's separate from the OpenPalm admin audit and is preserved.)
- [ ] Migration script handles: existing token-based install, fresh install, partial state (token set but no endpoint file).
- [ ] No `Bearer <token>` or `x-admin-token` flows survive in admin routes (audit by `grep -rn 'Authorization.*Bearer\|x-admin-token' packages/ui/src` excluding vitest/test fixtures).
- [ ] The dead `OP_ADMIN_OPENCODE_INTERNAL_URL` variable is gone from the codebase, docs, and compose files (verified by repo-wide grep).

---

## Risks / open questions

1. **Broker as XSS-replay target** — XSS in the UI can replay broker requests
   for the lifetime of `op_session`. This is the residual risk after choosing
   the broker over JS-direct. Mitigations: CSP (no inline scripts, no eval) —
   enforced from day one, not report-only — HttpOnly+SameSite cookie, optional
   `op_session` short-TTL mode for high-sensitivity deployments. **Resolved:**
   no CSP report endpoint. The codebase has no third-party JS; violations show
   up in the browser console during dev and are fixed immediately. A report
   endpoint is dead weight for a codebase we fully control.

2. **No EventSource needed** — the SDK uses fetch+ReadableStream with
   `Authorization` headers; works through the same-origin broker without
   special handling. Resolved.

3. **`createOpencodeServer` spawn reliability** — the SDK shells out to the
   `opencode` binary via `cross-spawn`. This is the same path the existing
   CLI uses (`packages/cli/src/lib/opencode-subprocess.ts`), so the risk is
   bounded. **Open:** what happens if the binary is missing? Clear UX:
   "local OpenCode unavailable — install opencode CLI." Same failure mode
   as the wizard today.

4. **OAuth subprocess broken in OpenCode** — memory note
   [opencode-oauth-subprocess-broken.md] flags that `ensureAuthServer` spawning
   a fresh OpenCode 500s on `oauth/authorize`. Our ephemeral spawn must not be
   used as the OAuth target. **Decision:** OAuth goes to the assistant container
   only. Document this in the admin-tools-plugin README.

5. **CORS for remote endpoints** — *Not a problem in v2.* All browser traffic
   goes to same-origin `/proxy/assistant/*`. The server-to-OpenCode hop is
   server-side; no CORS preflight. Remote OpenCode instances don't need
   `--cors` for OpenPalm. (They do still need it for direct-from-browser
   tooling; we just don't use that.)

6. **Multi-tab endpoint switching — N/A.** OpenPalm UI runs in an Electron
   BrowserWindow; there is no multi-tab scenario. Active endpoint is
   server-side state read by the broker per request. **Resolved:** no
   `?endpoint=<id>` URL parameter, no per-tab pinning. If the UI ever ships in
   browser mode, the same server-side active-endpoint state works for a single
   operator — multi-tenant browser scenarios are out of scope for OpenPalm.

7. **`OPENCODE_SERVER_USERNAME` default** — OpenCode defaults to `opencode`; user
   proposed `openpalm`. We set `openpalm` explicitly in spawn env and in
   `stack.env`. Document it.

8. **OpenCode session logs are the audit trail** — no OpenPalm-side
   `appendAudit`, no `data/logs/admin-audit.jsonl`. OpenCode writes
   per-session and per-tool logs under `${OP_HOME}/data/{assistant,admin-opencode}/`;
   that's where forensics happens. The few SvelteKit endpoints that survive
   (login, endpoint CRUD, setup writes) are user-initiated UI actions where
   the operator IS the actor — application-level stderr logging via the
   existing `createLogger` is sufficient. Guardian retains its own separate
   `guardian-audit.log` for channel ingress — untouched.

9. **CLI users (non-Electron) have no local OpenCode** — by design. Document it
   in the connection-switcher UI: "Local OpenCode is only available in the
   desktop app."

10. **Future: upstream Bearer/JWT contribution** — long-term, if OpenCode
    accepts a Bearer/JWT auth mode upstream, we could shrink the broker to
    pure URL rewriting (no credential injection). Not on the critical path;
    revisit when there is upstream interest.

---

## Suggested addition to CLAUDE.md "Key Files" table

(Do NOT edit CLAUDE.md as part of this plan. Suggest the addition; the user
applies it when they accept the plan.)

| Path | Purpose |
|---|---|
| `docs/technical/auth-and-proxy-refactor-plan.md` | **Auth/proxy refactor plan (v0.11.0, v2)** — keeps the assistant proxy as a same-origin credential broker, deletes the dead admin proxy + `x-admin-token` fallback, fixes the proxy's response-buffering bug, adds Electron-spawned ephemeral local OpenCode behind the same broker. |
| `packages/ui/src/routes/proxy/assistant/[...path]/+server.ts` (after Phase 1) | Streaming credential broker — only credential boundary in the system. |
| `apps/electron/src/local-opencode.ts` (after Phase 3) | Spawn/lifecycle of ephemeral host OpenCode. |
| `packages/admin-tools-plugin/` (after Phase 3) | OpenCode plugin exposing admin tools (compose, secrets, endpoints). |
