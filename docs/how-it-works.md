# How OpenPalm Works — TLDR

OpenPalm is a local-first AI assistant platform. It runs as a Docker Compose
stack on your machine. Everything is LAN-only by default, nothing is in the
cloud, and all persistent data stays on your host.

---

## The Big Picture

```
You (browser / CLI / chat client)
        |
        v
Admin :8100                  Channel adapter (e.g. channel-chat :8181)
                                   |
                                   v
                            Guardian :8080 (internal)   <- validates every channel message
                                   |
                                   v
                            Assistant :4096             <- OpenCode runtime
                                   |
                                   v
                            Admin API                   <- assistant requests stack ops here
```

> **Port note:** Guardian listens on port 8080 inside its container but is
> not exposed on the host -- it is only reachable on the Docker network.

Three hard rules define the whole design:
1. **Admin is the only component that touches Docker.**
2. **Every channel message goes through Guardian.** No exceptions.
3. **Assistant has no Docker socket.** It asks Admin to do things.

---

## Components

### Admin (SvelteKit app, port 8100)
The control plane. Only component with Docker socket access (via docker-socket-proxy).

Responsibilities:
- Writes runtime configuration (compose files, secrets) directly to their
  final locations
- Runs `docker compose` for all lifecycle operations (install, update, up, down,
  restart)
- Exposes an authenticated API used by the CLI, the browser UI, and the assistant
- Applies explicit config mutations to `config/` (for example, connections or
  component install/uninstall) when requested through authorized UI/API actions
- Runs scheduled automations -- user-defined files from config/automations/
- Writes the audit log
- Discovers installed components by scanning `config/components/`
- Installs components from the registry catalog on demand via the API

### Guardian (Bun server, port 8080)
The security checkpoint for all inbound channel traffic.

For every inbound message it:
1. Verifies HMAC signature (`CHANNEL_<NAME>_SECRET`)
2. Rejects replayed messages (5-minute replay cache)
3. Enforces rate limits (120 req/min per user)
4. Validates payload shape (channel, userId, message, timestamp)
5. Forwards validated messages to the assistant

A message that fails any check never reaches the assistant.

### Assistant (OpenCode runtime, port 4096)
The AI. Runs OpenCode. Has no Docker socket.

When it needs to do something to the stack (restart a service, check status), it
calls the Admin API using `OP_ADMIN_TOKEN`. The Admin allowlists which
actions and service names are legal -- the assistant can't do anything
unauthorized.

Extensions live in two places:
- `/etc/opencode/` -- system config mounted from `data/assistant/`
  (model, plugins, persona -- managed by admin)
- `config/assistant/` -- user extensions mounted at runtime (no rebuild
  needed)

### Channel adapters (e.g. channel-chat, port 8181)
Translate external protocols into signed Guardian messages. The chat channel
speaks the OpenAI API protocol. Discord, Telegram, and voice channels speak
their native protocols. All of them do the same thing at the end: sign the
message with their HMAC secret and POST it to Guardian.

The runtime image for registry-backed adapters is the unified
`channel`, built from `core/channel/Dockerfile`.

### Supporting services
- **Memory** -- Bun.js service (`@openpalm/memory`) with sqlite-vec vector
  storage; gives the assistant persistent memory across conversations

---

## Message Flow (end to end)

```
User sends message via chat client
        |
        v
channel-chat :8181
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
Response flows back through Guardian -> channel-chat -> user
```

If the assistant needs to do a stack operation during its turn (e.g., restart
a service):

```
Assistant calls POST http://admin:8100/admin/containers/restart
  Header: x-admin-token: <ADMIN_TOKEN>
  Body:   { "service": "channel-chat" }
        |
        v
Admin validates token + allowlists service name
Runs: docker compose restart channel-chat
Writes audit entry
Returns result
```

---

## Lifecycle (install / update)

```
openpalm install   ->   POST /admin/install
                             |
                             v
                   Admin writes configuration:
                     writes core compose -> data/docker-compose.yml
                     ensures vault env files exist
                     discovers components from config/components/
                             |
                             v
                   Admin runs: docker compose -f <compose files> up -d
```

**Apply is idempotent.** The admin also runs it automatically on startup --
restarting the admin container syncs your latest config changes into the
running stack.

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
config/components/chat/compose.yml    -> used directly by docker compose -f
vault/user.env                        -> passed via --env-file
vault/system.env                      -> passed via --env-file
assets/docker-compose.yml             -> core compose definition
```

Docker reads compose files and env files directly from their final locations.
There is no intermediate staging step.

---

## Security Model

| Invariant | Enforcement |
|-----------|-------------|
| Host CLI or admin is the orchestrator | CLI manages Docker Compose directly on host; admin (optional) uses docker-socket-proxy |
| Guardian-only ingress | Channel adapters POST to Guardian only; Guardian HMAC-verifies every message |
| Assistant isolation | `assistant` has no Docker socket; when admin is present, calls Admin API on allowlist |
| LAN-first by default | All ports bind to `127.0.0.1`; nothing public without opt-in |

### HMAC signing

Each channel has its own secret (`CHANNEL_<NAME>_SECRET`). The channel adapter
signs the full JSON payload with HMAC-SHA256 before sending. Guardian verifies
the signature using the same secret. A message with a wrong or missing signature
is rejected at the door.

### Allowlist enforcement

The admin keeps an explicit allowlist of:
- **Legal service names** -- core services + any `channel-*` with a matching compose.yml
- **Legal actions** -- `install`, `update`, `uninstall`, `containers.*`,
  `channels.list`, `channels.install`, `channels.uninstall`, `artifacts.*`,
  `audit.list`

Anything not on the list is rejected with `400 invalid_service` or
`400 invalid_action`.

---

## Adding a Channel (the whole process)

1. Install from the registry via admin API or admin UI
2. Or manually: create a component directory under `config/components/` with a
   `compose.yml` defining the Docker service
3. Restart admin (triggers apply) or call `/admin/install`
4. Admin discovers the component, ensures/generates the channel HMAC secret, runs compose up

No code changes. No image rebuild. The channel is live.
