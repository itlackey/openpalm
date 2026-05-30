# How OpenPalm Works — TLDR

OpenPalm is two things: a **harness** and a **stack**.

The **harness** (CLI or Electron app) runs on your host machine. Its only job is to manage the files in `~/.openpalm/` — Docker Compose files, env files, OpenCode configuration, AKM configuration — and then start `docker compose up`. No harness, no problem: a technical user can do the same thing by hand.

The **stack** is what the harness runs. At its core: an OpenCode assistant in Docker (with persistent memory and skills via AKM), a Guardian that enforces HMAC-signed verification on every inbound channel message, and optional channel containers that translate external protocols into signed guardian messages.

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

### Harness UI (SvelteKit app, host port 3880)
The web face of the harness. Started by `openpalm ui serve` as a host process — no container. Accesses Docker and `~/.openpalm/` directly on the host.

Responsibilities:
- Writes runtime configuration directly to `~/.openpalm/config/stack/` and `~/.openpalm/config/akm/`
- Runs `docker compose` for all lifecycle operations (install, update, up, down, restart)
- Exposes an authenticated API used by the browser UI and the assistant
- Manages first-party addon activation in `~/.openpalm/config/stack/enabled-addons.json`, materializes it into `~/.openpalm/config/stack/addons.compose.yml`, supports custom overlays in `~/.openpalm/config/stack/addons/`, and reads addon metadata from `~/.openpalm/state/registry/`
- Writes the audit log

### Guardian (Bun server, port 8080)
The security checkpoint for all inbound channel traffic.

For every inbound message it:
1. Verifies HMAC signature using the channel secret file granted through `CHANNEL_<NAME>_SECRET_FILE`
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
`/home/opencode/.config/opencode`, mounts `~/.openpalm/config/auth.json`
for OpenCode auth state, and mounts the full AKM stash from `~/.openpalm/stash/`
at `/akm` for persistent memory and skills. Provider API keys are stored in OpenCode's
auth.json via the Connections tab. Its durable home is `~/.openpalm/state/assistant/`,
and its shared workspace is `~/.openpalm/workspace/` mounted at `/work`.

### Addon edge services (e.g. `chat`, host port 3820)
Translate external protocols into signed Guardian messages. The `chat` addon is
the lighter conversational edge, while `api` is the broader compatibility
facade. Discord, Slack, and voice addons speak their native protocols. All of
them do the same thing at the end: sign the message with their HMAC secret and
POST it to Guardian.

The runtime image for registry-backed adapters is the unified
`channel`, built from `core/channel/Dockerfile`.

### Supporting services
- **Scheduler** -- OS cron daemon (`crond`) started by the assistant container entrypoint. Automations are AKM markdown task files in `~/.openpalm/stash/tasks/`; `akm tasks sync` registers them with cron at boot and re-syncs every 60 s to pick up new files written by admin.
- **AKM stash** -- persistent memory and knowledge live in the shared akm stash at `~/.openpalm/stash/`, mounted at `/akm` in the assistant. Skills, commands, memories, and knowledge files all live here. There is no separate memory service.

---

## Message Flow (end to end)

```
User sends message via chat client
        |
        v
chat :3820 (host) -> :8181 (container)
  Reads CHANNEL_CHAT_SECRET_FILE
  Signs message: HMAC-SHA256(channel secret, payload)
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
User requests stack operation via admin chat UI → host admin process calls docker compose restart
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
                    Install seeds the registry catalog and base stack files
                               |
                               v
                    You / CLI enable addons into stack/addons/:
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
~/.openpalm/config/stack/core.compose.yml         -> base compose definition
~/.openpalm/config/stack/enabled-addons.json      -> first-party addon activation
~/.openpalm/config/stack/addons.compose.yml       -> generated first-party addon compose bundle
~/.openpalm/config/stack/addons/custom/compose.yml -> custom addon overlay
~/.openpalm/state/registry/addons/chat/.env.schema -> addon config contract
~/.openpalm/config/stack/stack.env          -> non-secret values passed via --env-file
~/.openpalm/stash/vaults/secrets/           -> system-managed Compose secret files
~/.openpalm/stash/vaults/user.env           -> user-managed secrets (akm vault:user)
```

Docker reads compose files, the non-secret env file, and secret files directly from their final locations.
There is no intermediate staging step. The standard wrapper includes
`config/stack/stack.env`; Compose `secrets:` grants files from `stash/vaults/secrets/`.

---

## Security Model

| Invariant | Enforcement |
|-----------|-------------|
| Host CLI or admin is the orchestrator | CLI manages Docker Compose directly on host; admin (optional) runs as a host process with direct Docker access |
| Guardian-only ingress | Channel adapters POST to Guardian only; Guardian HMAC-verifies every message |
| Assistant isolation | `assistant` has no Docker socket; when admin is present, calls Admin API on allowlist |
| LAN-first by default | Host-exposed ports bind to `127.0.0.1`; nothing public without opt-in |

### HMAC signing

Each channel has its own secret file. The channel adapter reads the path from
`CHANNEL_<NAME>_SECRET_FILE` and signs the full JSON payload with HMAC-SHA256
before sending. Guardian receives the same secret through an explicit Compose
secret grant and rejects messages with wrong or missing signatures at the door.

### Allowlist enforcement

The admin keeps an explicit allowlist of:
- **Legal service names** -- core services + any installed addon service such as `chat`, `api`, or `voice`
- **Legal actions** -- lifecycle/config endpoints, `containers.*`, `addons.*`,
  `registry.*` (automations), `artifacts.*`, and `audit.*` routes implemented by admin

Anything not on the list is rejected with `400 invalid_service` or
`400 invalid_action`.

---

## Adding a Channel (the whole process)

1. Browse the available catalog entry in `~/.openpalm/state/registry/addons/<name>/` via admin API, admin UI, or direct file inspection
2. Enable it by adding `<name>` to `~/.openpalm/config/stack/enabled-addons.json`
3. OpenPalm materializes first-party addons into `~/.openpalm/config/stack/addons.compose.yml`, or you can hand-author `~/.openpalm/config/stack/addons/<name>/` for a custom or multi-instance setup
4. Rerun `docker compose` with that addon included
5. If admin tooling is involved, it may also ensure/generate the channel HMAC secret first

No code changes. No image rebuild. The channel is live.
