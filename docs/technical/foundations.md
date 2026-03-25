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
├── config/     user-editable non-secret config
├── stack/      live compose assembly
├── vault/      secrets boundary
├── data/       durable service data
├── logs/       audit and debug logs
└── backups/    durable upgrade backup snapshots
```

Ephemeral cache lives under `~/.cache/openpalm/`.

### Compose env sources

The standard startup path uses:

- `vault/stack/stack.env` — primary: all config, secrets, and resolved capabilities (OP_CAP_*)
- `vault/user/user.env` — extension: optional user additions, loaded alongside stack.env
- `vault/stack/guardian.env` — guardian-specific: channel HMAC secrets. Not shipped in the bundle; created by the CLI installer when the first channel is installed. Compose marks it `required: false`.

### Security boundaries

- Only `docker-socket-proxy` mounts the Docker socket.
- Only `admin` mounts the full OpenPalm home (`$OP_HOME -> /openpalm`).
- `assistant` mounts only `vault/user/` (the directory, rw) from the vault boundary, not the whole vault directory.
- `guardian` is the only path from channel ingress networks to the assistant.

---

## Core Networks

| Network | Purpose | Core members |
|---|---|---|
| `assistant_net` | Core internal mesh | `memory`, `assistant`, `guardian`, `scheduler`, optional `admin` |
| `channel_lan` | Default channel ingress (LAN-restricted) | `guardian` and LAN-facing channel addons |
| `channel_public` | Reserved for internet-facing channel ingress | `guardian` and public-facing channel addons. Access semantics and membership rules are under design. |
| `admin_docker_net` | Isolated Docker control plane | `admin`, `docker-socket-proxy`. Only exists when the admin addon is installed. |

---

## Core Containers

### Memory

Role:

- persistent memory API
- vector storage and embeddings support

Env sources:

- `stack.env` (via compose ${VAR} substitution)
- `user.env` (optional user additions via compose ${VAR} substitution)

Key env:

- `MEMORY_DATA_DIR=/data`
- `HOME=/data`
- `MEM0_DIR=/data/.mem0`
- `MEMORY_AUTH_TOKEN` (set from `OP_MEMORY_TOKEN` in stack.env)
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`

Mounts:

- `$OP_HOME/data/memory -> /data`

Ports and network:

- host: `${OP_MEMORY_BIND_ADDRESS:-127.0.0.1}:${OP_MEMORY_PORT:-3898}`
- container: `8765`
- network: `assistant_net`

### Assistant

Role:

- OpenCode runtime
- user-facing AI interaction
- memory client
- admin API client when admin is present

Env sources:

- direct compose `environment:` block
- `user.env` bind-mounted into the container (optional user additions)
- selected values from `stack.env` (via compose `${VAR}` substitution)

Key env:

- `OPENCODE_CONFIG_DIR=/etc/opencode`
- `OPENCODE_PORT=4096`
- `OPENCODE_AUTH=false` (safe because host bind defaults to 127.0.0.1; see § Security invariants #4 in core-principles.md)
- `OPENCODE_ENABLE_SSH`
- `OP_ADMIN_API_URL`
- `OP_ASSISTANT_TOKEN`
- `MEMORY_API_URL=http://memory:8765`
- `MEMORY_AUTH_TOKEN` (set from `OP_MEMORY_TOKEN` in stack.env)
- `MEMORY_USER_ID`
- `OP_UID`, `OP_GID`

Mounts:

- image-baked `/etc/opencode`
- `$OP_HOME/data/assistant -> /home/opencode/`
- `$OP_HOME/data/stash -> /home/opencode/.akm`
- `$OP_HOME/data/workspace -> /work`
- `$OP_HOME/config -> /etc/openpalm`
- `$OP_HOME/config/assistant -> /home/opencode/.config/opencode`
- `$OP_HOME/vault/stack/auth.json -> /home/opencode/.local/share/opencode/auth.json`
- `$OP_HOME/vault/user/ -> /etc/vault/` (directory mount, rw)
- `$OP_HOME/logs/opencode -> /home/opencode/.local/state/opencode`

Ports and network:

- host: `${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3800}`
- host SSH: `${OP_ASSISTANT_SSH_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_SSH_PORT:-2222}`
- container: `4096`
- container SSH: `22`
- network: `assistant_net`

Security — provider-key pruning:

The entrypoint removes unused provider API keys from the process environment based on `SYSTEM_LLM_PROVIDER`. For example, if the provider is `openai`, keys for Anthropic, Groq, Mistral, and Google are unset before OpenCode starts, reducing secret exposure in the LLM context. Local-only providers (`ollama`, `lmstudio`, `model-runner`) unset all cloud provider keys.

SSH (optional, gated by `OPENCODE_ENABLE_SSH=1`):

- Key-based authentication only (`PasswordAuthentication no`, `PubkeyAuthentication yes`)
- Root login disabled (`PermitRootLogin no`)
- TCP forwarding, X11 forwarding, and tunnels disabled
- PAM disabled; strict modes enforced
- Host keys auto-generated if missing (`ssh-keygen -A`)

Secret redaction (varlock):

- Process-level: when varlock is available, the OpenCode process is launched via `varlock run --path <schema-dir> --` which redacts secret values from the process environment.
- Shell-level: `SHELL` is set to `/usr/local/bin/varlock-shell`, a wrapper that runs all `bash -c` invocations (OpenCode's shell tool) through `varlock run`, redacting secrets from command output before they enter the LLM context window. Interactive PTY sessions fall back to plain `/bin/bash`.

### Guardian

Role:

- HMAC verification
- replay protection
- rate limiting
- channel-to-assistant ingress gateway

Env sources:

- direct compose `environment:` block (non-secret config via ${VAR} substitution)
- `vault/stack/guardian.env` as compose `env_file` (channel HMAC secrets). This file is not shipped; it is created by the CLI installer when the first channel is installed. Compose marks it `required: false`, so the guardian starts without it.
- same file mounted at `GUARDIAN_SECRETS_PATH` for mtime-based hot-reload

Key env:

- `PORT=8080`
- `OP_ASSISTANT_URL=http://assistant:4096`
- `OPENCODE_TIMEOUT_MS=0`
- `OP_ADMIN_TOKEN=${OP_ADMIN_TOKEN:-}`
- `GUARDIAN_AUDIT_PATH=/app/audit/guardian-audit.log`
- `CHANNEL_<n>_SECRET`

Mounts:

- `$OP_HOME/data/guardian -> /app/data`
- `$OP_HOME/logs -> /app/audit`
- `$OP_HOME/vault/stack/guardian.env -> /app/secrets/guardian.env:ro` (created by CLI installer; absent until first channel install)

Ports and network:

- host: none
- container: `8080`
- networks: `channel_lan`, `channel_public`, `assistant_net`

Additional env:

- `GUARDIAN_SECRETS_PATH` -- File path to a dotenv file containing `CHANNEL_<n>_SECRET` entries. When set, secrets are loaded from this file with mtime-based hot-reload instead of from `process.env`. This allows channel secrets to be updated without restarting the guardian container.
- `GUARDIAN_SECRETS_CACHE_TTL_MS` -- Cache TTL in milliseconds for the secrets file (default `30000`). The file is re-read when the mtime changes or the TTL expires.
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

Notes:

- Guardian is internal-only from the host perspective.
- It is the only bridge between addon ingress networks and `assistant_net`.

### Scheduler

Role:

- scheduled automation execution
- admin API caller
- assistant and memory client

The scheduler is a local-only automation runner. It does not serve an OpenCode instance and runs a private instance locally.

Env sources:

- direct compose env
- selected values from `stack.env`

Key env:

- `PORT=8090`
- `OP_HOME=/openpalm`
- `OP_ADMIN_TOKEN=${OP_ADMIN_TOKEN:-}`
- `OP_ADMIN_API_URL`
- `MEMORY_API_URL=http://memory:8765`
- `MEMORY_AUTH_TOKEN`
- `OPENCODE_API_URL=http://assistant:4096`
- `OPENCODE_SERVER_PASSWORD`

Mounts:

- `$OP_HOME/config -> /openpalm/config:ro`
- `$OP_HOME/logs -> /openpalm/logs`
- `$OP_HOME/data -> /openpalm/data`

Design note — scheduler access scope: The scheduler receives `OP_ADMIN_TOKEN` and mounts `config/` (read-only), `logs/`, and `data/` because it must execute automations that call the admin API (e.g., triggering lifecycle operations, managing addons), read automation definitions from config, write automation logs, and access data for automation state. This is a deliberate design choice, not an accidental over-grant. The scheduler is an internal-only service on `assistant_net` with no ingress exposure, and its access is bounded to what automations require: config (read-only), logs (read-write), data (read-write), admin API (token-authenticated), assistant API, and memory API.

Ports and network:

- host: none
- container: 8090
- network: `assistant_net`

---

## Admin Addon

### Docker Socket Proxy

Role:

- only Docker socket mount in the shipped stack
- filtered Docker API for the admin service

Env:

- `CONTAINERS=1`
- `IMAGES=1`
- `NETWORKS=1`
- `VOLUMES=1`
- `POST=1`
- `INFO=1`

Mounts:

- `${OP_DOCKER_SOCK:-/var/run/docker.sock} -> /var/run/docker.sock:ro`

Network:

- `admin_docker_net`

### Admin

Role:

- web UI and API
- lifecycle orchestration through docker-socket-proxy
- control-plane file management under `OP_HOME`

Key env:

- `PORT=8100`
- `HOME=/home/node`
- `OP_HOME=/openpalm`
- `ADMIN_TOKEN`
- `MEMORY_API_URL=http://memory:8765`
- `MEMORY_AUTH_TOKEN`
- `GUARDIAN_URL=http://guardian:8080`
- `OP_ASSISTANT_URL=http://assistant:4096`
- `OP_ADMIN_API_URL=http://localhost:8100`
- `OPENCODE_CONFIG_DIR=/etc/opencode`
- `OPENCODE_PORT=3881`
- `DOCKER_HOST=tcp://docker-socket-proxy:2375`

Mounts:

- `$OP_HOME -> /openpalm`
- `$OP_HOME/data/admin -> /home/node`
- `$OP_HOME/data/workspace -> /work`
- `${GNUPGHOME:-${HOME}/.gnupg} -> /home/node/.gnupg:ro`

Design note — admin mounts all of `OP_HOME`: The admin service mounts the full `$OP_HOME` directory because it is the web-based orchestrator responsible for managing config, vault, stack assembly, data, and logs. Mounting individual subdirectories would be fragile and would break whenever new paths are introduced. The blast radius is already constrained: the admin reaches Docker only through docker-socket-proxy (filtered API), all admin API endpoints require `ADMIN_TOKEN` authentication, and the service binds to localhost by default. Narrowing the mount would add complexity without meaningful security improvement given these existing controls.

Ports and network:

- host: `${OP_ADMIN_BIND_ADDRESS:-127.0.0.1}:${OP_ADMIN_PORT:-3880}`
- host admin OpenCode: `${OP_ADMIN_OPENCODE_BIND_ADDRESS:-127.0.0.1}:${OP_ADMIN_OPENCODE_PORT:-3881}`
- container: `8100`
- container admin OpenCode: `3881`
- networks: `assistant_net`, `admin_docker_net`

---

## Addon Edge Pattern

Shipped channel-style addons follow the same basic pattern:

- receive their channel HMAC secret via `${VAR}` substitution from `vault/stack/guardian.env` (passed as a compose `--env-file`)
- join `channel_lan` by default (or `channel_public` for internet-facing channels once that network's access semantics are finalized)
- depend on `guardian`
- send signed traffic to guardian, not directly to assistant

Channel secret distribution: when a channel addon is installed, a shared HMAC secret is generated and written to both the channel's addon env and `vault/stack/guardian.env` as a `CHANNEL_<n>_SECRET` entry. This file is loaded by the guardian as a compose `env_file` and bind-mounted at `GUARDIAN_SECRETS_PATH` for mtime-based hot-reload. The channel SDK uses this secret to sign outbound requests; the guardian uses it to verify inbound requests. See the Guardian section above for hot-reload details.

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

The `openpalm.name` and `openpalm.description` labels are validated by the registry test suite (`scripts/validate-registry.sh`). The admin UI reads addon availability from `registry/addons/` and active state from `stack/addons/`, not from Docker labels.

---

## CLI Install

The setup wizard runs on `127.0.0.1:8190` by default. The port is configurable via the `OP_SETUP_PORT` environment variable.
