# Portal Rich-UX Design — Guardian as a Filtering OpenCode Proxy

**Status:** Implemented (historical design record). The guardian proxy fan-out and the shared portal renderers described here have shipped — the shared code now lives in the `@openpalm/portal-sdk` package (`packages/portal-sdk/`: `oc-events.ts`, `render-turn.ts`, `OcClient`, `BasePortal`). Incorporates a three-perspective expert review (security, OpenPalm architecture, OpenCode-API correctness); §11 records what changed. File citations below were re-verified against the shipped tree on 2026-07-29.
**Scope:** Give portal conversations (Discord first, then Slack, the API portal, and future add-ons) the native OpenCode experience — live streaming output, tool-call visibility, and **interactive permission prompts** — by making the guardian a **transparent OpenCode API reverse proxy with security gates that short-circuit malicious requests**, rather than inventing a custom portal contract.
**Audience:** Implementers of the guardian proxy and the portal renderers, and reviewers of the security posture.

## 0. Design stance (why a proxy, not a contract)

An earlier draft proposed a normalized "Guardian Event Protocol" that translated OpenCode events into a portal-agnostic union. **That is rejected.** Three reasons:

1. **The UI already proves the proxy pattern.** `packages/ui/src/routes/oc/[...path]/+server.ts` authenticates, then returns `upstream.body` untouched — native streaming by *proxying* OpenCode, with an explicit comment forbidding buffering. Portals should use the same mechanism, not a parallel one.
2. **OpenCode already ships the typed contract.** `@opencode-ai/sdk` exports `Event`, `Part`, `Permission`, and `createOpencodeClient`. A custom protocol re-encodes — lossily — types that already exist, are versioned upstream, and portals can import directly. This violates "avoid complexity you cannot justify" and the no-wrappers policy in `code-quality-principles.md`.
3. **A contract makes version-coupling worse.** Per-portal rendering (OpenCode event → Discord embed/button) is identical either way; a protocol only inserts a second mapping to maintain in lockstep. One extra hop, zero capability gained.

**Therefore:** the guardian forwards native OpenCode calls and responses transparently, *except* for a small, explicit set of fail-closed security gates. Portals speak native OpenCode (via `@opencode-ai/sdk`) through the guardian. The contract is the OpenCode API; the Assistant and Guardian runtimes are exact-pinned in their tools manifests.

This design was validated against **OpenCode `1.15.13`**. The endpoint/event surface below was read from that version's OpenAPI spec, and the permission flow (§1.2) was **empirically driven end-to-end** against a live `1.15.13` server.

> **Prerequisite — permission prompts must actually fire (§1.2). VERIFIED on 1.15.13.** Whether a tool pauses with `permission.asked` depends on the assistant's permission configuration. The current assistant OpenCode config (shipped as `packages/skeleton/system/assistant/opencode.jsonc`) sets only file-read denials and `external_directory` allows — it does **not** gate tool execution, so as shipped no `permission.asked` fires. Adding `"permission": { "bash": "ask" }` (etc.) makes the gate work: this was driven end-to-end against a live 1.15.13 server (tool blocked → `permission.asked` → reply → resume). The remaining work is configuration, not an upstream unknown — see §1.2.

---

## 1. The OpenCode API surface (validated, live)

The endpoints a portal turn needs. Two items corrected from the live spec are flagged **[corrected]**.

| Endpoint | Notes |
|---|---|
| `POST /session` | Create a session → `Session` object incl. `id`. Guardian **rewrites** the body to set the title (§3.4). |
| `GET /session`, `GET /session/{id}`, `DELETE /session/{id}` | List / inspect / delete. `GET /session` is filtered to the principal's own sessions (§3.4). |
| `POST /session/{id}/message` | **Blocking** turn → `{ info, parts[] }` (today's path; kept for buffered portals). |
| `POST /session/{id}/prompt_async` | **Non-blocking** turn. **Returns `204 No Content` — no body, no `messageID`.** `messageID` is an *optional request* field; the client must supply it to correlate (§4.2). **[corrected]** |
| `GET /event` | SSE (`text/event-stream`) of the `Event` union for the assistant instance — all sessions multiplexed; optional `directory`/`workspace` query params scope it (omit for full-instance). Each *session* event carries `sessionID` **nested at `event.properties.sessionID`** (§1.1). **[corrected]** |
| `POST /permission/{requestID}/reply` | **Current** permission reply: `{ "reply": "once"\|"always"\|"reject", "message"? }` → `boolean`. **Keyed by `requestID`, not `sessionID`** — authz implication in §3.4. **[corrected]** |
| `POST /session/{id}/permissions/{permissionID}` | **Deprecated** (`{response}`) — do **not** use; prefer the `requestID` reply above. **[corrected]** |
| `POST /session/{id}/abort` | Stop an in-flight turn → `boolean` (maps to a "stop" button). |

Endpoints a portal must **never** reach (default-deny covers all unlisted): `/session/{id}/shell`, `/session/{id}/command`, `/session/{id}/pty…`, `/session/{id}/share`, `/session/{id}/fork`, `/session/{id}/revert`, `/session/{id}/message/{id}/part/{id}` (PATCH/DELETE), file-edit endpoints, `/tui/*`, `/experimental/*`, `/global/event`.

### 1.1 Event frame structure and the union members the renderer reads

Every SSE frame is a JSON object `{ "type": "<name>", "properties": { … } }`. **`sessionID`, when present, lives at `event.properties.sessionID`** (for `permission.asked`, `properties` *is* the `PermissionRequest`, whose `sessionID` field is read the same way).

| OpenCode event | `properties` fields | Carries sessionID? |
|---|---|---|
| `message.part.delta` | `sessionID, messageID, partID, field, delta` | yes |
| `message.part.updated` | `sessionID, part, time` | yes |
| `permission.asked` | `PermissionRequest` (incl. `id`, `sessionID`, `permission`, `patterns`, `metadata`, `always`, `tool:{messageID,callID}`) | yes |
| `permission.replied` | `sessionID, requestID, reply` | yes |
| `session.idle` | `sessionID` | yes — turn-end signal (but see note) |
| `session.status` | `sessionID, status` where **`status` is an OBJECT `{ type: "busy" \| "idle" }`** (not a bare string — verified live 2026-06-04) | yes — **the live turn busy/idle signal observed on 1.15.13** |
| `session.error` | `sessionID, error` | yes |
| `server.connected`, `server.heartbeat`, `installation.*`, `server.instance.disposed`, … | no `sessionID` | **no** |

The last row is load-bearing for filtering: **global events carry no `sessionID` and must never be forwarded to a portal** (§3.2). Confirmed live on 1.15.13: `server.heartbeat` and `server.connected` arrive with `properties: {}` (no `sessionID`).

> **Turn-end signal nuance — PINNED against a live 1.15.13 server (2026-06-04).** Both signals fire at turn boundaries: a `session.status` frame whose **`status` is the object `{ type: "idle" }`** *and* a standalone `session.idle`. (Earlier runs saw `session.status` without a `session.idle`; the verified run saw both — so the renderer must accept either.) **Critical shape correction:** `session.status.status` is an **object `{ type: "busy" | "idle" }`, not a bare string** — code that does `typeof status === "string"` will never detect turn-end. Turn-end = `session.idle` **or** `session.status` with `status.type === "idle"`. This is implemented in `packages/portal-sdk/src/oc-events.ts` (`statusName()` + `TURN_IDLE_STATUSES`, tolerating both object and string shapes) and reused by the guardian fan-out's turn-accounting.

**Richer streaming family (new in 1.15.13).** Beyond `message.part.delta`, 1.15.13 adds a fine-grained `session.next.*` event family — `session.next.text.delta`, `session.next.tool.called`, `session.next.tool.input.delta`, `session.next.tool.progress`, `session.next.reasoning.delta`, `session.next.step.started/ended`, etc. These give the portal renderers a cleaner, lower-latency stream than diffing `message.part.updated` snapshots; prefer them where available (they did not exist on 1.3.3). All carry `sessionID` and filter identically (§3.2).

`ToolPart.state` is one of `ToolStatePending|Running|Completed|Error`, each with `status` plus `input`/`title`/`output`/`error` — enough to render a live tool-call card.

### 1.2 Making permissions fire — VERIFIED on 1.15.13

`prompt_async`/`message` still accept a deprecated `tools` map (*"tools and permissions have been merged, you can set permissions on the session itself now"*). Whether a tool emits `permission.asked` is governed by the **`permission` config**, not a per-turn flag. The config schema (1.15.13) is:

```jsonc
"permission": "ask" | "allow" | "deny"        // global default, OR an object:
"permission": {
  "bash": "ask",            // also: read, edit, glob, grep, list, task, external_directory
  "edit": "ask",            // each value is an action, or an object of pattern → action
  "bash": { "echo *": "allow", "*": "ask" }   // pattern form
}
```

**Empirical proof (live 1.15.13 server, `permission: { "bash": "ask" }`):**
1. A turn instructing the model to run a bash command produced a `tool` part stuck in `state.status = "running"` — execution genuinely paused.
2. A `permission.asked` event fired carrying the full `PermissionRequest`: `{ id: "per_…", sessionID, permission: "bash", patterns: ["echo hello-from-tool"], always: ["echo *"], tool: { messageID, callID } }`. `GET /permission` listed the same pending request.
3. `POST /permission/{id}/reply` with `{ "reply": "once" }` returned `200 true`; the tool advanced to `state.status = "completed"` with `output: "hello-from-tool\n"`, and `GET /permission` returned `[]`.

So the headline feature is **not** blocked upstream — it needs only a `permission` config that gates the relevant tools (`bash`, `edit`, `task`, …) to `"ask"`. Two consequences for OpenPalm:
- The shipped assistant OpenCode config (`packages/skeleton/system/assistant/opencode.jsonc`, materialized at `OP_HOME/system/assistant/`) must add a `permission` policy for tools we want a human to approve (a separate, deliberate change — out of scope for this doc, tracked for Stage 4).
- The `always` array in the request (e.g. `["echo *"]`) is exactly what an **"Always"** button maps to (`reply: "always"`).

---

## 2. Architecture: the filtering proxy

```
Portal adapter (uses @opencode-ai/sdk against the guardian proxy base URL)
   │  native OpenCode calls, each HMAC-signed (method+path+query+SHA256(body)+nonce+timestamp+userId)
   ▼
Guardian reverse proxy  ── short-circuit on any failed gate (4xx) ──►  ✗
   │  gates pass → forward transparently to assistant; stream response body back
   ▼
Assistant (OpenCode :4096)   — server-to-server, inside the Docker network, no socket
```

The guardian is ~95% a byte-for-byte reverse proxy (the UI proxy pattern). The remaining 5% is six fail-closed gates, applied per request:

1. **Authentication** — per-call HMAC, `userId` inside the signed material (§3.1).
2. **Endpoint allowlist** — default-deny, precise path matching (§3.3).
3. **Session/permission-ownership authorization** — a principal may only touch sessions it created and permission requests it was shown (§3.4).
4. **Content moderation** — screen prompt-bearing bodies, fail-closed (§3.5).
5. **`/event` filtering** — forward only frames whose `sessionID` the principal owns; never forward global (no-`sessionID`) frames (§3.2).
6. **Rate limiting & resource bounds** (§3.6).

Only gates 4 and 5 look *inside* OpenCode payloads; the rest operate on method/path/headers. Those two (plus the allowlist paths) are the only OpenCode-schema couplings, all pinned and drift-guarded (§5).

### 2.1 The principal

A **principal** is `(portal, userId)` — the identity the portal already authenticates. The per-portal HMAC secret authenticates the portal; `userId` (e.g. `discord:123`) scopes ownership within it. The trust boundary is the portal process: a portal holding its secret asserts `userId` for its users (exactly as today). The guardian binds every created session and every relayed permission `requestID` to its principal and authorizes later calls against those bindings.

### 2.2 Code placement (and why not `@openpalm/lib`)

A reviewer suggested extracting the proxy/allowlist/ownership logic into `@openpalm/lib`. **We deliberately do not.** The guardian (`packages/guardian`, Bun; image assets in `containers/guardian`) is built as a minimal image that depends only on its local runtime deps — the Docker dependency-resolution pattern in `CLAUDE.md` keeps `@openpalm/lib` (a CLI/UI control-plane package) out of the guardian and portal images on purpose. Forcing a lib dependency would *add* build complexity, not remove it. Correct homes:

- **Shared, pure, portal+guardian:** request signing/verification primitives and the allowlist path-matcher. These now live as guardian-local and adapter-local helpers (`packages/guardian/src/crypto.ts`, `packages/guardian/src/oc-path.ts`) rather than in the shared `packages/portal-sdk` package.
- **Guardian-only runtime state:** the session/permission ownership (`packages/guardian/src/ownership.ts` + `state-db.ts`) and `/event` fan-out (`event-fanout.ts`) → local to `packages/guardian`, mirroring its existing `rate-limit.ts` (*also* guardian-local, not in lib). This is consistent with the established structure, not a violation of it.
- The UI proxy and the guardian proxy share only the *idea*; a generic "proxy helper" that both consume would conflate two different auth models (operator cookie vs. per-portal HMAC) and is rejected. At most, a tiny pure `forwardStreaming(targetUrl, method, headers, body, signal) → Response` could be shared, but each side keeps its own gates.

---

## 3. The gates in detail

### 3.1 Authentication — per-principal auth with scoped `userId`

The shipped model uses per-principal Basic auth (`PRINCIPAL_ID` + `PRINCIPAL_SECRET_FILE`) plus guardian ownership checks. This section describes the older per-call HMAC design that was evaluated before the current principal-authenticated `/oc/*` model landed.

```
signed = METHOD "\n" PATH+QUERY "\n" SHA256(body) "\n" nonce "\n" timestamp "\n" userId
x-portal-signature = HMAC-SHA256(portal_secret, signed)
```

`nonce`, `timestamp`, and `userId` also ride as headers for the verifier to reconstruct the string, but verification uses the **signed** copy. **A request that changes `userId` while reusing another field's signature must fail** — this is a required unit test. Because the portal secret is shared across a portal's users, this prevents one user replaying another's signed call with a swapped `userId` (security review F1).

- **Discrete POSTs** (`prompt_async`, `message`, `/permission/{id}/reply`, `abort`, `session` create, `DELETE`): sign line+body; replay-protected by nonce+timestamp as today.
- **The SSE `GET /event`:** no body; sign with `SHA256("")`. It is **one** authenticated GET; replay protection covers the open handshake. The held-open stream is not re-validated per frame — its safety comes from the ownership filter (§3.2), not per-frame auth.
- **Permission replies use fresh per-call signing** with a new nonce/timestamp — never the nonce from the originating `prompt_async` (which may be long expired by the time a tool pauses). Stated explicitly to prevent an implementer reusing it.

The older `signPayload`/`verifySignature` proposal is superseded by the current principal-authenticated guardian ingress model.

### 3.2 `/event` ownership filtering — the gate that forbids pure transparency

`GET /event` multiplexes events for *all* sessions of the assistant instance. A byte-for-byte proxy would leak one principal's tokens, tool output, and permission requests to another — a held-open cross-tenant breach. The guardian **must** parse the stream and forward only owned frames.

- **Parse-and-filter, not translate.** Read `event.properties.sessionID`; if it is a non-empty string owned by the requesting principal, forward the **raw, unmodified frame**; otherwise drop. The portal still receives native `@opencode-ai/sdk` `Event` objects.
- **Hard drop rule (security review F2a):** if `event.properties.sessionID` is absent, `null`, or not a non-empty string — **drop.** Do not rely on `Map.has(undefined)` returning false. Global events (`server.*`, `installation.*`, …) thus never reach a portal. Tested with a synthetic frame that has no `sessionID`.
- **Ordering eliminates the creation race (security review F2b):** the portal does `POST /session` → guardian records ownership **synchronously on the create response** → only then does the portal `prompt_async`. Since message/tool events for a turn cannot precede its `prompt_async`, they cannot precede ownership being recorded. A dropped early `session.created` frame is harmless (the portal already has the id from the create response). No sentinel reservation needed.
- **Fan-out:** the guardian holds **one** upstream `/event` subscription and fans filtered frames to each connected principal stream, keyed by owned `sessionID`s. (Per-principal upstream subscriptions are the fallback if the assistant limits concurrent SSE subscribers, but they still each receive all sessions and still require the same filter — so single-upstream is preferred.)
- **Assistant restart mid-stream (security review, medium):** if the upstream `/event` drops (assistant restart), the guardian broadcasts a synthetic `session.error` to every open principal stream **before** attempting resubscribe, so portals tear down orphaned interactive controls (e.g. Discord permission buttons whose `requestID` is now invalid → a later reply would 404). The guardian must translate an upstream-4xx on a stale permission reply into a clean portal-visible error.

### 3.3 Endpoint allowlist — default-deny, precise matching

A static allowlist of `(method, pathTemplate)`. Anything unmatched → `403`. Matching must be hardened (security review F3):

1. **Decode** percent-encoding first; reject invalid encoding.
2. **Normalize** per RFC 3986 (collapse `//`, resolve dot-segments); **reject** any path that differs from its pre-normalization form (catches traversal/`%2e%2e`).
3. **Match** anchored templates where `{id}` is `[A-Za-z0-9_-]+` (**no slashes**), so `GET /session/{id}` cannot match `GET /session/abc/shell`.
4. **Method** compared case-sensitively (RFC 7230).

Allowed set:

```
POST   /session                              # body rewritten (title) → §3.4
GET    /session                              # response filtered to own sessions → §3.4
GET    /session/{id}                         # own only
DELETE /session/{id}                         # own only
POST   /session/{id}/message                 # prompt screened → §3.5
POST   /session/{id}/prompt_async            # prompt screened → §3.5
GET    /event                                # filtered → §3.2
POST   /permission/{requestID}/reply         # own requestID only → §3.4
POST   /session/{id}/abort                   # own only
```

Everything else denied. Dedicated deny-tests: `/shell`, `/pty`, `/share`, `/fork`, `/command`, file edit, `/global/event`, and each traversal/encoding vector above.

### 3.4 Session- and permission-ownership authorization

- **Session create rewrites the body (security review F5a):** on `POST /session` the guardian **constructs** the body itself — `{ title: "${portal}:${sessionKey}" }` — and **discards** any client-supplied title/body. `sessionKey` derives from validated metadata as today (session-title construction lives in `packages/guardian/src/proxy.ts`; the old `forward.ts` and its `session-target.ts` successor were both deleted), but the portal can no longer inject an arbitrary session title (a prompt-injection / moderation-bypass surface). It then records `sessionId → principal` (TTL mirroring the existing session cache; pruned on delete/TTL/hard-cap).
- **Session calls** (`GET/DELETE /session/{id}`, `message`, `prompt_async`, `abort`): assert the principal owns `{id}`, else `403`. Replaces the implicit server-side derivation with an explicit ownership check — same isolation guarantee.
- **`GET /session`** response is filtered to the principal's own sessions (the raw list must not leak other principals' titles).
- **Permission replies are ownership-checked by `requestID` (API review, authz consequence of the corrected endpoint):** because `POST /permission/{requestID}/reply` is keyed by `requestID` (not `sessionID`), the guardian records `requestID → principal` **when it relays the `permission.asked` frame** to that principal, and authorizes the reply against that record. Prevents principal A answering principal B's permission request.
- **Session-id entropy assumption (security review, medium):** ownership is only as strong as the unguessability of OpenCode session ids. Implementation note: assert OpenCode ids are ≥128-bit unguessable (not a timestamp-ordered prefix an attacker can narrow); if not, ownership must also gate `GET /session/{id}` reads against the map (it already does) and never rely on id secrecy alone.

### 3.5 Content moderation — screen prompt bodies; output is out of scope

- When `GUARDIAN_CONTENT_VALIDATION=true`, the guardian parses `POST …/message` and `…/prompt_async` bodies, extracts `parts[].text`, runs the existing heuristic screen → local moderator (fail-closed), forwards only on pass. This is the one request-body schema coupling (pinned, drift-guarded).
- **Write-path only; output is explicitly out of scope (security review F5b).** Moderation screens what the portal *sends*. Responses and `GET /session/{id}` bodies are forwarded transparently and are **not** screened — the assistant is the trust boundary for its own output. Stated so implementers neither assume output is screened nor add accidental response-body inspection. (Session titles can no longer carry injected content because the create body is rewritten — §3.4.)

### 3.6 Rate limiting & resource bounds

- Per-user (≈120/min) and per-portal (≈200/min) limits **count discrete signed calls**; a `GET /event` open counts as one.
- **Separate `/event` reconnect limit (security review F4):** cap reconnects (e.g. ≤10/min/principal) so a reconnect loop (mobile, gateway flaps) or an adversary cannot churn nonces and pressure the replay store into evicting still-valid nonces. The nonce store keeps its hard cap; this bounds the dominant new pressure on it.
- **Concurrent `/event` streams per principal:** at most 1 (configurable to a small N); a second open is rejected `429` — the portal must close the first. Prevents unbounded held-open streams.
- **In-flight turns** per principal capped; **per-turn wall-clock cap** triggers `POST /session/{id}/abort` on breach. Ownership/stream/permission maps each get a hard size cap (existing discipline).
- Concrete values are deferred to implementation and must be defined as named constants with rationale (and surfaced on the guardian stats endpoint), per `code-quality-principles.md`.

---

## 4. Per-portal rendering (native events, no contract)

Each adapter holds a persistent filtered `/event` subscription via the guardian, consumes native `@opencode-ai/sdk` `Event`/`Part`/`Permission` objects, and renders per platform.

### 4.1 Discord (`edit`-style streaming, interactive)
- Start a turn: post a placeholder (or `deferReply`), `prompt_async` (see §4.2 for correlation).
- `message.part.delta`/`updated` (TextPart): edit the placeholder with accumulated text, throttled (~1 edit / 750–1500 ms — Discord edit limits); finalize and roll to a new message past 2000 chars (existing `splitMessage`, applied incrementally).
- `message.part.updated` (ToolPart): post/edit an **embed**, colored by `state.status`.
- `permission.asked` (if firing — §1.2): **ActionRow** (Approve / Always / Deny), restricted to the requesting `user.id`; on click, `POST /permission/{requestID}/reply` with `{reply}` through the guardian (signed, ownership-checked by `requestID`).
- "Stop" button → `POST /session/{id}/abort` through the guardian.

### 4.2 Streaming correlation (API review, HIGH — avoids dropped first tokens)
Because `prompt_async` returns `204` with no `messageID`, and `/event` is global, the turn must be correlated deterministically:
1. The portal's filtered `/event` subscription is **already open** (it is persistent per principal) — so no event can arrive before a subscriber exists.
2. The portal **generates a `msg_…` `messageID`** and passes it in the `prompt_async` body (OpenCode accepts a client id for the *user* message; `generateMessageId()` uses the `msg_` convention).
3. The portal filters incoming frames **by `sessionID` only** — *not* by that `messageID` — rendering deltas until the session's turn-end signal (`session.idle`, or `session.status` whose `status.type === "idle"` — §1.1). Prefer the `session.next.*` deltas where present (1.15.13+) over diffing `message.part.updated` snapshots.

> **Correction — pinned by live capture (2026-06-04).** The original plan filtered frames by the client-supplied `messageID`. **That is wrong:** OpenCode assigns the *assistant's reply* its **own server-generated `msg_…` id** (the client id appears only on the echoed *user* message), so filtering deltas by the client id drops the entire assistant stream. Correlation is therefore **by `sessionID`**, which is sound because (a) the portal's `ConversationQueue` serialises turns per `sessionKey` so only one turn streams per session at a time, and (b) the guardian already ownership-filters `/event` by `sessionID`. The client `messageID` is still sent (harmless, and correlates the user message) but is **not** a render filter. Implemented in `oc-events.ts` `extractTextDelta(e, sessionId)`.

This removes the subscribe-after-prompt race entirely and renders against a stable, server-trustworthy correlation key (the session) without relying on a response body.

### 4.3 Slack (`chat.update` streaming, interactive)
Same flow via Block Kit buttons; 4000-char splitting; thread continuation. Same correlation (§4.2) and permission path.

### 4.4 API portal (OpenAI/Anthropic, non-interactive)
- Honor `stream: true` (today rejected): map `message.part.delta` → OpenAI `chat.completion.chunk` / Anthropic `content_block_delta` SSE; `stream:false` buffers to today's JSON.
- **Permissions are non-interactive → policy-driven, fail-closed (§4.5).**

### 4.5 Permission policy for non-interactive portals
No human is present to click. Each portal declares a policy the adapter applies on `permission.asked`:
- Default (non-interactive): **reject** — deny tools needing approval; the assistant continues or reports it could not act. *Safer than today*, where static config silently allows/denies with no audit.
- Opt-in: `auto: once` with an explicit tool allowlist for trusted programmatic clients — a deliberate, configured relaxation, never a default.
- Either way the decision is a normal signed, ownership-checked `POST /permission/{requestID}/reply`; the guardian stays the sole mediator.

---

## 5. Version coupling & fail-closed drift guard

The guardian couples to OpenCode at exactly **three** pinned points: the allowlist paths (§3.3), `event.properties.sessionID` on session events (§3.2), and the `message`/`prompt_async` prompt-body shape (§3.5). The exact `opencode-ai` runtime pins live in `containers/assistant/tools/package.json` and `containers/guardian/tools/package.json` and must remain in lockstep.

- **Startup assertion is fail-closed for the proxy path (security review, low):** on boot the guardian fetches the assistant `/doc` and asserts the allowlisted paths and the two payload shapes exist. On drift or fetch failure it **disables the proxy route and returns `503`** there (with a clear log); the legacy buffered `/portal/inbound` path stays up. Not a warning-only path.
- The `/event` filter **ignores unknown event types** and tolerates added fields — an OpenCode bump degrades gracefully rather than breaking portals.
- **Bumping the OpenCode runtime pins is a stack-wide operation** — Assistant and Guardian images move in lockstep, and SDK/plugin consumers must be checked for compatibility. Current source locations are in **Appendix B**.

---

## 6. Security analysis — invariants preserved

Mapped to `docs/technical/core-principles.md`:

| Invariant | How it holds |
|---|---|
| **Guardian-only ingress** | Every portal→assistant call (incl. permission reply, abort, `/event` open) transits the guardian, HMAC-signed with signed `userId` + nonce/timestamp replay protection. |
| **Assistant isolation** | Guardian↔assistant calls and the `/event` subscription are server-to-server inside the Docker network. Assistant still has no Docker socket. |
| **HMAC / replay / rate-limit** | Per signed call (§3.1, §3.6), with a dedicated `/event` reconnect limit. |
| **Content moderation (fail-closed)** | Screens prompt bodies before forwarding (§3.5); write-path scope stated. |
| **LAN-first** | No new host exposure; same ports. |

**Load-bearing new surfaces — each gets a dedicated test:**
1. **Endpoint allowlist** (§3.3) — deny-tests incl. traversal/encoding/trailing-slash and `GET /session/{id}` not matching `/session/{id}/shell`.
2. **`/event` ownership filter** (§3.2) — two principals prove zero cross-delivery; a no-`sessionID` synthetic frame is dropped.
3. **Session-ownership authz** (§3.4) — principal A cannot address principal B's session id on any allowlisted route.
4. **Permission-reply ownership** (§3.4) — principal A cannot answer principal B's `requestID`.
5. **Signed `userId`** (§3.1) — swapped `userId` fails verification.
6. **Interaction identity** — approve/deny bound to the requesting platform user id before the signed reply.
7. **Resource bounds** (§3.6) — concurrent-stream and in-flight-turn caps; breach triggers `abort`.

---

## 7. Backward compatibility & sunset

- The buffered path (`POST /portal/inbound` → `GuardianSuccessResponse { requestId, sessionId, answer, userId }`) stays byte-for-byte. Current adapters keep working; the proxy is **additive**.
- The proxy is served at a new base path **`/oc/*`** (resolved from the prior open question); portals opt in by speaking native OpenCode there with per-call signing.
- **Sunset stance:** the buffered path is retained until all first-party adapters (Discord, Slack, API) have migrated to `/oc/*` and field telemetry shows no legacy traffic; it is then deprecated with a release-noted grace period. No timeline is invented here — the trigger is "zero legacy traffic," tracked on the guardian stats endpoint. `HandleResult`/`GuardianSuccessResponse` are untouched (no contract change).

---

## 8. Staged implementation plan

1. **Stage 0 — Signing generalization.** `signRequest`/`verifyRequest` in `portals-sdk` (incl. signed `userId`); unit tests incl. the swapped-`userId` failure. No behavior change.
2. **Stage 1 — Guardian proxy core.** `/oc/*` route: per-call HMAC verify, allowlist (default-deny, hardened matching), session-ownership map + create-body rewrite, transparent passthrough streaming `upstream.body`. Deny-tests.
3. **Stage 2 — `/event` filtering.** Single upstream subscription, per-principal filtered fan-out by owned `sessionID`, no-`sessionID` drop rule, restart→synthetic-`session.error`. Two-principal cross-leak test.
4. **Stage 3 — Moderation extraction.** Screen `message`/`prompt_async` bodies; fail-closed; reuse existing screen+moderator.
5. **Stage 4 — Permissions.** The upstream prerequisite is **verified** (§1.2); the remaining OpenPalm step is to add a `permission` policy to the assistant config so the desired tools gate to `"ask"`. Then Discord `prompt_async` + correlation (§4.2) + throttled edits + tool embeds + ActionRow → `POST /permission/{requestID}/reply` (`{reply}`; `"always"` from the `always` array) + stop→`abort`.
6. **Stage 5 — Slack renderer** (same proxy + native events, Block Kit).
7. **Stage 6 — API portal** streaming (`stream:true`) + non-interactive permission policy.
8. **Stage 7 — Fail-closed drift guard** (startup `/doc` assertion).

Each stage ships independently; the buffered path is the safe default throughout.

---

## 9. Open questions (remaining)

- Per-call HMAC vs. a signed-handshake session token (§3.1) — leaning per-call HMAC (reuses primitives, no token lifecycle); revisit only if signing overhead on chatty turns proves material.
- Single shared upstream `/event` + fan-out vs. per-principal upstream subscriptions (§3.2) — leaning shared; confirm against assistant concurrent-SSE behavior.
- Discord/Slack edit-throttle that stays under platform rate limits while feeling live (start ~1.25 s).
- Whether to surface `reasoning` parts on portals at all (likely off by default — avoid leaking chain-of-thought).
- ~~The exact OpenCode mechanism to make tools pause with `permission.asked`~~ — **resolved** (§1.2): `permission: { bash: "ask", … }`, verified end-to-end on 1.15.13.
- ~~Exact end-of-turn condition to render against (`session.status` idle vs `session.idle`)~~ — **resolved 2026-06-04** (live `opencode/big-pickle` on 1.15.13): turn-end = `session.idle` **or** `session.status` with `status.type === "idle"` (`status` is an object `{type}`, not a string). Implemented in `oc-events.ts`; both signals observed firing.
- Whether to adopt the `session.next.*` delta family (1.15.13+) as the primary render stream vs `message.part.*` (§1.1).

---

## 10. References

- `packages/ui/src/routes/oc/[...path]/+server.ts` — the transparent streaming proxy precedent.
- `packages/guardian/src/{server,proxy,rate-limit,ownership}.ts` — current pipeline and guardian-local runtime state pattern (the old `forward.ts` and its `session-target.ts` successor were deleted; session routing and title construction live in `proxy.ts`, ownership in `ownership.ts`/`state-db.ts`).
- `packages/guardian/src/crypto.ts` — signing/verification primitives (kept guardian-local, not in a shared `portal-sdk` package).
- `packages/skeleton/system/assistant/opencode.jsonc` — assistant permission config (§1.2), materialized at `OP_HOME/system/assistant/`.
- Live OpenCode OpenAPI: `curl http://127.0.0.1:3810/doc` (assistant OpenCode published on `:3810` → container `:4096`; `:3800` is the OpenPalm UI).

## 11. Review incorporated (changelog)

Three expert reviews (security, OpenPalm-architecture, OpenCode-API) were applied; verified against the live spec where factual:
- **Signed `userId`** made a mandatory positional field, not an unsigned header (sec F1).
- **`/event` filter:** hard no-`sessionID` drop rule; global events never forwarded; creation race removed by create→record→prompt ordering; restart→synthetic `session.error` (sec F2; API review event-nesting).
- **Allowlist** path-matching hardened (decode/normalize/anchored `{id}`/reject-traversal) (sec F3).
- **Nonce pressure:** separate `/event` reconnect limit; concurrent-stream cap (sec F4).
- **Session-title injection** closed by rewriting the `POST /session` body; output screening explicitly out of scope (sec F5).
- **Permission endpoint corrected** to `POST /permission/{requestID}/reply` (`{reply}`); deprecated session-scoped variant dropped; added `requestID`→principal ownership (API review HIGH + authz follow-through).
- **Streaming correlation** (§4.2): `prompt_async` returns 204; persistent pre-subscription + client `messageID` (API review HIGH).
- **`/event` is per-instance** with optional scope params; `/global/event` is distinct and denied (API review MED).
- **Permission prerequisite** (§1.2): originally flagged as the biggest unknown; now **verified end-to-end on 1.15.13** — `permission: { bash: "ask" }` pauses the tool, `permission.asked` fires, `POST /permission/{id}/reply {reply:"once"}` resumes it. Remaining OpenPalm work is config only.
- **OpenCode bumped 1.3.3 → 1.15.13** during implementation; the surface was re-validated against 1.15.13. New since 1.3.3: the `session.next.*` fine-grained streaming family (§1.1), `session.status` as the live turn signal, `server.heartbeat` as another global no-`sessionID` event. Runtime pin locations have since moved; see Appendix B.
- **Drift guard** made fail-closed for the proxy path (sec LOW).
- **Code placement:** kept guardian-local + `portals-sdk`, **not** `@openpalm/lib` — reasoned divergence from the architecture reviewer, consistent with the guardian's minimal-dependency Docker pattern (§2.2).
- **`/oc/*` base path** chosen and a telemetry-triggered sunset stance added (arch review §7).

---

## Appendix A — Reproducing the permission verification (1.15.13)

The §1.2 proof was produced this way; re-run it to re-validate after any OpenCode bump. Needs Ollama on the host with a tool-capable model (e.g. `devstral:latest`); no Docker required.

```bash
# 1. Isolated install of the target version
export OCHOME=/tmp/oc-verify; rm -rf "$OCHOME"; mkdir -p "$OCHOME/work"
HOME=$OCHOME curl -fsSL https://opencode.ai/install | HOME=$OCHOME bash -s -- \
  --no-modify-path --version 1.15.13
BIN=$OCHOME/.opencode/bin/opencode

# 2. Minimal config: Ollama tool model + bash gated to "ask"
cat > "$OCHOME/work/opencode.json" <<'JSON'
{ "$schema": "https://opencode.ai/config.json",
  "provider": { "ollama": { "npm": "@ai-sdk/openai-compatible", "name": "Ollama",
    "options": { "baseURL": "http://127.0.0.1:11434/v1" },
    "models": { "devstral": { "id": "devstral:latest", "capabilities": { "tool": true } } } } },
  "model": "ollama/devstral",
  "permission": { "bash": "ask" } }
JSON

# 3. Serve (background), capture the global event stream
( cd "$OCHOME/work" && HOME=$OCHOME "$BIN" serve --pure --port 5599 \
  --hostname 127.0.0.1 >"$OCHOME/server.log" 2>&1 & )
sleep 4
curl -sN --max-time 180 http://127.0.0.1:5599/event >"$OCHOME/events.log" 2>&1 &

# 4. Create session, force a bash tool call (async — returns 204)
SID=$(curl -s -X POST http://127.0.0.1:5599/session -H 'content-type: application/json' \
  -d '{"title":"perm-test"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
curl -s -X POST "http://127.0.0.1:5599/session/$SID/prompt_async" -H 'content-type: application/json' \
  -d "{\"messageID\":\"msg_$(openssl rand -hex 12)\",\"parts\":[{\"type\":\"text\",
       \"text\":\"Use the bash tool to run exactly: echo hello-from-tool . Call the bash tool now. Do not explain.\"}]}"

# 5. Wait for the model, then: expect permission.asked + a pending request
grep -q permission.asked "$OCHOME/events.log"   # fires once the model calls bash
curl -s http://127.0.0.1:5599/permission         # → [{ id:"per_…", permission:"bash", always:["echo *"], … }]

# 6. Approve via the CURRENT endpoint; tool resumes to completed
PID=$(curl -s http://127.0.0.1:5599/permission | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
curl -s -X POST "http://127.0.0.1:5599/permission/$PID/reply" -H 'content-type: application/json' \
  -d '{"reply":"once"}'                           # → true ; output becomes "hello-from-tool\n"

# 7. Teardown
pkill -f "/tmp/oc-verify/.opencode/bin/opencode"; rm -rf "$OCHOME"
```

Expected: `prompt_async`→`204`; tool part `state.status="running"` until reply; `permission.asked` carries the full `PermissionRequest`; reply→`200 true`; tool→`completed`, `GET /permission`→`[]`. Global `server.heartbeat` frames (no `sessionID`) appear throughout — confirming the §3.2 filter must drop them.

---

## Appendix B — Current OpenCode Pin Locations

The 1.15.13 commands in Appendix A are historical reproduction steps. Current
release pins are source-controlled elsewhere:

| Artifact | Current source | Rule |
|---|---|---|
| Assistant OpenCode runtime | `containers/assistant/tools/package.json` | Exact `opencode-ai` version |
| Guardian OpenCode runtime | `containers/guardian/tools/package.json` | Exact `opencode-ai` version; keep equal to Assistant |
| Portal SDK wire types | `packages/portal-sdk/package.json` | Exact `@opencode-ai/sdk` version reviewed against the runtime API |
| Electron admin plugin types | `packages/electron/admin-tools/package.json` | `@opencode-ai/plugin` dependency and root lockfile |
| Assistant AKM plugin | `packages/skeleton/system/assistant/opencode.jsonc` | Exact `akm-opencode` spec in managed config |

For an OpenCode upgrade:

1. Change both exact `opencode-ai` tool-manifest pins together.
2. Review the SDK, admin plugin, and exact AKM plugin for compatibility; update
   only the consumers that need to move.
3. If a workspace dependency changed, refresh `bun.lock` and verify a frozen
   install.
4. Build both OpenCode-bearing images and exercise the proxy, content moderator,
   event filtering, and permission flow against the new runtime.
5. Deploy through the normal release and reconcile path. Do not use the retired
   manual cache-deletion or old Compose-file paths from the original design work.
