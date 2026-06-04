# Foundations

> Authoritative document. Do not edit without a specific request to do so, or direct approval.

This is the stripped-down runtime contract for OpenPalm.

It focuses on three things only:

- environment sources
- filesystem and mount boundaries
- Docker network boundaries

For the full architectural rule set, see `docs/technical/core-principles.md`. The security boundaries listed here are a summary; `core-principles.md` defines additional invariants (e.g., "host only by default") not repeated here.

---

## Global Rules

### Host root

All persistent runtime state lives under `OP_HOME`, which defaults to `~/.openpalm`.

```text
~/.openpalm/
├── config/          user-editable config (assistant/, akm/, guardian/)
│   └── stack/       live compose assembly (core.compose.yml, stack.yml, addons/) — no secrets, no env
├── knowledge/           AKM knowledge base (env/, secrets/, tasks/, skills/)
│   ├── env/         user.env (env:user) + stack.env (env:stack, Compose --env-file)
│   └── secrets/     system-managed service secrets + auth.json (akm secret — Compose grants)
├── data/            durable service data, logs, backups, rollback, akm/cache, akm/data
└── workspace/       shared work area
```

Lifecycle backups live under `~/.openpalm/data/backups/`; rollback snapshots live under `~/.openpalm/data/rollback/`.

### Compose env sources

The standard startup path uses:

- `knowledge/env/stack.env` — non-secret Compose substitution values: paths, ports, image tags, profiles, feature flags
- `knowledge/secrets/` — system-managed secret files granted to services through Compose `secrets:` and exposed as `*_FILE` variables
- `knowledge/env/user.env` — AKM env backing file for user-managed secrets; not a Compose env file

### Security boundaries

- The host CLI and host admin process access the Docker socket directly on the host. No container mounts the Docker socket.
- The host admin process reads and writes `$OP_HOME` directly as a host process. No container mounts the full `$OP_HOME`.
- `assistant` has no `/etc/vault/` mount — user secrets are read via `akm env:user` from the `knowledge/` bind mount.
- `guardian` is the only path from channel ingress networks to the assistant.

---

## Core Networks

| Network | Purpose | Core members |
|---|---|---|
| `assistant_net` | Core internal mesh | `assistant` (which also hosts the scheduler co-process), `guardian` |
| `channel_lan` | Default channel ingress (LAN-restricted) | `guardian` and LAN-facing channel addons |
| `channel_public` | Reserved for internet-facing channel ingress | `guardian` and public-facing channel addons. Access semantics and membership rules are under design. |

---

## Core Containers

### Assistant

Role:

- OpenCode runtime
- user-facing AI interaction
- memory, skills, and knowledge access via the akm CLI (shared akm stash)
- admin API client when admin is present

Env sources:

- direct compose `environment:` block
- selected values from `stack.env` (via compose `${VAR}` substitution)
- explicit secret file grants via Compose `secrets:` when needed

Key env:

- `OPENCODE_CONFIG_DIR=/etc/opencode`
- `OPENCODE_PORT=4096`
- `OPENCODE_AUTH=false` (safe because host bind defaults to 127.0.0.1; see § Security invariants #4 in core-principles.md)
- `OPENCODE_ENABLE_SSH`
- `AKM_STASH_DIR=/stash`, `AKM_CONFIG_DIR=/etc/akm`, `AKM_CACHE_DIR=/opt/akm/cache`, and `AKM_DATA_DIR=/opt/akm/data`
- `OP_UID`, `OP_GID`

Mounts:

- `$OP_HOME/config/assistant -> /etc/opencode`
- `$OP_HOME/config/akm -> /etc/akm`
- `$OP_HOME/knowledge/secrets/auth.json -> /home/opencode/.local/share/opencode/auth.json`
- `$OP_HOME/data/assistant -> /home/opencode`
- `$OP_HOME/knowledge -> /stash` (shared akm stash)
- `$OP_HOME/data/akm/cache -> /opt/akm/cache` and `$OP_HOME/data/akm/data -> /opt/akm/data`
- `$OP_HOME/workspace -> /work`
- `assistant-persistent -> /opt/persistent` (global-prefix escape hatch)

Ports and network:

- host: `${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3800}`
- host SSH: `${OP_ASSISTANT_SSH_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_SSH_PORT:-2222}`
- container: `4096`
- container SSH: `22`
- network: `assistant_net`

Security — provider secrets:

Provider keys are not stored in `stack.env`. They are stored as file-based secrets or OpenCode auth state and exposed to services through narrow grants. Secret-like environment variables must be `*_FILE` paths.

SSH (optional, gated by `OPENCODE_ENABLE_SSH=1`):

- Key-based authentication only (`PasswordAuthentication no`, `PubkeyAuthentication yes`)
- Root login disabled (`PermitRootLogin no`)
- TCP forwarding, X11 forwarding, and tunnels disabled
- PAM disabled; strict modes enforced
- Host keys auto-generated if missing (`ssh-keygen -A`)

Secret redaction (in-process logger):

- The shared logger in `@openpalm/lib` (`createLogger`) walks every structured `extra` payload and replaces values whose keys match the sensitive-key pattern (`(^|_)(TOKEN|SECRET|KEY|PASSWORD|HMAC)(_|$)`, case-insensitive) with `***REDACTED***` before the line is written to stdout/stderr. This applies to all services that use the shared logger (admin, guardian, channels, scheduler, CLI).
- Operators who want stronger guarantees should keep cloud secrets out of the assistant container by setting only the keys their selected provider needs; the assistant entrypoint already strips unused provider keys based on `SYSTEM_LLM_PROVIDER`.

### Guardian

Role:

- HMAC verification
- replay protection
- rate limiting
- channel-to-assistant ingress gateway

Env sources:

- direct compose `environment:` block (non-secret config via ${VAR} substitution)
- channel HMAC secret files granted through Compose `secrets:` from `knowledge/secrets/`

Key env:

- `PORT=8080`
- `OP_ASSISTANT_URL=http://assistant:4096`
- `OPENCODE_TIMEOUT_MS=0`
- `GUARDIAN_AUDIT_PATH=/opt/openpalm/logs/guardian-audit.log`
- `CHANNEL_<n>_SECRET_FILE`
- `OPENCODE_CONFIG_DIR=/etc/opencode` (moderator config from `config/guardian`)
- `GUARDIAN_CONTENT_VALIDATION` (off by default), `GUARDIAN_MODERATION_URL`, `GUARDIAN_MODERATION_PORT`, `GUARDIAN_MODERATION_THRESHOLD`, `GUARDIAN_MODERATION_TIMEOUT_MS` — opt-in content validation (see § Content validation)

Mounts:

- `$OP_HOME/data/guardian -> /opt/openpalm/guardian`
- `$OP_HOME/config/guardian -> /etc/opencode` (guardian OpenCode global config, `OPENCODE_CONFIG_DIR`)
- `$OP_HOME/knowledge/secrets/auth.json -> /opt/openpalm/guardian/.local/share/opencode/auth.json` (ro; shared OpenCode provider credentials, same file the assistant mounts)
- `$OP_HOME/data/logs -> /opt/openpalm/logs`
- Compose secret mounts under `/run/secrets/<name>` for guardian/channel HMAC verification

Ports and network:

- host: none
- container: `8080`
- networks: `channel_lan`, `channel_public`, `assistant_net`

Additional env:

- `GUARDIAN_SESSION_TTL_MS` -- Session TTL in milliseconds (default `900000` / 15 minutes). Sessions idle longer than this are evicted from the cache.

Channel payload metadata fields:

- `metadata.sessionKey` -- When present in the inbound message metadata, overrides the default per-user session key (`userId`). This allows channels to maintain multiple independent sessions per user.
- `metadata.clearSession: true` -- When set, clears all assistant sessions matching the resolved session target instead of sending a message. Returns `{ cleared: true }`.

Rate limits (fixed-window):

- Per-user: 120 requests/minute
- Per-channel: 200 requests/minute

Payload limits:

- Request body: 100 KB max (checked via both `Content-Length` header and raw body length)
- `channel`: 64 chars max
- `userId`: 256 chars max
- `nonce`: 128 chars max
- `text`: 10,000 chars max

Field length validation is enforced in `packages/channels-sdk/src/channel.ts` (shared between guardian and channel adapters).

Content validation (opt-in, off by default):

- The limits above are *structural* — they confirm a message is well-formed and signed, not that it is safe. When `GUARDIAN_CONTENT_VALIDATION` is enabled, the guardian adds a semantic stage before forwarding (`core/guardian/src/moderation.ts`).
- A deterministic heuristic pre-screen (`@openpalm/channels-sdk/content-screen`) scores prompt-injection / jailbreak / exfiltration / obfuscation signals. Clean traffic (score 0) forwards without touching a model.
- Messages over `GUARDIAN_MODERATION_THRESHOLD` escalate to the guardian's local OpenCode moderator (loopback `:4097`, started by the guardian entrypoint, small model pinned in `config/guardian/opencode.jsonc`, shared `auth.json` provider creds), which returns an allow/flag/block JSON verdict.
- **Fail-closed:** an escalated message the moderator cannot classify (down, timeout, unparseable) is blocked (`403 content_blocked`). The taxonomy + output contract live in `config/guardian/instructions/moderation.md`.

HTTP error responses (`{ error: "<code>", requestId: "<uuid>" }`):

| Code | HTTP | Cause |
|---|---|---|
| `invalid_json` | 400 | Body is not parseable JSON |
| `invalid_payload` | 400 | Missing/wrong-type field or out-of-bounds length |
| `payload_too_large` | 413 | Body exceeds 100 KB |
| `invalid_signature` | 403 | HMAC mismatch, unknown channel, or missing signature |
| `replay_detected` | 409 | Nonce already seen in the 5-minute window |
| `rate_limited` | 429 | Per-user (120 req/min) or per-channel (200 req/min) exceeded |
| `content_blocked` | 403 | Blocked by content-validation stage (opt-in, fail-closed) |
| `assistant_unavailable` | 502 | Could not reach or get a response from the assistant |
| `not_found` | 404 | Unrecognised endpoint |

Notes:

- Guardian is internal-only from the host perspective.
- It is the only bridge between addon ingress networks and `assistant_net`.

### Scheduler co-process

Role:

- scheduled automation execution
- admin API caller (via the assistant token)
- assistant client (calls the co-resident OpenCode runtime over `localhost`)

The scheduler is a Bun co-process that runs **inside the assistant
container** (started by `core/assistant/entrypoint.sh`). It has no
network port and no Docker socket.

Control plane:

- Definitions: `${OP_HOME}/knowledge/tasks/*.yml` (AKM YAML task files; `akm tasks sync` registers with OS cron)
- Manual triggers: `POST /admin/automations/<name>/run` spawns `akm tasks run <name>` directly
- Per-run logs: `${OP_HOME}/data/akm/cache/tasks/logs/<name>/` (written by akm)
- Sync output is emitted to container stdout/stderr.

Env sources (inherits the assistant container's environment):

- `OPENCODE_API_URL=http://localhost:4096` (co-resident OpenCode; auth disabled on this interface)

Mounts (provided by the assistant service):

- `$OP_HOME/config/assistant -> /etc/opencode` and `$OP_HOME/config/akm -> /etc/akm`
- `$OP_HOME/knowledge/tasks -> /knowledge/tasks` (rw, AKM YAML task files)
- `$OP_HOME/data/akm/cache -> /opt/akm/cache` and `$OP_HOME/data/akm/data -> /opt/akm/data` (rw, akm cache, task logs, databases, and durable data)

Design note — scheduler scope: The scheduler runs as part of the
assistant container, so it shares the assistant's identity and trust
posture. Because it has no network listener, no separate admin↔scheduler
token is required.

Ports and network:

- host: none
- container: none (in-process; uses `localhost` for assistant API calls)
- network: shares the assistant's network membership

---

## Admin (host process)

Admin is a Bun.serve HTTP server started by `openpalm`. It serves the `@openpalm/ui` SvelteKit build (resolved from `OP_HOME/data/ui` by `resolveUiBuildDir()`, seeded on install/update by fetching the `@openpalm/ui` npm registry tarball and verifying its sha512 integrity fail-closed) and manages Docker Compose directly on the host via the host Docker socket. There is no admin container.

Role:

- web UI and API (SvelteKit, served as a static build)
- lifecycle orchestration via host Docker socket (`/var/run/docker.sock` or `$DOCKER_HOST`)
- control-plane file management under `$OP_HOME` (direct host filesystem access)

Key env:

- `PORT` — listen port (default: `3880`)
- `OP_HOME` — resolved from the host environment
- `OP_UI_LOGIN_PASSWORD` — read from `$OP_HOME/knowledge/secrets/op_ui_login_password`; used to verify the admin login form

Bind address:

- `127.0.0.1:${OP_HOST_UI_PORT:-3880}` (loopback only — never exposed to Docker networks or LAN)

UI-first principle: the admin UI is the primary operator interface. CLI commands are the fallback for scripted workflows and headless environments.

---

## Addon Edge Pattern

Shipped channel-style addons follow the same basic pattern:

- receive their channel HMAC secret via a Compose secret file grant from `knowledge/secrets/` and a matching `*_FILE` environment variable
- join `channel_lan` by default (or `channel_public` for internet-facing channels once that network's access semantics are finalized)
- depend on `guardian`
- send signed traffic to guardian, not directly to assistant

Channel secret distribution: when a channel addon is installed, a shared HMAC secret is generated as a `0600` file under `knowledge/secrets/`. Compose grants that file only to the matching channel service and the guardian. The channel SDK uses this secret to sign outbound requests; the guardian uses it to verify inbound requests.

Default host binds for shipped HTTP-ish edges:

- `chat`: `127.0.0.1:3820 -> 8181`
- `api`: `127.0.0.1:3821 -> 8182`
- `voice`: `127.0.0.1:3810 -> 8186`

`discord` and `slack` do not expose host ports in the shipped overlays.

Addon metadata labels:

Addon compose files use `openpalm.*` Docker labels for discovery and UI metadata:

- `openpalm.name` (required) — human-readable display name
- `openpalm.description` (required) — short description
- `openpalm.icon` (optional) — Lucide icon name
- `openpalm.category` (optional) — `messaging`, `ai`, `integration`, `management`
- `openpalm.healthcheck` (optional) — internal health check URL

The admin UI reads first-party addon metadata from the fixed compose files under `config/stack/` and active first-party state from `config/stack/stack.yml`; runtime Compose uses those fixed files plus profiles derived from addon state, not Docker labels alone.

---

## CLI Install

The setup wizard runs on `127.0.0.1:8190` by default. The port is configurable via the `OP_SETUP_PORT` environment variable.
