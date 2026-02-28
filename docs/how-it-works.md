# How OpenPalm Works — TLDR

OpenPalm is a local-first AI assistant platform. It runs as a Docker Compose
stack on your machine. Everything is LAN-only by default, nothing is in the
cloud, and all persistent data stays on your host.

---

## The Big Picture

```
You (browser / CLI / chat client)
        │
        ▼
   Caddy :80 (→ host:8080)    ← only public-facing ingress
   │         │
   ▼         ▼
Admin      Channel adapter (e.g. channel-chat :8181)
:8100            │
                 ▼
            Guardian :8080 (internal)   ← validates every channel message
                 │
                 ▼
            Assistant :4096             ← OpenCode runtime
                 │
                 ▼
            Admin API                   ← assistant requests stack ops here
```

> **Port note:** Caddy listens on port 80 inside its container, mapped to
> host port 8080. Guardian listens on port 8080 inside its container but is
> not exposed on the host — it is only reachable on the Docker network.
> They do not conflict because they are on different Docker networks.

Three hard rules define the whole design:
1. **Admin is the only component that touches Docker.**
2. **Every channel message goes through Guardian.** No exceptions.
3. **Assistant has no Docker socket.** It asks Admin to do things.

---

## Components

### Caddy (reverse proxy)
The front door. Receives all HTTP traffic on `:8080` and routes it:

| Path | Destination | Default access |
|------|-------------|----------------|
| `/admin/*` | Admin UI + API | LAN only |
| `/admin/opencode/*` | Assistant UI | LAN only |
| `/admin/openmemory/*` | Memory dashboard | LAN only |
| `/guardian/*` | Guardian | Unrestricted (Guardian enforces its own auth) |
| channel routes | Channel adapters | LAN only by default |

Channel routes are loaded via `import channels/lan/*.caddy` and
`import channels/public/*.caddy` — Caddy picks them up automatically when the
admin stages them into STATE_HOME.

### Admin (SvelteKit app, port 8100)
The control plane. Only component with Docker socket access.

Responsibilities:
- Assembles runtime artifacts (compose files, Caddyfile, secrets) from user
  config into STATE_HOME
- Runs `docker compose` for all lifecycle operations (install, update, up, down,
  restart)
- Exposes an authenticated API used by the CLI, the browser UI, and the assistant
- Writes the audit log
- Discovers installed channels by scanning `CONFIG_HOME/channels/`, then stages
  overlays/snippets into `STATE_HOME/artifacts/channels/` for runtime
- Installs channels from the registry catalog on demand via the API

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
calls the Admin API using `OPENPALM_ADMIN_TOKEN`. The Admin allowlists which
actions and service names are legal — the assistant can't do anything
unauthorized.

Extensions live in two places:
- `/opt/opencode/` — core extensions baked into the image (always loaded,
  higher precedence)
- `CONFIG_HOME/opencode/` — user extensions mounted at runtime (no rebuild
  needed)

### Channel adapters (e.g. channel-chat, port 8181)
Translate external protocols into signed Guardian messages. The chat channel
speaks the OpenAI API protocol. Discord, Telegram, and voice channels speak
their native protocols. All of them do the same thing at the end: sign the
message with their HMAC secret and POST it to Guardian.

### Supporting services
- **Postgres** — relational storage
- **Qdrant** — vector store for semantic memory
- **OpenMemory** — memory MCP server backed by Qdrant; gives the assistant
  persistent memory across conversations
- **OpenMemory UI** — dashboard at `/admin/openmemory/`

---

## Message Flow (end to end)

```
User sends message via chat client
        │
        ▼
channel-chat :8181
  Signs message: HMAC-SHA256(CHANNEL_CHAT_SECRET, payload)
  POSTs to guardian:8080/channel/inbound
        │
        ▼
Guardian validates:
  ✓ HMAC signature correct
  ✓ Timestamp within 5 min skew
  ✓ Not a replayed nonce
  ✓ Rate limit not exceeded
  ✓ Payload shape valid
        │
        ▼
Guardian forwards to assistant:4096
        │
        ▼
Assistant (OpenCode) processes the message
  Calls tools, reads memory, generates response
        │
        ▼
Response flows back through Guardian → channel-chat → user
```

If the assistant needs to do a stack operation during its turn (e.g., restart
a service):

```
Assistant calls POST http://admin:8100/admin/containers/restart
  Header: x-admin-token: <ADMIN_TOKEN>
  Body:   { "service": "channel-chat" }
        │
        ▼
Admin validates token + allowlists service name
Runs: docker compose restart channel-chat
Writes audit entry
Returns result
```

---

## Lifecycle (install / update)

```
openpalm install   →   POST /admin/install
                             │
                             ▼
                   Admin stages artifacts:
                     copies core compose → STATE_HOME/artifacts/docker-compose.yml
                      stages core Caddyfile (from DATA_HOME) → STATE_HOME/artifacts/Caddyfile
                     copies secrets.env  → STATE_HOME/artifacts/secrets.env
                     stages channel .yml → STATE_HOME/artifacts/channels/
                     stages channel .caddy → STATE_HOME/artifacts/channels/lan/ or public/
                             │
                             ▼
                   Admin runs: docker compose -f <staged files> up -d
```

**Apply is idempotent.** The admin also runs it automatically on startup —
restarting the admin container syncs your latest config changes into the
running stack.

---

## File Assembly Model

OpenPalm doesn't generate config by filling in templates. It copies whole files.

```
CONFIG_HOME/channels/chat.yml   ──copy──▶  STATE_HOME/artifacts/channels/chat.yml
CONFIG_HOME/channels/chat.caddy ──copy──▶  STATE_HOME/artifacts/channels/lan/chat.caddy
CONFIG_HOME/secrets.env         ──copy──▶  STATE_HOME/artifacts/secrets.env
assets/docker-compose.yml       ──copy──▶  STATE_HOME/artifacts/docker-compose.yml
DATA_HOME/caddy/Caddyfile       ──copy──▶  STATE_HOME/artifacts/Caddyfile
```

Docker and Caddy read exclusively from STATE_HOME at runtime. CONFIG_HOME is
never read directly by Docker or Caddy — it's only read by the admin during
apply.

`STATE_HOME/artifacts/secrets.env` is a verbatim copy of
`CONFIG_HOME/secrets.env`. System-managed values (`POSTGRES_PASSWORD` and
channel HMAC secrets) are written into `STATE_HOME/artifacts/stack.env`
separately — they do not appear in the staged `secrets.env`.

Access scope is controlled by the system-managed core Caddyfile in
`DATA_HOME/caddy/Caddyfile` (the `@denied not remote_ip ...` line), which admin
stages into `STATE_HOME/artifacts/Caddyfile`.

### Caddyfile lifecycle

Three copies of the Caddyfile exist in the system:

1. **`assets/Caddyfile`** — Immutable template bundled into the admin image.
   Used to seed `DATA_HOME/caddy/Caddyfile` on first install. Contains
   `import lan_only` snippets for default LAN access control.
2. **`DATA_HOME/caddy/Caddyfile`** — Mutable system-managed source of truth.
   The admin mutates the `@denied not remote_ip ...` line here when the
   access scope changes via `POST /admin/access-scope`. This file persists
   across reinstalls (it lives in DATA_HOME).
3. **`STATE_HOME/artifacts/Caddyfile`** — Staged runtime copy. Read-only mount into
   Caddy's container. Regenerated from `DATA_HOME/caddy/Caddyfile` on
   every apply.

Caddy only reads from `STATE_HOME/artifacts/Caddyfile` at runtime. User-facing access
scope changes flow: API → `DATA_HOME/caddy/Caddyfile` → re-stage to
`STATE_HOME/artifacts/Caddyfile` → Caddy reload.

---

## Security Model

| Invariant | Enforcement |
|-----------|-------------|
| Admin is sole orchestrator | Only `admin` container mounts `/var/run/docker.sock` |
| Guardian-only ingress | Channel adapters POST to Guardian only; Guardian HMAC-verifies every message |
| Assistant isolation | `assistant` has no Docker socket; calls Admin API on allowlist only |
| LAN-first by default | All ports bind to `127.0.0.1`; Caddy restricts by IP range; nothing public without opt-in |

### HMAC signing

Each channel has its own secret (`CHANNEL_<NAME>_SECRET`). The channel adapter
signs the full JSON payload with HMAC-SHA256 before sending. Guardian verifies
the signature using the same secret. A message with a wrong or missing signature
is rejected at the door.

### Allowlist enforcement

The admin keeps an explicit allowlist of:
- **Legal service names** — core services + any `channel-*` with a staged `.yml`
- **Legal actions** — `install`, `update`, `uninstall`, `containers.*`,
  `channels.list`, `channels.install`, `channels.uninstall`, `artifacts.*`,
  `audit.list`, `accessScope.*`

Anything not on the list is rejected with `400 invalid_service` or
`400 invalid_action`.

---

## Adding a Channel (the whole process)

1. Drop `<name>.yml` into `CONFIG_HOME/channels/` — defines the Docker service
2. Drop `<name>.caddy` into `CONFIG_HOME/channels/` — gives it an HTTP route
   (optional; without this it's Docker-network only)
3. Restart admin (triggers apply) or call `/admin/update`
4. Admin stages files, ensures/generates the channel HMAC secret, runs compose up, reloads
   Caddy

No code changes. No image rebuild. The channel is live.
