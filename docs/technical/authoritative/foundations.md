# Foundations

> Authoritative document. Do not edit without a specific request to do so, or direct approval.

This is the stripped-down runtime contract for OpenPalm.

It focuses on three things only:

- environment sources
- filesystem and mount boundaries
- Docker network boundaries

For the full architectural rule set, see `docs/technical/core-principles.md`.

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
└── logs/       audit and debug logs
```

Ephemeral cache lives under `~/.cache/openpalm/`.

### Compose env sources

The standard startup path uses:

- `vault/stack/stack.env`
- `vault/user/user.env`

The `memory` service may additionally load:

- `vault/stack/services/memory/[managed].env`

### Security boundaries

- Only `docker-socket-proxy` mounts the Docker socket.
- Only `admin` mounts the full OpenPalm home (`$OP_HOME -> /openpalm`).
- `assistant` mounts only `vault/user` from the vault boundary, not the whole vault directory.
- `guardian` is the only path from channel ingress networks to the assistant.

---

## Core Networks

| Network | Purpose | Core members |
|---|---|---|
| `assistant_net` | Core internal mesh | `memory`, `assistant`, `guardian`, `scheduler`, optional `admin` |
| `channel_lan` | Default channel ingress | `guardian` and LAN-facing channel addons |
| `admin_docker_net` | Isolated Docker control plane | `admin`, `docker-socket-proxy` |

---

## Core Containers

### Memory

Role:

- persistent memory API
- vector storage and embeddings support

Env sources:

- `stack.env`
- `user.env`
- optional `vault/stack/services/memory/[managed].env`

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

- direct compose env
- `user.env`
- selected values from `stack.env`

Key env:

- `OPENCODE_CONFIG_DIR=/etc/opencode`
- `OPENCODE_PORT=4096`
- `OPENCODE_AUTH=false`
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
- `$OP_HOME/vault/user/ -> /etc/vault/`
- `$OP_HOME/logs/opencode -> /home/opencode/.local/state/opencode`

Ports and network:

- host: `${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3800}`
- host SSH: `${OP_ASSISTANT_SSH_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_SSH_PORT:-2222}`
- container: `4096`
- container SSH: `22`
- network: `assistant_net`

### Guardian

Role:

- HMAC verification
- replay protection
- rate limiting
- channel-to-assistant ingress gateway

Env sources:

- `stack.env`
- direct compose env

Key env:

- `PORT=8080`
- `OP_ASSISTANT_URL=http://assistant:4096`
- `OPENCODE_TIMEOUT_MS=0`
- `ADMIN_TOKEN=${OP_ADMIN_TOKEN:-}`
- `GUARDIAN_AUDIT_PATH=/app/audit/guardian-audit.log`
- `CHANNEL_<NAME>_SECRET`

Mounts:

- `$OP_HOME/data/guardian -> /app/data`
- `$OP_HOME/logs -> /app/audit`

Ports and network:

- host: none
- container: `8080`
- networks: `channel_lan`, `channel_public`, `assistant_net`

Additional env:

- `GUARDIAN_SECRETS_PATH` -- File path to a dotenv file containing `CHANNEL_<NAME>_SECRET` entries. When set, secrets are loaded from this file with mtime-based hot-reload instead of from `process.env`. This allows channel secrets to be updated without restarting the guardian container.
- `GUARDIAN_SECRETS_CACHE_TTL_MS` -- Cache TTL in milliseconds for the secrets file (default `30000`). The file is re-read when the mtime changes or the TTL expires.
- `GUARDIAN_SESSION_TTL_MS` -- Session TTL in milliseconds (default `900000` / 15 minutes). Sessions idle longer than this are evicted from the cache.

Channel payload metadata fields:

- `metadata.sessionKey` -- When present in the inbound message metadata, overrides the default per-user session key (`userId`). This allows channels to maintain multiple independent sessions per user.
- `metadata.clearSession: true` -- When set, clears all assistant sessions matching the resolved session target instead of sending a message. Returns `{ cleared: true }`.

Notes:

- Guardian is internal-only from the host perspective.
- It is the only bridge between addon ingress networks and `assistant_net`.

### Scheduler

Role:

- scheduled automation execution
- admin API caller
- assistant and memory client

Env sources:

- direct compose env
- selected values from `stack.env`

Key env:

- `PORT=8090`
- `OP_HOME=/openpalm`
- `OP_ADMIN_TOKEN=${OP_ADMIN_TOKEN:-}`
- `OP_ADMIN_API_URL`
- `OPENCODE_API_URL=http://assistant:4096`
- `OP_OPENCODE_PASSWORD`
- `MEMORY_API_URL=http://memory:8765`

Mounts:

- `$OP_HOME/config -> /openpalm/config:ro`

Ports and network:

- host: `127.0.0.1:${OP_SCHEDULER_PORT:-3897}`
- container: `8090`
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
- `${HOME}/.cache/openpalm/registry -> /cache/registry`
- `${GNUPGHOME:-${HOME}/.gnupg} -> /home/node/.gnupg:ro`

Ports and network:

- host: `${OP_ADMIN_BIND_ADDRESS:-127.0.0.1}:${OP_ADMIN_PORT:-3880}`
- host admin OpenCode: `${OP_ADMIN_OPENCODE_BIND_ADDRESS:-127.0.0.1}:${OP_ADMIN_OPENCODE_PORT:-3881}`
- container: `8100`
- container admin OpenCode: `3881`
- networks: `assistant_net`, `admin_docker_net`

---

## Addon Edge Pattern

Shipped channel-style addons follow the same basic pattern:

- load `stack.env` and `user.env`
- join `channel_lan` by default
- depend on `guardian`
- send signed traffic to guardian, not directly to assistant

Default host binds for shipped HTTP-ish edges:

- `chat`: `127.0.0.1:3820 -> 8181`
- `api`: `127.0.0.1:3821 -> 8182`
- `voice`: `127.0.0.1:3810 -> 8186`

`discord` and `slack` do not expose host ports in the shipped overlays.
