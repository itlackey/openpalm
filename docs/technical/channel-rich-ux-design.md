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

Validated against the **live running assistant** (`openpalm/assistant:v0.11.0-rc.1`, OpenCode `1.3.3` — the version pinned in `core/assistant/Dockerfile`), read from its OpenAPI spec on `:4096`.

> **Prerequisite — permission prompts must actually fire (§1.2).** OpenCode merged "tools" and "permissions"; whether a tool pauses with `permission.asked` depends on the assistant's permission configuration. The current `.openpalm/config/assistant/opencode.jsonc` sets only file-read denials and `external_directory` allows — it does **not** configure interactive tool gating, so by default tools may auto-proceed and emit **no** `permission.asked`. The permission-prompt feature is inert until the assistant is configured to ask. This is a hard dependency, not an afterthought — see §1.2.

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
| `session.idle` | `sessionID` | yes — **turn-end signal** |
| `session.error` | `sessionID, error` | yes |
| `server.connected`, `installation.*`, `server.instance.disposed`, … | no `sessionID` | **no** |

The last row is load-bearing for filtering: **global events carry no `sessionID` and must never be forwarded to a channel** (§3.2).

`ToolPart.state` is one of `ToolStatePending|Running|Completed|Error`, each with `status` plus `input`/`title`/`output`/`error` — enough to render a live tool-call card.

### 1.2 Making permissions fire (hard prerequisite)

The `prompt_async`/`message` bodies still accept a `tools` map, but it is deprecated: *"tools and permissions have been merged, you can set permissions on the session itself now."* Consequence: whether a tool emits `permission.asked` is governed by the **session/assistant permission config**, not a per-turn flag. The shipped `opencode.jsonc` does not configure interactive gating, so **today no `permission.asked` events fire for tool execution.**

Before the permission-prompt UX can work, a deliberate step is required (exact mechanism to be confirmed against OpenCode 1.3.3 during Stage 4): configure the assistant (globally or per channel-owned session) so that tools requiring approval pause with `permission.asked`. **Stage 4 must begin by empirically confirming that a configured tool actually emits `permission.asked` on this version** before any Discord UI is built. If it does not, the feature is blocked upstream and must be reported as such rather than worked around.

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

A reviewer suggested extracting the proxy/allowlist/ownership logic into `@openpalm/lib`. **We deliberately do not.** The guardian (`core/guardian`, Bun) is built as a minimal image that depends only on `channels-sdk` — the Docker dependency-resolution pattern in `CLAUDE.md` keeps `@openpalm/lib` (a CLI/UI control-plane package) out of the guardian and channel images on purpose. Forcing a lib dependency would *add* build complexity, not remove it. Correct homes:

- **Shared, pure, channel+guardian:** `signRequest`/`verifyRequest` and the allowlist path-matcher → `packages/channels-sdk` (both already depend on it).
- **Guardian-only runtime state:** the session/permission-ownership maps and `/event` fan-out → local to `core/guardian`, mirroring its existing `replay.ts` and `rate-limit.ts` (which are *also* guardian-local, not in lib). This is consistent with the established structure, not a violation of it.
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
2. The channel **generates a `messageID`** (`^msg…`) and passes it in the `prompt_async` body.
3. The channel filters incoming frames to its session **and** that `messageID` (via `properties.messageID` / `part.messageID`), rendering deltas until `session.idle` for the session marks turn end.

This removes the subscribe-after-prompt race entirely and gives a stable correlation key without relying on a response body.

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

The guardian couples to OpenCode at exactly **three** pinned points: the allowlist paths (§3.3), `event.properties.sessionID` on session events (§3.2), and the `message`/`prompt_async` prompt-body shape (§3.5). All pinned to `OPENCODE_VERSION` (`core/assistant/Dockerfile` and `core/guardian/Dockerfile` in lockstep).

- **Startup assertion is fail-closed for the proxy path (security review, low):** on boot the guardian fetches the assistant `/doc` and asserts the allowlisted paths and the two payload shapes exist. On drift or fetch failure it **disables the proxy route and returns `503`** there (with a clear log); the legacy buffered `/channel/inbound` path stays up. Not a warning-only path.
- The `/event` filter **ignores unknown event types** and tolerates added fields — an OpenCode bump degrades gracefully rather than breaking channels.

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
5. **Stage 4 — Permissions, gated on the §1.2 prerequisite.** First **empirically confirm** a configured tool emits `permission.asked` on OpenCode 1.3.3; then Discord `prompt_async` + correlation (§4.2) + throttled edits + tool embeds + ActionRow → `/permission/{requestID}/reply` (`{reply}`) + stop→`abort`. If permissions can't be made to fire upstream, stop and report.
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
- The exact OpenCode mechanism to make tools pause with `permission.asked` on 1.3.3 (§1.2) — the single biggest unknown; resolve at the top of Stage 4.

---

## 10. References

- `packages/ui/src/routes/proxy/assistant/[...path]/+server.ts` — the transparent streaming proxy precedent.
- `core/guardian/src/{server,forward,replay,rate-limit,signature}.ts` — current pipeline and guardian-local runtime state pattern.
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
- **Permission prerequisite** (§1.2): tools won't emit `permission.asked` under the current config; Stage 4 gated on confirming it upstream (API review MED).
- **Drift guard** made fail-closed for the proxy path (sec LOW).
- **Code placement:** kept guardian-local + `channels-sdk`, **not** `@openpalm/lib` — reasoned divergence from the architecture reviewer, consistent with the guardian's minimal-dependency Docker pattern (§2.2).
- **`/oc/*` base path** chosen and a telemetry-triggered sunset stance added (arch review §7).
