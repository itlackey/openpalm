# How OpenPalm Works — TLDR

OpenPalm is a local-first AI assistant platform. It runs as a Docker Compose
stack on your machine. Everything is LAN-only by default, nothing is in the
cloud, and all persistent data stays on your host.

---

## The Big Picture

```
You (browser / CLI / API client)
        |
        v
Admin :3880                  Addon edge (e.g. chat :3820, api :3821, voice :3810)
                                    |
                                    v
                             Guardian :8080 (internal)   <- validates every addon message
                                    |
                                    v
                             Assistant :3800 host / :4096 internal
                                    |
                                    v
                             Admin API                   <- assistant requests stack ops here
```

> **Port note:** Guardian listens on port 8080 inside its container but is
> not exposed on the host -- it is only reachable on the Docker network.

Three hard rules define the whole design:
1. **The host CLI or the admin may orchestrate Docker.**
2. **Every channel message goes through Guardian.** No exceptions.
3. **Assistant has no Docker socket.** It asks Admin to do things.

---

## Components

### Admin (SvelteKit app, host port 3880)
The optional web control plane. When present, it reaches Docker through docker-socket-proxy.

Responsibilities:
- Writes runtime configuration and secrets directly to `~/.openpalm/stack/` and
  `~/.openpalm/vault/`
- Runs `docker compose` for all lifecycle operations (install, update, up, down,
  restart)
- Exposes an authenticated API used by the browser UI and the assistant
- Applies explicit config mutations to `config/` and addon changes to
  `~/.openpalm/stack/addons/` when requested through authorized UI/API actions
- Writes the audit log
- Helps manage addons and other host-side files through an authenticated API

### Guardian (Bun server, port 8080)
The security checkpoint for all inbound channel traffic.

For every inbound message it:
1. Verifies HMAC signature (`CHANNEL_<NAME>_SECRET`)
2. Rejects replayed messages (5-minute replay cache)
3. Enforces rate limits (120 req/min per user)
4. Validates payload shape (channel, userId, message, timestamp)
5. Forwards validated messages to the assistant

A message that fails any check never reaches the assistant.

### Assistant (OpenCode runtime, host port 3800)
The AI. Runs OpenCode. Has no Docker socket.

When it needs to do something to the stack (restart a service, check status), it
calls the Admin API using its assistant-scoped token. The Admin allowlists which
actions and service names are legal -- the assistant can't do anything
unauthorized.

The assistant uses baked-in core config inside the image at `/etc/opencode`,
mounts user extensions from `~/.openpalm/config/assistant/` into
`/home/opencode/.config/opencode`, mounts `~/.openpalm/vault/stack/auth.json`
for OpenCode auth state, and mounts `~/.openpalm/vault/user/` at `/etc/vault/`
for optional user extension files. Provider keys are injected from
`~/.openpalm/vault/stack/stack.env` via compose `${VAR}` substitution. Its durable home is
`~/.openpalm/data/assistant/`, and its shared workspace is
`~/.openpalm/data/workspace/` mounted at `/work`.

### Addon edge services (e.g. `chat`, host port 3820)
Translate external protocols into signed Guardian messages. The `chat` addon is
the lighter conversational edge, while `api` is the broader compatibility
facade. Discord, Slack, and voice addons speak their native protocols. All of
them do the same thing at the end: sign the message with their HMAC secret and
POST it to Guardian.

The runtime image for registry-backed adapters is the unified
`channel`, built from `core/channel/Dockerfile`.

### Supporting services
- **Memory** -- Bun.js service (`@openpalm/memory`) with sqlite-vec vector
  storage; gives the assistant persistent memory across conversations
- **Scheduler** -- automation service on host port `3897` / container port
  `8090`; reads `~/.openpalm/config/automations/` through the mounted
  `config/` tree and calls the admin API using the assistant-scoped token

---

## Message Flow (end to end)

```
User sends message via chat client
        |
        v
chat :3820 (host) -> :8181 (container)
  Signs message: HMAC-SHA256(CHANNEL_CHAT_SECRET, payload)
  POSTs to guardian:8080/channel/inbound
        |
        v
Guardian validates:
  + HMAC signature correct
  + Timestamp within 5 min skew
  + Not a replayed nonce
  + Rate limit not exceeded
  + Payload shape valid
        |
        v
Guardian forwards to assistant:4096
        |
        v
Assistant (OpenCode) processes the message
  Calls tools, reads memory, generates response
        |
        v
Response flows back through Guardian -> chat -> user
```

If the assistant needs to do a stack operation during its turn (e.g., restart
a service):

```
Assistant calls POST http://admin:8100/admin/containers/restart
  Header: x-admin-token: <assistant-scoped token>
  Body:   { "service": "chat" }
        |
        v
Admin validates token + allowlists service name
Runs: docker compose restart chat
Writes audit entry
Returns result
```

---

## Lifecycle (install / update)

```
openpalm install   ->   writes files into ~/.openpalm/
                             |
                             v
                    You / CLI choose compose files:
                      core.compose.yml
                      + zero or more addon overlays
                             |
                             v
                    docker compose -f <compose files> up -d
```

Automatic lifecycle operations (install/update/startup/apply/setup reruns/upgrades)
are non-destructive for existing user config files in `config/`; they only seed
missing defaults.

---

## File Assembly Model

OpenPalm doesn't generate config by filling in templates. It copies whole files.

`config/` is user-owned and persistent. Allowed writers are:
- You, by editing files directly
- The admin via explicit UI/API config actions
- The assistant, only when you request it and it uses authenticated,
  allowlisted admin API actions

```
~/.openpalm/stack/core.compose.yml         -> base compose definition
~/.openpalm/stack/addons/chat/compose.yml  -> addon overlay
~/.openpalm/vault/stack/stack.env          -> passed via --env-file
~/.openpalm/vault/user/user.env            -> optional extension env-file
```

Docker reads compose files and env files directly from their final locations.
There is no intermediate staging step. The standard wrapper includes
`vault/stack/stack.env`, `vault/user/user.env`, and `vault/stack/guardian.env`.

---

## Security Model

| Invariant | Enforcement |
|-----------|-------------|
| Host CLI or admin is the orchestrator | CLI manages Docker Compose directly on host; admin (optional) uses docker-socket-proxy |
| Guardian-only ingress | Channel adapters POST to Guardian only; Guardian HMAC-verifies every message |
| Assistant isolation | `assistant` has no Docker socket; when admin is present, calls Admin API on allowlist |
| LAN-first by default | Host-exposed ports bind to `127.0.0.1`; nothing public without opt-in |

### HMAC signing

Each channel has its own secret (`CHANNEL_<NAME>_SECRET`). The channel adapter
signs the full JSON payload with HMAC-SHA256 before sending. Guardian verifies
the signature using the same secret. A message with a wrong or missing signature
is rejected at the door.

### Allowlist enforcement

The admin keeps an explicit allowlist of:
- **Legal service names** -- core services + any installed addon service such as `chat`, `api`, or `voice`
- **Legal actions** -- lifecycle/config endpoints, `containers.*`, `addons.*`,
  `registry.*` (automations), `artifacts.*`, and `audit.*` routes implemented by admin

Anything not on the list is rejected with `400 invalid_service` or
`400 invalid_action`.

---

## Adding a Channel (the whole process)

1. Install from the registry via admin API or admin UI
2. Or manually: add `~/.openpalm/stack/addons/<name>/compose.yml`
3. Rerun `docker compose` with that addon included
4. If admin tooling is involved, it may also ensure/generate the channel HMAC secret first

No code changes. No image rebuild. The channel is live.
