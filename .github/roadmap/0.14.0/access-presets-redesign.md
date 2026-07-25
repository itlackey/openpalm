# Network access — design

Status: proposal
Supersedes: #563 network access presets, and the bind-address model behind them.

## 1. The problem

A person installs OpenPalm on a desktop and wants to open the assistant from
their phone. That has never worked, and it fails three times over:

1. **`Host` → 400.** `checkHostHeader` (`packages/ui/src/lib/server/helpers.ts:270`)
   allows only `localhost` / `127.0.0.1` / `::1`, and runs as the first
   statement in `hooks.server.ts`'s `handle`. Its only escape,
   `OP_ALLOW_REMOTE_SETUP`, appears nowhere in `containers/` or
   `packages/skeleton/`, so Compose never passes it into the assistant
   container.
2. **CORS preflight fails.** If the page did load, the browser calls OpenCode
   cross-origin, and OpenCode grants only loopback origins.
3. **401 from OpenCode.** `entrypoint.sh:263` hardcodes
   `auth: { mode: "none" }` in the seeded connection regardless of
   `OPENCODE_AUTH`, so the one preset that turns auth on ships a connection
   with no credentials.

The configuration surface is a secondary problem, and smaller than it looks:
most bind/port variables belong to profile-gated containers that do not exist
in a default install, and the wizard hides the rest behind one radio button.
The real defect is that **one** variable — `OP_UI_CORS_ALLOWED_ORIGINS` — sits
on the critical path, has no owner, cannot be computed by the process that
needs it, and fails as a bare network error. The bind cascade around it
(`unset` means *inherit the global bind* for four listeners and *loopback* for
one, in the same file) is what makes that failure undiagnosable.

## 2. What is actually going on

**The same-origin migration is half-finished.**

`packages/ui/src/routes/voice/[...path]/+server.ts` already does exactly what
this document proposes, and says so:

> *"Same-origin is the point: no CORS anywhere (the container stays a plain,
> unmodified upstream); it works with the container's default loopback-only
> binding — a LAN browser reaches the UI origin, and this process makes the
> local hop — so no port ever needs to be opened for voice."*

Voice migrated. The `/api/speak` and `/api/transcribe` relays were retired.
**OpenCode is the last service still talking to the browser directly**, and
every artifact that looks like independent complexity is a consequence of that
one gap:

| Artifact | Exists because |
|---|---|
| `ui-cors-origins.ts` | the browser calls OpenCode cross-origin |
| `rewriteLoopbackUrlForBrowserHost` | the seeded URL is baked as `127.0.0.1` |
| mixed-content policy in `url-policy.ts` | two origins, two TLS decisions |
| `port-contract.ts` | a browser-facing assistant port must be reconciled |
| `assistant-endpoint.ts`'s 4-level precedence | three override names for one URL |
| `OPENCODE_AUTH` + a second password | OpenCode is LAN-reachable |

This is not a new architecture. It is finishing one.

## 3. Design

### 3.1 Finish the migration

The UI server proxies OpenCode at `/oc`, same-origin, behind the existing
session — modelled on the voice route, including its two documented traps:
never forward `content-length` past node's transparent gzip decompression, and
do not abort the shared signal once the body is streaming.

The upstream is a **constant**, `http://localhost:4096`. Not a variable, not a
preset output, not conditional. All three failures in §1 die here: no
cross-origin request, no seeded URL to rewrite, no browser-side credential.

### 3.2 Publish one port

OpenCode, voice, and the guardian all have loopback-only upstreams reachable
through the UI process. The only listener a home install needs on the network
is the UI on `3800`. Everything else is a local hop.

Voice's bind becomes a `127.0.0.1` literal rather than a variable — it never
needed a host port, and today's `${OP_VOICE_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}`
cascade means a hand-set `OP_BIND_ADDRESS=0.0.0.0` publishes a GPU inference
API to the LAN for no reason.

### 3.3 Toggles, not presets

Presets fix combinations. Capabilities compose. A preset enum cannot express
"network access on, guardian on for Slack, OpenAI API on, no screening" — a
combination people actually want.

**Always visible — the whole configuration surface for a home install:**

| Toggle | Off (default) | On |
|---|---|---|
| **Assistant access** | This computer only | Anyone on my network |

**Revealed when a guardian integration is enabled** (chat portal, Discord, Slack):

| Toggle | Effect |
|---|---|
| Allow network access | Publishes the guardian's `/oc` front door |
| Enable OpenAI-compatible API | Publishes the OpenAI/Anthropic edge |

**Advanced, collapsed:**

| Toggle | Effect |
|---|---|
| Allow direct assistant API connections | Publishes OpenCode with a generated key, for a second desktop app or a third-party OpenCode client |

Nothing is configured *off*. Doors are added deliberately.

### 3.4 Derivation

```
OP_UI_BIND              = network_access      ? 0.0.0.0 : 127.0.0.1
OP_ASSISTANT_BIND       = assistant_direct    ? 0.0.0.0 : 127.0.0.1
OPENCODE_AUTH           = assistant_direct                      (+ generated key)
OP_GUARDIAN_BIND        = guardian_network    ? 0.0.0.0 : 127.0.0.1
GUARDIAN_DIRECT_INGRESS = guardian_network
OP_API_BIND             = guardian_openai_api ? 0.0.0.0 : 127.0.0.1
voice bind              = 127.0.0.1                             (literal)
UI /oc upstream         = http://localhost:4096                 (constant)
```

One line per toggle. No cascade, no inheritance, no "unset means different
things." Toggles are persisted intent in `knowledge/env/stack.env`; the derived
row is regenerated every deploy into `state/stack.state.env`, which already
layers over it (`buildEnvFiles()`).

There is nothing to *detect*: preset detection existed only because intent had
to be reverse-engineered from outcomes. You read the toggle.

### 3.5 The guardian is a connection, not a route

Screening is **not** a server-side routing mode. It is achieved by turning
assistant network access *off* and pointing a client — desktop app, PWA, or a
hosted UI — at the guardian's published `/oc`.

The Connections UI already accepts exactly this: a guardian front door
including its `/oc` path, with Basic auth. No new code, just a published
guardian.

This is what removes the remaining complexity. Because the UI never
authenticates to the guardian:

- it needs no portal principal (no additional credential to mint or rotate);
- `EVENT_MAX_STREAMS_PER_PRINCIPAL = 2` never applies to browsers sharing one
  UI session;
- per-principal rate limits are not collapsed into one shared household bucket;
- there is no preset switch that orphans sessions created before it
  (guardian session ownership is fail-closed on unknown IDs);
- fail-closed LLM moderation never lands on the default chat path.

It also **fixes attribution**, which a server-side screening mode could not:
each client connects with its own principal, so `x-openpalm-user` — already
wired through `guardian/src/auth.ts` into ownership, rate limiting and the
audit log — yields per-client identity, individual revocation, and per-client
limits.

### 3.6 Host allowlist: scope it, don't delete it

`checkHostHeader` is DNS-rebinding protection. It asserts *"this service is
loopback-only."*

That is true, permanently, for the **host** UI on `3880`: it is admin-capable
(Docker socket, host config, container control) and is never published. The
check is free and correct there.

It is false for the **container** UI whenever `network_access` is on — a
service deliberately published, advertised over mDNS, and opened from a QR
code. Enforcing "I am loopback-only" on it is not defence in depth; it is a
false assertion that manifests as a 400.

So: one derived boolean, no allowlist to maintain, no DHCP staleness. Always
on for the host process; follows `network_access` for the container.

What it protects on the container UI is thin — a rebinding attacker's browser
sends `Host: attacker.com`, so no session cookie goes with it and every
authenticated route 401s. What remains reachable is `/health`, the login page,
PWA assets, and `POST /api/auth/login`.

**That makes login rate limiting load-bearing**, and it does not exist today.
See §5.

### 3.7 Discovery

1. **A QR code** on the wizard's final screen and in the dashboard. Highest
   value per unit of work in this document, and it makes the hostname
   invisible — which is what lets us stop caring about pretty names.
2. **mDNS** advertising the UI port, gated on `network_access`. A nicety, not
   the mechanism: `.local` resolution is unreliable on older Android, the
   responder only advertises while the host process runs, and `.local` can
   never carry a publicly-trusted certificate.
3. **A reachability check** — "test from another device" showing the resolved
   URL, the QR, and a live probe. The reported failure was a bare network
   error; nothing currently tells a user whether it worked.

## 4. What this deletes

The entire preset subsystem: `network-preset.ts` (~320 lines),
`detectNetworkPreset`, `validateNetworkPresetEnv`,
`collectNetworkExposureWarnings`, `PRESET_FRAMING`, and their tests.

The same-origin migration's leftovers: `ui-cors-origins.ts`,
`port-contract.ts`, `rewriteLoopbackUrlForBrowserHost`, the entrypoint's
`runtime-config.json` seeding block, `assistant-endpoint.ts`'s override
precedence, both CORS variables, `OP_UI_DEFAULT_ASSISTANT_URL`, and
`OP_BIND_ADDRESS` with its cascade.

One redundancy: `portals.compose.yml` publishes `OP_CHAT_PORT:-3820` **and**
`OP_API_PORT:-3821`, two host ports mapping to the same container port `8182`.
That is one toggle and one port.

Honest accounting of the operator surface: the bind variables mostly change
owner — from operator input to generated output — rather than vanishing. The
genuine deletions are the modules above and `GUARDIAN_DIRECT_INGRESS` as a
hand-edited variable (`api/connections/pairing/+server.ts:48` currently
instructs users to edit `stack.env` by hand and restart the guardian).

## 5. What this costs

1. **Login rate limiting becomes required.** `POST /api/auth/login` has no
   attempt counter, backoff, or lockout, and the wizard accepts any 8+
   character replacement for its generated password. Publishing the UI without
   this is not defensible.
2. **Session tokens are HMAC-signed with the plaintext login password** over a
   cleartext timestamp (`session-store.ts:60`), making a captured cookie an
   offline oracle for that password. Independent of this design, but it gates
   publishing the UI. Sign with a separate random key.
3. **The UI server becomes a streaming hop** for chat, as it already is for
   voice. The voice route is the proof it works and the reference for how.
4. **`OPENCODE_AUTH` applies to loopback callers too**, so with the advanced
   direct-access toggle on, the `/oc` proxy needs that password. The entrypoint
   already resolves it for the OpenCode child.
5. **Migration.** Existing installs carry six bind variables and a preset
   value. Map known rows to toggle values; anything unrecognised keeps working
   on its raw variables with a one-time notice.

## 6. Build order

Each step is independently shippable.

| | Step | Status |
|---|---|---|
| 1 | **QR code + reachability check.** Days of work, no architecture change, works against the current stack. | open |
| 2 | **Login rate limiting + session-key separation.** Gates everything below. | **done** |
| 3 | **Scope the Host allowlist** to the host process. Without this, nothing on the network can load the UI at all. | **done** |
| 4 | **Same-origin `/oc` proxy**, modelled on the voice route. | **done** |
| 5 | **Toggles replace presets**, with a generated bind row. | **done** |

Steps 2–4 made LAN access work; step 5 removed the configuration surface that
made it hard to reason about. The CORS grant and the entrypoint's `--cors`
assembly went with step 5, since nothing browser-direct points at the local
OpenCode any more.

One compatibility branch survives on purpose: `resolveLockedBaseUrl` still
rewrites an absolute loopback seed to the visited host, so an install whose
`runtime-config.json` predates the proxy keeps working until its container
restarts and reseeds `/oc`. It can go one release later.

## 7. Verification

This design was written against a read of the system, not a run of it — which
is how three sequential blockers went unnoticed while a fix was written for the
middle one. Before step 4 merges: deploy the stack, enable network access, and
load the UI from an actual phone. Then again with three clients connected at
once.

---

*TLS is deliberately out of scope. It is orthogonal — `OP_ACCESS` answers who
may reach the assistant, TLS answers whether the connection is encrypted — and
folding them together rebuilds the conflated axis this document removes. See
`tls-on-the-home-network.md`.*
