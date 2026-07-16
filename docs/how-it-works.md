# How OpenPalm Works — TLDR

OpenPalm is two things: a **harness** and a **stack**.

The **harness** (CLI or Electron app) runs on your host machine. Its only job is to manage the files in `~/.openpalm/` — Docker Compose files, env files, OpenCode configuration, AKM configuration — and then start `docker compose up`. No harness, no problem: a technical user can do the same thing by hand.

The **stack** is what the harness runs. At its core: an OpenCode assistant in Docker (with persistent memory and skills via AKM), a Guardian that enforces principal-authenticated ingress on every inbound portal/direct request, and optional portal containers that translate external protocols into guardian `/oc/*` traffic.

---

## The Big Picture

```
You (browser / CLI / API client)
        |
        v
Admin :3880                  Addon edge (e.g. chat :3820, api :3821)
                                    |
                                    v
                             Guardian :8080 (internal)   <- validates every addon message
                                    |
                                    v
                             Assistant :3800 host / :4096 internal
                                    |
                                    v
                             Admin API                   <- host/admin process only
```

> **Port note:** Guardian listens on port 8080 inside its container and exposes
> localhost-only direct/admin listeners by default; it is not publicly exposed.

Three hard rules define the whole design:
1. **The host CLI or the admin may orchestrate Docker.**
2. **Every portal or direct-ingress request goes through Guardian.** No exceptions.
3. **Assistant has no Docker socket or admin network path.** Host/admin processes do stack operations.

---

## Components

### Harness UI (SvelteKit app, host port 3880)
The web face of the harness. Runs as a host process — no container. Accesses Docker and `~/.openpalm/` directly on the host.

Three ways to reach the admin surface (all loopback-only — host admin is never reachable remotely):
- **Electron app** — the desktop harness supervises the UI process and opens it with the admin capability enabled.
- **`openpalm admin`** — the CLI serves the same UI with the admin capability enabled, prints the URL, and opens your browser. This mode refuses non-loopback bind config: `OP_ALLOW_REMOTE_SETUP` is ignored and neutralized. On a machine with no install it lands on the `/setup` wizard.
- **Dev only: `OP_ENABLE_ADMIN=1`** — set on a locally run UI server (e.g. the dev server) to enable the admin capability without a harness. Never set this in production.

Responsibilities:
- Writes runtime configuration directly to `~/.openpalm/config/stack/`, `~/.openpalm/knowledge/env/stack.env`, and `~/.openpalm/config/akm/`
- Runs `docker compose` for all lifecycle operations (install, update, up, down, restart)
- Exposes an authenticated API used by the browser UI and the assistant
- Manages first-party addon activation in `~/.openpalm/knowledge/env/stack.env` via `OP_ENABLED_ADDONS`, resolves enabled addons to Compose profiles, and supports custom services in `custom.compose.yml`
- Writes the audit log

### Guardian (Bun server, port 8080)
The security checkpoint for all inbound portal traffic. Guardian is a
**transparent 1:1 reverse proxy** in front of the assistant's OpenCode server —
it forwards every method/path/query/body and streams responses (including SSE)
untouched, with fail-closed policy overlays on the handful of tenant-scoped
paths (never an allowlist, never a second protocol). The image also ships the
OpenCode binary so it can run optional content validation (below).

For every inbound request it:
1. Canonicalizes the request path (percent-decode + `..` traversal refusal), then classifies the tenant-scoped route
2. Authenticates the principal with Basic auth using `PRINCIPAL_ID` and `PRINCIPAL_SECRET_FILE` (the principal id is the Basic username)
3. Enforces session/permission ownership (persisted in Guardian's SQLite state DB, so a restart no longer orphans live sessions) and rate/resource limits
4. **Optional content validation** (`GUARDIAN_CONTENT_VALIDATION`, off by default): a heuristic pre-screen escalates suspicious prompt-bearing writes to a local OpenCode moderator that returns allow/flag/block. Fail-closed — an unclassifiable suspicious request is blocked (`403 content_blocked`).
5. Forwards the request to the assistant's OpenCode, injecting upstream credentials server-side and stripping the inbound Guardian credentials + hop-by-hop headers

A message that fails an overlay check never reaches the assistant.

### Assistant (OpenCode runtime, host port 3800)
The AI. Runs OpenCode. Has no Docker socket.

The assistant does not manage the stack directly. Stack operations remain host-side
through the CLI or admin UI process.

The assistant uses OpenCode config from `/etc/opencode`, mounts
`~/.openpalm/knowledge/secrets/auth.json` for host-managed OpenCode auth state, mounts AKM
config at `/etc/akm`, mounts the full AKM stash from `~/.openpalm/knowledge/` at
`/stash`, and stores AKM cache/data under `/opt/akm/cache` and `/opt/akm/data`.
Provider API keys are stored in OpenCode's auth.json via the Connections tab.
Its durable home is `~/.openpalm/data/assistant/`, and its shared workspace is
`~/.openpalm/workspace/` mounted at `/work`.

### Addon edge services (e.g. `chat`, host port 3820)
Translate external protocols into Guardian `/oc/*` requests. The `chat` addon is
the lighter conversational edge, while `api` is the broader compatibility
facade. Discord and Slack addons speak their native protocols; the voice addon
is not a portal at all — it serves OpenAI-compatible TTS/STT on host loopback,
reached by chat clients through the admin UI's same-origin `/voice/*`
pass-through. Portal adapters authenticate with Basic auth and call Guardian.

The runtime image for registry-backed adapters is the unified
`portal`, built from `containers/portal/Dockerfile`.

### Supporting services
- **Scheduler** -- OS cron daemon (`crond`) started by the assistant container entrypoint. Automations are AKM YAML task files (`*.yml`) in `~/.openpalm/knowledge/tasks/`; `akm tasks sync` registers them with cron at boot and re-syncs every 60 s to pick up new files written by admin.
- **AKM stash** -- persistent memory and knowledge live in the shared akm stash at `~/.openpalm/knowledge/`, mounted at `/stash` in the assistant. Skills, commands, memories, and knowledge files all live here. There is no separate memory service.

---

## Message Flow (end to end)

```
User sends a message (Discord / Slack / OpenAI-compatible API)
        |
        v
portal adapter (:3820 host -> :8182 container for chat/api)
  Reads PRINCIPAL_SECRET_FILE
  Calls guardian:8080/oc/* with Basic auth
  Streams /event frames for the owned session
        |
        v
Guardian validates:
  + Principal credentials match a seeded token
  + Request path is canonical (percent-decoded, no `..` traversal)
  + Session/permission ownership matches the principal
  + Rate limit and resource bounds allow the call
  + Content validation (optional, fail-closed): heuristic screen -> local moderator
        |
        v
Guardian proxies native OpenCode traffic to assistant:4096
        |
        v
Assistant (OpenCode) processes the message
  Calls tools, reads memory, generates response
        |
        v
Response and event frames flow back through Guardian -> portal adapter -> user
```

If a user needs a stack operation during a session, that remains a host-side admin
or CLI action, not an assistant-container network path.

---

## Lifecycle (install / update)

```
openpalm install   ->   writes files into ~/.openpalm/
                              |
                              v
                    Install seeds the base compose files and stack.env
                               |
                               v
                    You / CLI enable addons via OP_ENABLED_ADDONS:
                        core.compose.yml (always)
                        + portals.compose.yml / services.compose.yml
                        + --profile addon.<name> per enabled addon
                        + custom.compose.yml for custom services
                              |
                              v
                    docker compose -f <files> --profile <addons> up -d
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
~/.openpalm/config/stack/core.compose.yml     -> core assistant runtime compose definition
~/.openpalm/config/stack/services.compose.yml -> first-party optional services
~/.openpalm/config/stack/portals.compose.yml -> first-party optional portals and guardian
~/.openpalm/config/stack/custom.compose.yml   -> custom services and overlays
~/.openpalm/knowledge/env/stack.env            -> non-secret values passed via --env-file
~/.openpalm/knowledge/secrets/             -> system-managed Compose secret files
~/.openpalm/knowledge/env/user.env             -> user-managed secrets (akm env:user)
```

Docker reads compose files, the non-secret env file, and secret files directly from their final locations.
There is no intermediate staging step. The standard wrapper includes
`knowledge/env/stack.env`; Compose `secrets:` grants files from `knowledge/secrets/`.

---

## Security Model

| Invariant | Enforcement |
|-----------|-------------|
| Host CLI or admin is the orchestrator | CLI manages Docker Compose directly on host; admin (optional) runs as a host process with direct Docker access |
| Guardian-only ingress | Portal adapters call Guardian `/oc/*` only; Guardian authenticates principals and enforces ownership on every request |
| Assistant isolation | `assistant` has no Docker socket and no admin network path |
| LAN-first by default | Host-exposed ports bind to `127.0.0.1`; nothing public without opt-in |

### Principal authentication

Each portal has its own principal secret file. The portal adapter reads the path
from `PRINCIPAL_SECRET_FILE`, authenticates to Guardian with Basic auth, and
Guardian enforces per-call auth, session/permission ownership, and its
fail-closed policy overlays before transparently proxying `/oc/*`.

### Admin action allowlist

The admin API (host control plane) keeps an explicit allowlist of:
- **Legal service names** -- core services + any installed addon service such as `chat`, `api`, or `voice`
- **Legal actions** -- lifecycle/config endpoints, `containers.*`, `addons.*`,
  `registry.*` (automations), `artifacts.*`, and `audit.*` routes implemented by admin

Anything not on the list is rejected with `400 invalid_service` or
`400 invalid_action`.

---

## Adding a Portal (the whole process)

**First-party portal (chat, api, discord, slack):**
1. Add the addon name to `OP_ENABLED_ADDONS` in `~/.openpalm/knowledge/env/stack.env` through the CLI or admin UI.
2. OpenPalm resolves the name to a `--profile addon.<name>` argument against `portals.compose.yml`.
3. Rerun the OpenPalm compose command (or use the admin UI restart action).
4. If admin tooling is involved, it may also ensure/generate the required principal secret files first.

**Custom portal:**
1. Add a service definition to `~/.openpalm/config/stack/custom.compose.yml`.
2. Rerun the compose command — `custom.compose.yml` is always included.

No code changes. No image rebuild. The portal is live.
