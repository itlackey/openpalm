# Channel Rich-UX Design — Guardian as a Filtering OpenCode Proxy

**Status:** Design / validation (pre-implementation). Incorporates a three-perspective expert review (security, OpenPalm architecture, OpenCode-API correctness); §11 records what changed.
**Scope:** Give channel conversations (Discord first, then Slack, the API channel, and future add-ons) the native OpenCode experience — live streaming output, tool-call visibility, and **interactive permission prompts** — by making the guardian a **transparent OpenCode API reverse proxy with security gates that short-circuit malicious requests**, rather than inventing a custom channel contract.
**Audience:** Implementers of the guardian proxy and the channel renderers, and reviewers of the security posture.

## 0. Design stance (why a proxy, not a contract)

An earlier draft proposed a normalized "Guardian Event Protocol" that translated OpenCode events into a channel-agnostic union. **That is rejected.** Three reasons:

1. **The UI already proves the proxy pattern.** `packages/ui/src/routes/proxy/assistant/[...path]/+server.ts` authenticates, then returns `upstream.body` untouched — native streaming by *proxying* OpenCode, with an explicit comment forbidding buffering. Channels should use the same mechanism, not a parallel one.
2. **OpenCode already ships the typed contract.** `@opencode-ai/sdk` exports `Event`, `Part`, `Permission`, and `createOpencodeClient`. A custom protocol re-encodes — lossily — types that already exist, are versioned upstream, and channels can import directly. This violates "avoid complexity you cannot justify" and the no-wrappers policy in `code-quality-principles.md`.
3. **A contract makes version-coupling worse.** Per-channel rendering (OpenCode event → Discord embed/button) is identical either way; a protocol only inserts a second mapping to maintain in lockstep. One extra hop, zero capability gained.

**Therefore:** the guardian forwards native OpenCode calls and responses transparently, *except* for a small, explicit set of fail-closed security gates. Channels speak native OpenCode (via `@opencode-ai/sdk`) through the guardian. The contract is the OpenCode API, pinned to `OPENCODE_VERSION`.

Validated against **OpenCode `1.15.13`** — the version now pinned in `containers/assistant/Dockerfile` and `containers/guardian/Dockerfile` (bumped from `1.3.3`). The endpoint/event surface below was read from `1.15.13`'s OpenAPI spec, and the permission flow (§1.2) was **empirically driven end-to-end** against a live `1.15.13` server.

> **Prerequisite — permission prompts must actually fire (§1.2). VERIFIED on 1.15.13.** Whether a tool pauses with `permission.asked` depends on the assistant's permission configuration. The current `.openpalm/config/assistant/opencode.jsonc` sets only file-read denials and `external_directory` allows — it does **not** gate tool execution, so as shipped no `permission.asked` fires. Adding `"permission": { "bash": "ask" }` (etc.) makes the gate work: this was driven end-to-end against a live 1.15.13 server (tool blocked → `permission.asked` → reply → resume). The remaining work is configuration, not an upstream unknown — see §1.2.

---

## 1. The OpenCode API surface (validated, live)

The endpoints a channel turn needs. Two items corrected from the live spec are flagged **[corrected]**.

| Endpoint | Notes |
|---|---|
| `POST /session` | Create a session → `Session` object incl. `id`. Guardian **rewrites** the body to set the title (§3.4). |
| `GET /session`, `GET /session/{id}`, `DELETE /session/{id}` | List / inspect / delete. `GET /session` is filtered to the principal's own sessions (§3.4). |
| `POST /session/{id}/message` | **Blocking** turn → `{ info, parts[] }` (today's path; kept for buffered channels). |
| `POST /session/{id}/prompt_async` | **Non-blocking** turn. **Returns `204 No Content` — no body, no `messageID`.** `messageID` is an *optional request* field; the client must supply it to correlate (§4.2). **[corrected]** |
| `GET /event` | SSE (`text/event-stream`) of the `Event` union for the assistant instance — all sessions multiplexed; optional `directory`/`workspace` query params scope it (omit for full-instance). Each *session* event carries `sessionID` **nested at `event.properties.sessionID`** (§1.1). **[corrected]** |
| `POST /permission/{requestID}/reply` | **Current** permission reply: `{ "reply": "once"\|"always"\|"reject", "message"? }` → `boolean`. **Keyed by `requestID`, not `sessionID`** — authz implication in §3.4. **[corrected]** |
| `POST /session/{id}/permissions/{permissionID}` | **Deprecated** (`{response}`) — do **not** use; prefer the `requestID` reply above. **[corrected]** |
| `POST /session/{id}/abort` | Stop an in-flight turn → `boolean` (maps to a "stop" button). |

Endpoints a channel must **never** reach (default-deny covers all unlisted): `/session/{id}/shell`, `/session/{id}/command`, `/session/{id}/pty…`, `/session/{id}/share`, `/session/{id}/fork`, `/session/{id}/revert`, `/session/{id}/message/{id}/part/{id}` (PATCH/DELETE), file-edit endpoints, `/tui/*`, `/experimental/*`, `/global/event`.

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

The last row is load-bearing for filtering: **global events carry no `sessionID` and must never be forwarded to a channel** (§3.2). Confirmed live on 1.15.13: `server.heartbeat` and `server.connected` arrive with `properties: {}` (no `sessionID`).

> **Turn-end signal nuance — PINNED against a live 1.15.13 server (2026-06-04).** Both signals fire at turn boundaries: a `session.status` frame whose **`status` is the object `{ type: "idle" }`** *and* a standalone `session.idle`. (Earlier runs saw `session.status` without a `session.idle`; the verified run saw both — so the renderer must accept either.) **Critical shape correction:** `session.status.status` is an **object `{ type: "busy" | "idle" }`, not a bare string** — code that does `typeof status === "string"` will never detect turn-end. Turn-end = `session.idle` **or** `session.status` with `status.type === "idle"`. This is implemented in `channels-sdk/oc-events.ts` (`statusName()` + `TURN_IDLE_STATUSES`, tolerating both object and string shapes) and reused by the guardian fan-out's turn-accounting.

**Richer streaming family (new in 1.15.13).** Beyond `message.part.delta`, 1.15.13 adds a fine-grained `session.next.*` event family — `session.next.text.delta`, `session.next.tool.called`, `session.next.tool.input.delta`, `session.next.tool.progress`, `session.next.reasoning.delta`, `session.next.step.started/ended`, etc. These give the channel renderers a cleaner, lower-latency stream than diffing `message.part.updated` snapshots; prefer them where available (they did not exist on 1.3.3). All carry `sessionID` and filter identically (§3.2).

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
- The shipped `.openpalm/config/assistant/opencode.jsonc` must add a `permission` policy for tools we want a human to approve (a separate, deliberate change — out of scope for this doc, tracked for Stage 4).
- The `always` array in the request (e.g. `["echo *"]`) is exactly what an **"Always"** button maps to (`reply: "always"`).

---

## 2. Architecture: the filtering proxy

```
Channel adapter (uses @opencode-ai/sdk against the guardian proxy base URL)
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

A **principal** is `(channel, userId)` — the identity the channel already authenticates. The per-channel HMAC secret authenticates the channel; `userId` (e.g. `discord:123`) scopes ownership within it. The trust boundary is the channel process: a channel holding its secret asserts `userId` for its users (exactly as today). The guardian binds every created session and every relayed permission `requestID` to its principal and authorizes later calls against those bindings.

### 2.2 Code placement (and why not `@openpalm/lib`)

A reviewer suggested extracting the proxy/allowlist/ownership logic into `@openpalm/lib`. **We deliberately do not.** The guardian (`containers/guardian`, Bun) is built as a minimal image that depends only on its local runtime deps — the Docker dependency-resolution pattern in `CLAUDE.md` keeps `@openpalm/lib` (a CLI/UI control-plane package) out of the guardian and portal images on purpose. Forcing a lib dependency would *add* build complexity, not remove it. Correct homes:

- **Shared, pure, channel+guardian:** `signRequest`/`verifyRequest` and the allowlist path-matcher → `packages/channels-sdk` (both already depend on it).
- **Guardian-only runtime state:** the session/permission-ownership maps and `/event` fan-out → local to `containers/guardian`, mirroring its existing `replay.ts` and `rate-limit.ts` (which are *also* guardian-local, not in lib). This is consistent with the established structure, not a violation of it.
- The UI proxy and the guardian proxy share only the *idea*; a generic "proxy helper" that both consume would conflate two different auth models (operator cookie vs. per-channel HMAC) and is rejected. At most, a tiny pure `forwardStreaming(targetUrl, method, headers, body, signal) → Response` could be shared, but each side keeps its own gates.

---

## 3. The gates in detail

### 3.1 Authentication — per-call HMAC with signed `userId`

Today: one signed envelope (`x-channel-signature` over the body). The proxy keeps the primitive but signs **each native call**, and **`userId` is a mandatory positional field in the signed string** (not an unsigned header):

```
signed = METHOD "\n" PATH+QUERY "\n" SHA256(body) "\n" nonce "\n" timestamp "\n" userId
x-channel-signature = HMAC-SHA256(channel_secret, signed)
```

`nonce`, `timestamp`, and `userId` also ride as headers for the verifier to reconstruct the string, but verification uses the **signed** copy. **A request that changes `userId` while reusing another field's signature must fail** — this is a required unit test. Because the channel secret is shared across a channel's users, this prevents one user replaying another's signed call with a swapped `userId` (security review F1).

- **Discrete POSTs** (`prompt_async`, `message`, `/permission/{id}/reply`, `abort`, `session` create, `DELETE`): sign line+body; replay-protected by nonce+timestamp as today.
- **The SSE `GET /event`:** no body; sign with `SHA256("")`. It is **one** authenticated GET; replay protection covers the open handshake. The held-open stream is not re-validated per frame — its safety comes from the ownership filter (§3.2), not per-frame auth.
- **Permission replies use fresh per-call signing** with a new nonce/timestamp — never the nonce from the originating `prompt_async` (which may be long expired by the time a tool pauses). Stated explicitly to prevent an implementer reusing it.

`signPayload`/`verifySignature` in `channels-sdk/src/crypto.ts` gain `signRequest`/`verifyRequest`; the envelope path remains for the legacy buffered endpoint.

### 3.2 `/event` ownership filtering — the gate that forbids pure transparency

`GET /event` multiplexes events for *all* sessions of the assistant instance. A byte-for-byte proxy would leak one principal's tokens, tool output, and permission requests to another — a held-open cross-tenant breach. The guardian **must** parse the stream and forward only owned frames.

- **Parse-and-filter, not translate.** Read `event.properties.sessionID`; if it is a non-empty string owned by the requesting principal, forward the **raw, unmodified frame**; otherwise drop. The channel still receives native `@opencode-ai/sdk` `Event` objects.
- **Hard drop rule (security review F2a):** if `event.properties.sessionID` is absent, `null`, or not a non-empty string — **drop.** Do not rely on `Map.has(undefined)` returning false. Global events (`server.*`, `installation.*`, …) thus never reach a channel. Tested with a synthetic frame that has no `sessionID`.
- **Ordering eliminates the creation race (security review F2b):** the channel does `POST /session` → guardian records ownership **synchronously on the create response** → only then does the channel `prompt_async`. Since message/tool events for a turn cannot precede its `prompt_async`, they cannot precede ownership being recorded. A dropped early `session.created` frame is harmless (the channel already has the id from the create response). No sentinel reservation needed.
- **Fan-out:** the guardian holds **one** upstream `/event` subscription and fans filtered frames to each connected principal stream, keyed by owned `sessionID`s. (Per-principal upstream subscriptions are the fallback if the assistant limits concurrent SSE subscribers, but they still each receive all sessions and still require the same filter — so single-upstream is preferred.)
- **Assistant restart mid-stream (security review, medium):** if the upstream `/event` drops (assistant restart), the guardian broadcasts a synthetic `session.error` to every open principal stream **before** attempting resubscribe, so channels tear down orphaned interactive controls (e.g. Discord permission buttons whose `requestID` is now invalid → a later reply would 404). The guardian must translate an upstream-4xx on a stale permission reply into a clean channel-visible error.

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

- **Session create rewrites the body (security review F5a):** on `POST /session` the guardian **constructs** the body itself — `{ title: "${channel}:${sessionKey}" }` — and **discards** any client-supplied title/body. `sessionKey` derives from validated metadata as today (`forward.ts:79-93`), but the channel can no longer inject an arbitrary session title (a prompt-injection / moderation-bypass surface). It then records `sessionId → principal` (TTL mirroring the existing session cache; pruned on delete/TTL/hard-cap).
- **Session calls** (`GET/DELETE /session/{id}`, `message`, `prompt_async`, `abort`): assert the principal owns `{id}`, else `403`. Replaces the implicit server-side derivation with an explicit ownership check — same isolation guarantee.
- **`GET /session`** response is filtered to the principal's own sessions (the raw list must not leak other principals' titles).
- **Permission replies are ownership-checked by `requestID` (API review, authz consequence of the corrected endpoint):** because `POST /permission/{requestID}/reply` is keyed by `requestID` (not `sessionID`), the guardian records `requestID → principal` **when it relays the `permission.asked` frame** to that principal, and authorizes the reply against that record. Prevents principal A answering principal B's permission request.
- **Session-id entropy assumption (security review, medium):** ownership is only as strong as the unguessability of OpenCode session ids. Implementation note: assert OpenCode ids are ≥128-bit unguessable (not a timestamp-ordered prefix an attacker can narrow); if not, ownership must also gate `GET /session/{id}` reads against the map (it already does) and never rely on id secrecy alone.

### 3.5 Content moderation — screen prompt bodies; output is out of scope

- When `GUARDIAN_CONTENT_VALIDATION=true`, the guardian parses `POST …/message` and `…/prompt_async` bodies, extracts `parts[].text`, runs the existing heuristic screen → local moderator (fail-closed), forwards only on pass. This is the one request-body schema coupling (pinned, drift-guarded).
- **Write-path only; output is explicitly out of scope (security review F5b).** Moderation screens what the channel *sends*. Responses and `GET /session/{id}` bodies are forwarded transparently and are **not** screened — the assistant is the trust boundary for its own output. Stated so implementers neither assume output is screened nor add accidental response-body inspection. (Session titles can no longer carry injected content because the create body is rewritten — §3.4.)

### 3.6 Rate limiting & resource bounds

- Per-user (≈120/min) and per-channel (≈200/min) limits **count discrete signed calls**; a `GET /event` open counts as one.
- **Separate `/event` reconnect limit (security review F4):** cap reconnects (e.g. ≤10/min/principal) so a reconnect loop (mobile, gateway flaps) or an adversary cannot churn nonces and pressure the replay store into evicting still-valid nonces. The nonce store keeps its hard cap; this bounds the dominant new pressure on it.
- **Concurrent `/event` streams per principal:** at most 1 (configurable to a small N); a second open is rejected `429` — the channel must close the first. Prevents unbounded held-open streams.
- **In-flight turns** per principal capped; **per-turn wall-clock cap** triggers `POST /session/{id}/abort` on breach. Ownership/stream/permission maps each get a hard size cap (existing discipline).
- Concrete values are deferred to implementation and must be defined as named constants with rationale (and surfaced on the guardian stats endpoint), per `code-quality-principles.md`.

---

## 4. Per-channel rendering (native events, no contract)

Each adapter holds a persistent filtered `/event` subscription via the guardian, consumes native `@opencode-ai/sdk` `Event`/`Part`/`Permission` objects, and renders per platform.

### 4.1 Discord (`edit`-style streaming, interactive)
- Start a turn: post a placeholder (or `deferReply`), `prompt_async` (see §4.2 for correlation).
- `message.part.delta`/`updated` (TextPart): edit the placeholder with accumulated text, throttled (~1 edit / 750–1500 ms — Discord edit limits); finalize and roll to a new message past 2000 chars (existing `splitMessage`, applied incrementally).
- `message.part.updated` (ToolPart): post/edit an **embed**, colored by `state.status`.
- `permission.asked` (if firing — §1.2): **ActionRow** (Approve / Always / Deny), restricted to the requesting `user.id`; on click, `POST /permission/{requestID}/reply` with `{reply}` through the guardian (signed, ownership-checked by `requestID`).
- "Stop" button → `POST /session/{id}/abort` through the guardian.

### 4.2 Streaming correlation (API review, HIGH — avoids dropped first tokens)
Because `prompt_async` returns `204` with no `messageID`, and `/event` is global, the turn must be correlated deterministically:
1. The channel's filtered `/event` subscription is **already open** (it is persistent per principal) — so no event can arrive before a subscriber exists.
2. The channel **generates a `msg_…` `messageID`** and passes it in the `prompt_async` body (OpenCode accepts a client id for the *user* message; `generateMessageId()` uses the `msg_` convention).
3. The channel filters incoming frames **by `sessionID` only** — *not* by that `messageID` — rendering deltas until the session's turn-end signal (`session.idle`, or `session.status` whose `status.type === "idle"` — §1.1). Prefer the `session.next.*` deltas where present (1.15.13+) over diffing `message.part.updated` snapshots.

> **Correction — pinned by live capture (2026-06-04).** The original plan filtered frames by the client-supplied `messageID`. **That is wrong:** OpenCode assigns the *assistant's reply* its **own server-generated `msg_…` id** (the client id appears only on the echoed *user* message), so filtering deltas by the client id drops the entire assistant stream. Correlation is therefore **by `sessionID`**, which is sound because (a) the channel's `ConversationQueue` serialises turns per `sessionKey` so only one turn streams per session at a time, and (b) the guardian already ownership-filters `/event` by `sessionID`. The client `messageID` is still sent (harmless, and correlates the user message) but is **not** a render filter. Implemented in `oc-events.ts` `extractTextDelta(e, sessionId)`.

This removes the subscribe-after-prompt race entirely and renders against a stable, server-trustworthy correlation key (the session) without relying on a response body.

### 4.3 Slack (`chat.update` streaming, interactive)
Same flow via Block Kit buttons; 4000-char splitting; thread continuation. Same correlation (§4.2) and permission path.

### 4.4 API channel (OpenAI/Anthropic, non-interactive)
- Honor `stream: true` (today rejected): map `message.part.delta` → OpenAI `chat.completion.chunk` / Anthropic `content_block_delta` SSE; `stream:false` buffers to today's JSON.
- **Permissions are non-interactive → policy-driven, fail-closed (§4.5).**

### 4.5 Permission policy for non-interactive channels
No human is present to click. Each channel declares a policy the adapter applies on `permission.asked`:
- Default (non-interactive): **reject** — deny tools needing approval; the assistant continues or reports it could not act. *Safer than today*, where static config silently allows/denies with no audit.
- Opt-in: `auto: once` with an explicit tool allowlist for trusted programmatic clients — a deliberate, configured relaxation, never a default.
- Either way the decision is a normal signed, ownership-checked `POST /permission/{requestID}/reply`; the guardian stays the sole mediator.

---

## 5. Version coupling & fail-closed drift guard

The guardian couples to OpenCode at exactly **three** pinned points: the allowlist paths (§3.3), `event.properties.sessionID` on session events (§3.2), and the `message`/`prompt_async` prompt-body shape (§3.5). All pinned to `OPENCODE_VERSION` (`containers/assistant/Dockerfile` and `containers/guardian/Dockerfile` in lockstep).

- **Startup assertion is fail-closed for the proxy path (security review, low):** on boot the guardian fetches the assistant `/doc` and asserts the allowlisted paths and the two payload shapes exist. On drift or fetch failure it **disables the proxy route and returns `503`** there (with a clear log); the legacy buffered `/channel/inbound` path stays up. Not a warning-only path.
- The `/event` filter **ignores unknown event types** and tolerates added fields — an OpenCode bump degrades gracefully rather than breaking channels.
- **Bumping `OPENCODE_VERSION` (and the akm-opencode plugin) is a stack-wide operation** — assistant + guardian images in lockstep, host npm packages, and any already-cached plugin in running containers. The full verified procedure (source pins, smoke test, live-deploy cache-clear, rollback) is **Appendix B**.

---

## 6. Security analysis — invariants preserved

Mapped to `docs/technical/core-principles.md`:

| Invariant | How it holds |
|---|---|
| **Guardian-only ingress** | Every channel→assistant call (incl. permission reply, abort, `/event` open) transits the guardian, HMAC-signed with signed `userId` + nonce/timestamp replay protection. |
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

- The buffered path (`POST /channel/inbound` → `GuardianSuccessResponse { requestId, sessionId, answer, userId }`) stays byte-for-byte. Current adapters keep working; the proxy is **additive**.
- The proxy is served at a new base path **`/oc/*`** (resolved from the prior open question); channels opt in by speaking native OpenCode there with per-call signing.
- **Sunset stance:** the buffered path is retained until all first-party adapters (Discord, Slack, API) have migrated to `/oc/*` and field telemetry shows no legacy traffic; it is then deprecated with a release-noted grace period. No timeline is invented here — the trigger is "zero legacy traffic," tracked on the guardian stats endpoint. `HandleResult`/`GuardianSuccessResponse` are untouched (no contract change).

---

## 8. Staged implementation plan

1. **Stage 0 — Signing generalization.** `signRequest`/`verifyRequest` in `channels-sdk` (incl. signed `userId`); unit tests incl. the swapped-`userId` failure. No behavior change.
2. **Stage 1 — Guardian proxy core.** `/oc/*` route: per-call HMAC verify, allowlist (default-deny, hardened matching), session-ownership map + create-body rewrite, transparent passthrough streaming `upstream.body`. Deny-tests.
3. **Stage 2 — `/event` filtering.** Single upstream subscription, per-principal filtered fan-out by owned `sessionID`, no-`sessionID` drop rule, restart→synthetic-`session.error`. Two-principal cross-leak test.
4. **Stage 3 — Moderation extraction.** Screen `message`/`prompt_async` bodies; fail-closed; reuse existing screen+moderator.
5. **Stage 4 — Permissions.** The upstream prerequisite is **verified** (§1.2); the remaining OpenPalm step is to add a `permission` policy to the assistant config so the desired tools gate to `"ask"`. Then Discord `prompt_async` + correlation (§4.2) + throttled edits + tool embeds + ActionRow → `POST /permission/{requestID}/reply` (`{reply}`; `"always"` from the `always` array) + stop→`abort`.
6. **Stage 5 — Slack renderer** (same proxy + native events, Block Kit).
7. **Stage 6 — API channel** streaming (`stream:true`) + non-interactive permission policy.
8. **Stage 7 — Fail-closed drift guard** (startup `/doc` assertion).

Each stage ships independently; the buffered path is the safe default throughout.

---

## 9. Open questions (remaining)

- Per-call HMAC vs. a signed-handshake session token (§3.1) — leaning per-call HMAC (reuses primitives, no token lifecycle); revisit only if signing overhead on chatty turns proves material.
- Single shared upstream `/event` + fan-out vs. per-principal upstream subscriptions (§3.2) — leaning shared; confirm against assistant concurrent-SSE behavior.
- Discord/Slack edit-throttle that stays under platform rate limits while feeling live (start ~1.25 s).
- Whether to surface `reasoning` parts on channels at all (likely off by default — avoid leaking chain-of-thought).
- ~~The exact OpenCode mechanism to make tools pause with `permission.asked`~~ — **resolved** (§1.2): `permission: { bash: "ask", … }`, verified end-to-end on 1.15.13.
- ~~Exact end-of-turn condition to render against (`session.status` idle vs `session.idle`)~~ — **resolved 2026-06-04** (live `opencode/big-pickle` on 1.15.13): turn-end = `session.idle` **or** `session.status` with `status.type === "idle"` (`status` is an object `{type}`, not a string). Implemented in `oc-events.ts`; both signals observed firing.
- Whether to adopt the `session.next.*` delta family (1.15.13+) as the primary render stream vs `message.part.*` (§1.1).

---

## 10. References

- `packages/ui/src/routes/proxy/assistant/[...path]/+server.ts` — the transparent streaming proxy precedent.
- `containers/guardian/src/{server,forward,replay,rate-limit,signature}.ts` — current pipeline and guardian-local runtime state pattern.
- `packages/channels-sdk/src/crypto.ts` — signing primitives to generalize.
- `.openpalm/config/assistant/opencode.jsonc` — assistant permission config (§1.2).
- Live OpenCode OpenAPI: `curl http://127.0.0.1:3800/doc` (assistant on :3800 → OpenCode :4096).

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
- **OpenCode bumped 1.3.3 → 1.15.13** (latest) in both Dockerfiles; surface re-validated against 1.15.13. New since 1.3.3: the `session.next.*` fine-grained streaming family (§1.1), `session.status` as the live turn signal, `server.heartbeat` as another global no-`sessionID` event.
- **Drift guard** made fail-closed for the proxy path (sec LOW).
- **Code placement:** kept guardian-local + `channels-sdk`, **not** `@openpalm/lib` — reasoned divergence from the architecture reviewer, consistent with the guardian's minimal-dependency Docker pattern (§2.2).
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

## Appendix B — Upgrading OpenCode & the akm-opencode plugin across the whole stack

The proxy contract **is** the OpenCode API pinned to `OPENCODE_VERSION` (§0, §5), and the permission feature depends on a plugin runtime that matches that version. So a version bump is not a one-line edit — it touches the images, the host npm packages, and any **already-cached** plugin in deployed containers. This is the verified procedure (derived end-to-end on the 1.3.3 → 1.15.13 bump, 2026-06-03).

### B.1 The two coupled versions

| What | Where it's pinned | Rule |
|---|---|---|
| **OpenCode binary** | `containers/assistant/Dockerfile` `ARG OPENCODE_VERSION`; `containers/guardian/Dockerfile` `ARG OPENCODE_VERSION` | **Must be identical in both** (CI enforces lockstep). The guardian ships OpenCode as a content moderator and, for the proxy, couples to this exact API surface (§5). |
| **`@opencode-ai/plugin` / `@opencode-ai/sdk`** (host npm) | `packages/electron/admin-tools/package.json`; `.opencode/package.json` (gitignored, local tooling); root `bun.lock` | Caret is fine for a published lib, but **refresh the lockfile** after bumping so the resolved version actually moves. |
| **`akm-opencode` plugin** | `.openpalm/config/assistant/opencode.jsonc` → `"plugin": ["akm-opencode@latest"]` (installed at runtime, not baked) | **Must be compatible with the OpenCode binary version.** `akm-opencode`'s declared `@opencode-ai/plugin: ^1.2.20` is too loose to trust — a given plugin release may require a newer runtime than it advertises. |

> **Hard lesson:** `akm-opencode@0.8.0` loads on OpenCode **1.15.x** but fails on **1.3.3** with `fn4 is not a function. (… 'fn4' is an instance of Object) failed to load plugin` — the signature of a plugin built against a newer plugin API. **Treat the OpenCode binary and akm-opencode as a matched pair; bump and verify them together.** "Installs on disk" ≠ "loads" — always grep the assistant logs for `failed to load` after an upgrade, not just the on-disk version.

### B.2 Source edits (find every pin)

```bash
# Authoritative latest of each package:
npm view opencode-ai version; npm view @opencode-ai/plugin version; npm view @opencode-ai/sdk version
# Find every reference in-tree (excludes node_modules/build):
git grep -nE "OPENCODE_VERSION|@opencode-ai|akm-opencode" -- . ':!bun.lock'
```

1. Set the **same** `ARG OPENCODE_VERSION=<new>` in `containers/assistant/Dockerfile` **and** `containers/guardian/Dockerfile`.
2. Bump `@opencode-ai/plugin` in `packages/electron/admin-tools/package.json` (and `.opencode/package.json` if used locally).
3. `bun install` to refresh `bun.lock`, then **verify** `bun install --frozen-lockfile` is clean and the lockfile resolved both `@opencode-ai/plugin` and its transitive `@opencode-ai/sdk` to `<new>`. Rebuild any consumer that bundles the plugin (`bun run --cwd packages/electron/admin-tools build`).
4. `akm-opencode` itself needs no source edit (it's `@latest`), **but** confirm the published `@latest` is intact before relying on it: `npm pack akm-opencode@latest` and check the tarball actually contains every file `index.ts` imports (a past `@latest` shipped `index.ts` importing `./shared/feedback-signals` with no `shared/` in the tarball — a broken publish that fails to load in *any* OpenCode version).

### B.3 Validate the assistant image before shipping (no Docker socket needed in the test)

A multi-minor OpenCode jump can break config-schema validation, the plugin loader, or the entrypoint. Smoke-test the **real** image with the **real** mounted config:

```bash
docker build -f containers/assistant/Dockerfile -t openpalm/assistant:smoke-<new> .
# Mount the actual assistant config (copy it OUTSIDE /tmp — see the trap below) and boot:
SMOKE=~/.cache/op-smoke-cfg; rm -rf "$SMOKE"; mkdir -p "$SMOKE"
cp -r .openpalm/config/assistant/. "$SMOKE"/; chmod -R a+rX "$SMOKE"
docker run -d --name op-smoke -e OPENCODE_CONFIG_DIR=/etc/opencode -e OPENCODE_ENABLE_SSH=0 \
  -v "$SMOKE":/etc/opencode -p 24096:4096 openpalm/assistant:smoke-<new>
# Then assert, in order:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:24096/doc        # 200 = serves
curl -s -X POST http://localhost:24096/session -d '{}'                      # session creates
docker logs op-smoke 2>&1 | grep -iE "ConfigInvalid|Unrecognized"          # empty = config valid
curl -s http://localhost:24096/config | grep -o '"plugin":\[[^]]*\]'       # plugin present, not []
docker logs op-smoke 2>&1 | grep -iE "akm-opencode|failed to load"         # loads, no failure
```

> **Trap — never use a `/tmp/...` path as the `-v` source.** This host's `dockerd` runs with systemd `PrivateTmp=true`, so a `/tmp/...` bind source resolves against the daemon's *private* `/tmp` (empty) and silently mounts a blank dir — the container then shows only entrypoint-seeded files and the test reads a phantom config. Use `~/.cache/...` or `/var/tmp/...`. (`docker inspect` shows the bind Source correctly even when this happens — confirm with `docker exec <c> ls /etc/opencode`.)

A green smoke test proves the platform (build / boot / config-validation / plugin install+load mechanism). It does **not** exercise prompt execution (no provider configured) — the entrypoint's lmstudio/socat proxy + provider path still needs a model-backed check.

### B.4 Roll the upgrade onto a **running** deployment (the cache does not self-heal)

OpenCode resolves `akm-opencode@latest` to a concrete version **once**, pins it in a cache lock (`package.json` + `bun.lock`/`package-lock.json`) under `OP_HOME/data/assistant/.cache/opencode/`, and **reuses it on every boot — it never re-resolves `@latest`.** A container that cached the old (or a broken) plugin will keep using it after a plain restart. To actually upgrade a live assistant:

1. **Deploy the new image.** The assistant must run the matching OpenCode binary (B.1) — otherwise the plugin won't load even once reinstalled. Recreate only the assistant service; preserve a rollback tag first:
   ```bash
   docker tag <running-image-id> openpalm/assistant:<tag>-pre<new>     # rollback insurance
   docker tag openpalm/assistant:smoke-<new> openpalm/assistant:<new>-local
   # NB: stack.env OP_IMAGE_TAG can drift from the tag actually running — override explicitly
   # and dry-run `compose config` to confirm the resolved image before recreating:
   OP_IMAGE_TAG=<new>-local docker compose -p openpalm \
     --project-directory $OP_HOME/config/stack \
     -f core.compose.yml -f services.compose.yml -f channels.compose.yml -f custom.compose.yml \
     --env-file $OP_HOME/knowledge/env/stack.env \
     up -d --force-recreate --no-deps assistant
   ```
2. **Clear the stale plugin cache** so OpenCode re-resolves `@latest`. It's gitignored, regenerable user data — **get per-path approval, then use the OS trash, never `rm`:**
   ```bash
   gio trash $OP_HOME/data/assistant/.cache/opencode    # re-downloads models.json + ripgrep on next boot
   docker restart openpalm-assistant-1
   ```
   (If the image was already new at step 1, a fresh container with no prior cache installs the current `@latest` directly — the trash step is only needed when an old/broken plugin is already cached.)
3. **Verify on the live container:**
   ```bash
   docker exec openpalm-assistant-1 bash -lc \
     'find /home/opencode/.cache/opencode -path "*akm-opencode/package.json" | head -1 | xargs grep -m1 version'
   docker logs --since 5m openpalm-assistant-1 2>&1 \
     | grep -iE "installed akm|AKM CLI resolved|agent default|failed to load|fn4"
   # success = "installed akm-opencode@<new>", "AKM agent default initialized", NO "failed to load"
   ```
   **Rollback:** `OP_IMAGE_TAG=<old> docker compose … up -d --force-recreate --no-deps assistant` (the `-pre<new>` tag still points at the prior image).

### B.5 Relationship to the guardian proxy

When the proxy lands, the guardian's startup drift guard (§5) fetches the assistant `/doc` and asserts the allowlisted paths and the two payload shapes still exist; on mismatch it fails the proxy route closed (`503`) and keeps the buffered path up. So the upgrade workflow gains one more gate: **after B.3/B.4, the guardian's own OpenCode (same `OPENCODE_VERSION`, B.1) and the assistant must agree** — a lockstep miss surfaces as the drift guard tripping, not as silent breakage. Re-run the §1.2 permission verification (Appendix A) against the new version whenever the permission/event surface is in scope, since Stage 4 depends on it.
