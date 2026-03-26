# Environment Variables, Mounts, and Network Wiring

This document mirrors the current shipped runtime: repo assets under `.openpalm/`
and runtime files under `OP_HOME`.

Primary sources:

- `.openpalm/stack/core.compose.yml`
- `.openpalm/registry/addons/*/compose.yml`
- `core/*/entrypoint.sh` and service source where runtime defaults matter

When this document conflicts with older prose elsewhere, the compose files win.

---

## Host-Level Layout

OpenPalm stores runtime state under `OP_HOME`, which defaults to `~/.openpalm`.

| Host path | Purpose |
|---|---|
| `~/.openpalm/config/` | User-editable, non-secret config |
| `~/.openpalm/registry/` | Available addon and automation catalog |
| `~/.openpalm/stack/` | Live compose assembly; `stack/addons/` contains enabled addon overlays only |
| `~/.openpalm/vault/user/` | User-managed settings (`user.env`) |
| `~/.openpalm/vault/stack/` | System-managed secrets and runtime env (`stack.env`, API keys, auth.json) |
| `~/.openpalm/data/` | Durable service data |
| `~/.openpalm/logs/` | Audit and debug logs |
| `~/.cache/openpalm/` | Ephemeral cache and rollback snapshots |

Current durable data subdirectories used by the shipped stack:

- `data/admin`
- `data/assistant`
- `data/guardian`
- `data/memory`
- `data/stash`
- `data/workspace`

---

## Compose Env Files

Docker Compose is invoked with these env files (see [Manual Compose Runbook](../operations/manual-compose-runbook.md)):

```bash
--env-file "$OP_HOME/vault/stack/stack.env"
--env-file "$OP_HOME/vault/user/user.env"
--env-file "$OP_HOME/vault/stack/guardian.env"
```

That means the effective env model is:

- `vault/stack/stack.env` - system-managed runtime env and secrets (admin token, paths, UID/GID, image tags, bind ports, API keys, provider config, owner identity)
- `vault/user/user.env` - recommended user-managed addon overrides and operator settings
- `vault/stack/guardian.env` - channel HMAC secrets (loaded by guardian as env_file and via GUARDIAN_SECRETS_PATH)

---

## Core Services

### Memory

Compose source: `.openpalm/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/data/memory` | `/data` | rw | Memory database, mem0 compatibility data, generated config |

Ports and networks:

| Item | Value |
|---|---|
| Container port | `8765` |
| Host bind | `${OP_MEMORY_BIND_ADDRESS:-127.0.0.1}:${OP_MEMORY_PORT:-3898}` |
| Networks | `assistant_net` |

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `MEMORY_DATA_DIR` | `/data` | Persistent data root |
| `HOME` | `/data` | Writable home |
| `MEM0_DIR` | `/data/.mem0` | mem0 compatibility directory |
| `MEMORY_AUTH_TOKEN` | `stack.env` via `${VAR}` | Memory API auth |
| `MEMORY_USER_ID` | `stack.env` via `${VAR}` | Default memory identity |
| `SYSTEM_LLM_PROVIDER` | `${OP_CAP_LLM_PROVIDER}` | LLM provider name for fact extraction |
| `SYSTEM_LLM_MODEL` | `${OP_CAP_LLM_MODEL}` | LLM model for fact extraction |
| `SYSTEM_LLM_BASE_URL` | `${OP_CAP_LLM_BASE_URL}` | LLM endpoint URL |
| `SYSTEM_LLM_API_KEY` | `${OP_CAP_LLM_API_KEY}` | LLM API key |
| `EMBEDDING_PROVIDER` | `${OP_CAP_EMBEDDINGS_PROVIDER}` | Embedding provider name |
| `EMBEDDING_MODEL` | `${OP_CAP_EMBEDDINGS_MODEL}` | Embedding model identifier |
| `EMBEDDING_BASE_URL` | `${OP_CAP_EMBEDDINGS_BASE_URL}` | Embedding endpoint URL |
| `EMBEDDING_API_KEY` | `${OP_CAP_EMBEDDINGS_API_KEY}` | Embedding API key |
| `EMBEDDING_DIMS` | `${OP_CAP_EMBEDDINGS_DIMS}` | Embedding vector dimensions |

Notes:

- Memory env vars are resolved from `OP_CAP_*` capability variables in `stack.env`. See [`capability-injection.md`](capability-injection.md) for the full resolution pipeline.
- The shipped compose file does not mount `default_config.json` separately.
- The memory service persists everything through `/data`.

### Assistant

Compose source: `.openpalm/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| baked into image | `/etc/opencode` | image content | Core OpenCode config and built-in extensions |
| `$OP_HOME/config` | `/etc/openpalm` | rw | OpenPalm config tree available inside container |
| `$OP_HOME/config/assistant` | `/home/opencode/.config/opencode` | rw | User OpenCode tools, plugins, skills, commands |
| `$OP_HOME/vault/stack/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | rw | OpenCode auth state |
| `$OP_HOME/vault/user/` | `/etc/vault/` | rw | User secrets directory |
| `$OP_HOME/data/assistant` | `/home/opencode/` | rw | Assistant persistent data |
| `$OP_HOME/data/stash` | `/home/opencode/.akm` | rw | AKM stash |
| `$OP_HOME/data/workspace` | `/work` | rw | Shared workspace |
| `$OP_HOME/logs/opencode` | `/home/opencode/.local/state/opencode` | rw | OpenCode logs and local state |

Ports and networks:

| Item | Value |
|---|---|
| Container port | `4096` |
| Host bind | `${OP_ASSISTANT_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_PORT:-3800}` |
| SSH container port | `22` |
| SSH host bind | `${OP_ASSISTANT_SSH_BIND_ADDRESS:-127.0.0.1}:${OP_ASSISTANT_SSH_PORT:-2222}` |
| Networks | `assistant_net` |

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Core OpenCode config root |
| `OPENCODE_PORT` | `4096` | OpenCode web server listen port |
| `OPENCODE_AUTH` | `false` | Auth disabled because host binding is loopback-only by default |
| `OPENCODE_ENABLE_SSH` | `stack.env` | Optional SSH enablement |
| `HOME` | `/home/opencode` | Runtime home |
| `AKM_STASH_DIR` | `/home/opencode/.akm` | AKM stash location hint |
| `OP_ADMIN_API_URL` | `stack.env` / addon wiring | Admin API URL when admin is present |
| `OP_ASSISTANT_TOKEN` | `OP_ASSISTANT_TOKEN` from `stack.env` | Assistant-scoped auth token |
| `MEMORY_API_URL` | `http://memory:8765` | Memory service URL |
| `MEMORY_AUTH_TOKEN` | `stack.env` | Memory auth token |
| `MEMORY_USER_ID` | `stack.env` or default | Default memory identity |
| `OP_UID` / `OP_GID` | `stack.env` | Entrypoint privilege drop target |

Notes:

- The assistant has no Docker socket mount.
- The assistant mounts `vault/user/` directory (rw) to `/etc/vault/`, not the full `vault/` tree.
- The entrypoint starts as root only long enough to normalize permissions and optional SSH setup, then drops privileges.

### Guardian

Compose source: `.openpalm/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/data/guardian` | `/app/data` | rw | Runtime nonce / rate-limit state |
| `$OP_HOME/logs` | `/app/audit` | rw | Guardian audit log directory |

Ports and networks:

| Item | Value |
|---|---|
| Container port | `8080` |
| Host bind | none |
| Networks | `channel_lan`, `channel_public`, `assistant_net` |

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `HOME` | `/app/data` | Writable runtime home |
| `PORT` | `8080` | HTTP listen port |
| `OP_ASSISTANT_URL` | `http://assistant:4096` | Assistant forward target |
| `OPENCODE_TIMEOUT_MS` | `0` | Guardian-side timeout override |
| `ADMIN_TOKEN` | `${OP_ADMIN_TOKEN:-}` | Admin token forwarded from stack env |
| `GUARDIAN_AUDIT_PATH` | `/app/audit/guardian-audit.log` | Audit log path |
| `GUARDIAN_SECRETS_PATH` | `/app/secrets/guardian.env` | Path to mounted guardian secrets for hot-reload |
| `CHANNEL_<NAME>_SECRET` | `vault/stack/guardian.env` (via env_file) | Channel HMAC verification secrets |

Notes:

- Guardian is internal-only from the host perspective.
- It is the only bridge between addon ingress networks and `assistant_net`.
- Guardian loads `vault/stack/guardian.env` as a compose `env_file` for channel HMAC secrets. The same file is bind-mounted at `GUARDIAN_SECRETS_PATH` for mtime-based hot-reload. Non-secret config (`OP_ADMIN_TOKEN`) is passed via `${VAR}` substitution in the compose `environment:` block.

### Scheduler

Compose source: `.openpalm/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/config` | `/openpalm/config` | ro | Automation definitions and config |
| `$OP_HOME/logs` | `/openpalm/logs` | rw | Automation and service logs |
| `$OP_HOME/data` | `/openpalm/data` | rw | Automation state and service data |

Ports and networks:

| Item | Value |
|---|---|
| Container port | `8090` |
| Host bind | none (internal only on `assistant_net`) |
| Networks | `assistant_net` |

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `PORT` | `8090` | HTTP listen port |
| `OP_HOME` | `/openpalm` | Runtime root used by scheduler code |
| `OP_ADMIN_TOKEN` | `${OP_ADMIN_TOKEN:-}` | Scheduler admin token |
| `OP_ADMIN_API_URL` | `stack.env` / addon wiring | Admin API base URL |
| `OPENCODE_API_URL` | `http://assistant:4096` | Assistant API URL |
| `OPENCODE_SERVER_PASSWORD` | `${OP_OPENCODE_PASSWORD:-}` | Optional assistant auth wiring |
| `MEMORY_API_URL` | `http://memory:8765` | Memory URL |
| `MEMORY_AUTH_TOKEN` | `${OP_MEMORY_TOKEN:-}` | Memory API auth token |

Notes:

- Scheduler does not mount the Docker socket.
- Scheduler has no host port; it is internal-only on `assistant_net`.

---

## Admin Addon

Compose source: runtime `~/.openpalm/stack/addons/admin/compose.yml` seeded from `.openpalm/registry/addons/admin/compose.yml`

### Docker Socket Proxy

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `${OP_DOCKER_SOCK:-/var/run/docker.sock}` | `/var/run/docker.sock` | ro | Filtered Docker API source |

Networks and behavior:

| Item | Value |
|---|---|
| Networks | `admin_docker_net` |
| Internal port | `2375` |
| Allowed API areas | `CONTAINERS`, `IMAGES`, `NETWORKS`, `VOLUMES`, `POST`, `INFO` |

This is the only shipped container that mounts the Docker socket.

### Admin

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME` | `/openpalm` | rw | Full OpenPalm home for control-plane management |
| `$OP_HOME/data/admin` | `/home/node` | rw | Admin home directory |
| `$OP_HOME/data/workspace` | `/work` | rw | Workspace access |
| `${GNUPGHOME:-${HOME}/.gnupg}` | `/home/node/.gnupg` | ro | Optional pass/GPG integration |

Ports and networks:

| Item | Value |
|---|---|
| Container port | `8100` |
| Host bind | `${OP_ADMIN_BIND_ADDRESS:-127.0.0.1}:${OP_ADMIN_PORT:-3880}` |
| Admin OpenCode container port | `3881` |
| Host bind | `${OP_ADMIN_OPENCODE_BIND_ADDRESS:-127.0.0.1}:${OP_ADMIN_OPENCODE_PORT:-3881}` |
| Networks | `assistant_net`, `admin_docker_net` |

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `PORT` | `8100` | Admin HTTP port |
| `HOME` | `/home/node` | Writable home |
| `OP_HOME` | `/openpalm` | In-container OpenPalm root |
| `ADMIN_TOKEN` | `${OP_ADMIN_TOKEN:-}` | Admin API auth token |
| `MEMORY_AUTH_TOKEN` | `stack.env` | Memory auth token |
| `MEMORY_API_URL` | `http://memory:8765` | Memory URL |
| `MEMORY_USER_ID` | `stack.env` / default | Memory identity |
| `GUARDIAN_URL` | `http://guardian:8080` | Guardian API URL |
| `OP_ASSISTANT_URL` | `http://assistant:4096` | Assistant URL |
| `OP_ADMIN_API_URL` | `http://localhost:8100` | Admin self-URL |
| `OP_ADMIN_OPENCODE_PORT` | `${OP_ADMIN_OPENCODE_PORT:-3881}` | Admin OpenCode port |
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Built-in admin OpenCode config |
| `OPENCODE_PORT` | `3881` | Admin OpenCode listen port |
| `OPENCODE_AUTH` | `false` | Loopback-only by default |
| `DOCKER_HOST` | `tcp://docker-socket-proxy:2375` | Docker API via proxy |

---

## Addon Overlays Shipped In The Repo

| Addon | Host bind | Internal port | Network(s) | Notes |
|---|---|---:|---|---|
| `chat` | `${OP_CHAT_BIND_ADDRESS:-127.0.0.1}:${OP_CHAT_PORT:-3820}` | `8181` | `channel_lan` | Guardian-facing chat edge |
| `api` | `${OP_API_BIND_ADDRESS:-127.0.0.1}:${OP_API_PORT:-3821}` | `8182` | `channel_lan` | OpenAI/Anthropic-compatible edge |
| `voice` | `${OP_VOICE_BIND_ADDRESS:-127.0.0.1}:${OP_VOICE_PORT:-3810}` | `8186` | `channel_lan` | Voice interface |
| `discord` | none | service-specific | `channel_lan` | No host port exposure |
| `slack` | none | service-specific | `channel_lan` | No host port exposure |
| `ollama` | `${OP_OLLAMA_BIND_ADDRESS:-127.0.0.1}:11434` | `11434` | `assistant_net` | Mounts `$OP_HOME/data/ollama:/data`, `user: ${OP_UID}:${OP_GID}`, `OLLAMA_MODELS=/data/models` |
| `openviking` | none | service-specific | `assistant_net` | Mounts `$OP_HOME/data/openviking:/workspace`, `user: ${OP_UID}:${OP_GID}` |

All addon and channel services use `user: "${OP_UID:-1000}:${OP_GID:-1000}"` to ensure bind-mounted files are owned by the host user. All shipped channel overlays depend on guardian and receive only their own HMAC secret via `${VAR}` substitution from `vault/stack/guardian.env` (passed as a compose `--env-file`).

---

## Docker Networks

| Network | Connected services | Purpose |
|---|---|---|
| `assistant_net` | `memory`, `assistant`, `guardian`, `scheduler`, and `admin` when enabled | Core internal service mesh |
| `channel_lan` | `guardian` and LAN-facing channel/addon edges | Default channel ingress network |
| `channel_public` | `guardian` only in core; public-facing overlays can join it intentionally | Public ingress isolation |
| `admin_docker_net` | `admin`, `docker-socket-proxy` | Isolated Docker control-plane network |

---

## Core Stack Variables From `stack.env`

These variables are consumed by Compose and service env blocks.

| Variable | Purpose |
|---|---|
| `OP_HOME` | Host OpenPalm root used in bind mounts |
| `OP_UID`, `OP_GID` | Runtime UID/GID for bind-mounted file ownership |
| `OP_IMAGE_NAMESPACE`, `OP_IMAGE_TAG` | Image selection |
| `OP_DOCKER_SOCK` | Docker socket path for the proxy |
| `OP_ADMIN_BIND_ADDRESS`, `OP_ADMIN_PORT` | Admin host bind |
| `OP_ADMIN_OPENCODE_BIND_ADDRESS`, `OP_ADMIN_OPENCODE_PORT` | Admin OpenCode host bind |
| `OP_ASSISTANT_BIND_ADDRESS`, `OP_ASSISTANT_PORT` | Assistant host bind |
| `OP_ASSISTANT_SSH_BIND_ADDRESS`, `OP_ASSISTANT_SSH_PORT` | Assistant SSH host bind |
| `OP_MEMORY_BIND_ADDRESS`, `OP_MEMORY_PORT` | Memory host bind |
| `OP_CHAT_BIND_ADDRESS`, `OP_CHAT_PORT` | Chat addon host bind |
| `OP_API_BIND_ADDRESS`, `OP_API_PORT` | API addon host bind |
| `OP_VOICE_BIND_ADDRESS`, `OP_VOICE_PORT` | Voice addon host bind |
| `OP_ADMIN_TOKEN` | Admin auth token |
| `OP_ASSISTANT_TOKEN` | Assistant and scheduler auth token |
| `OP_MEMORY_TOKEN` | Memory API auth token |
| `OP_OPENCODE_PASSWORD` | OpenCode server password |
| `MEMORY_USER_ID` | Default memory identity |
| `OWNER_NAME` | Operator display name |
| `OWNER_EMAIL` | Operator email |
| `OP_CAP_LLM_*` | Resolved LLM capability (provider, model, base URL, API key) |
| `OP_CAP_SLM_*` | Resolved small/fast LLM capability |
| `OP_CAP_EMBEDDINGS_*` | Resolved embedding capability (provider, model, base URL, API key, dims) |
| `OP_CAP_TTS_*` | Resolved text-to-speech capability (provider, model, base URL, API key, voice, format) |
| `OP_CAP_STT_*` | Resolved speech-to-text capability (provider, model, base URL, API key, language) |
| `OP_CAP_RERANKING_*` | Resolved reranking capability (provider, model, base URL, API key, topK, topN) |
| `CHANNEL_<NAME>_SECRET` | Guardian / channel HMAC secrets (lives in `guardian.env`, not `stack.env`) |

---

## User Variables From `user.env`

This file is an optional user-managed extension env. It starts empty and can
hold custom preferences. `OWNER_NAME` and `OWNER_EMAIL` live in `stack.env`
(see above).

API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, etc.) and
provider/model selections live in `stack.env`. The control plane resolves
these into `OP_CAP_*` capability variables (see [`capability-injection.md`](capability-injection.md)),
which services consume via compose `${VAR}` substitution in their `environment:`
blocks. Memory receives `OP_CAP_LLM_*` and `OP_CAP_EMBEDDINGS_*` vars this way.
The assistant receives raw provider API keys directly for OpenCode compatibility.
Channels receive only their own HMAC secret via `${VAR}` substitution from
`guardian.env`.
