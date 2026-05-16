# Environment Variables, Mounts, and Network Wiring

This document mirrors the current shipped runtime: repo assets under `.openpalm/`
and runtime files under `OP_HOME`.

Primary sources:

- `.openpalm/config/stack/core.compose.yml`
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
| `~/.openpalm/config/stack/` | Live compose assembly; `stack/addons/` contains enabled addon overlays only |
| `~/.openpalm/vault/user/` | User-managed settings (`user.env`) |
| `~/.openpalm/config/stack/` | System-managed secrets and runtime env (`stack.env`, API keys, auth.json) |
| `~/.openpalm/data/` | Durable service data |
| `~/.openpalm/logs/` | Audit and debug logs |
| `~/.cache/openpalm/` | Ephemeral cache and rollback snapshots |

Current durable data subdirectories used by the shipped stack:

- `data/admin`
- `data/assistant`
- `data/guardian`
- `data/guardian-stash`
- `data/akm-cache`
- `data/guardian-cache`
- `data/scheduler`
- `data/stash`
- `data/workspace`

Persistent memory and knowledge live in `data/stash` (the shared akm stash
mounted at `/akm` for both assistant and admin) and `data/guardian-stash`
(the operator-only akm stash mounted at `/akm-guardian` for guardian).
There is no separate memory service.

---

## Compose Env Files

Docker Compose is invoked with these env files (see [Manual Compose Runbook](../operations/manual-compose-runbook.md)):

```bash
--env-file "$OP_HOME/config/stack/stack.env"
--env-file "$OP_HOME/vault/user/user.env"
--env-file "$OP_HOME/config/stack/guardian.env"
```

That means the effective env model is:

- `config/stack/stack.env` - system-managed runtime env and secrets (admin token, paths, UID/GID, image tags, bind ports, API keys, provider config, owner identity)
- `vault/user/user.env` - recommended user-managed addon overrides and operator settings
- `config/stack/guardian.env` - channel HMAC secrets (loaded by guardian as env_file and via GUARDIAN_SECRETS_PATH)

---

## Core Services

> Memory is no longer a separate service. Persistent knowledge and recall
> live in the akm stash bind-mounted from the host: `data/stash` is shared
> between admin and assistant at `/akm`, and `data/guardian-stash` is the
> operator-only stash for guardian at `/akm-guardian`. See
> [`core-principles.md`](core-principles.md) for the rationale.

### Assistant

Compose source: `.openpalm/config/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| baked into image | `/etc/opencode` | image content | Core OpenCode config and built-in extensions |
| `$OP_HOME/config` | `/etc/openpalm` | rw | OpenPalm config tree available inside container |
| `$OP_HOME/config/assistant` | `/home/opencode/.config/opencode` | rw | User OpenCode tools, plugins, skills, commands |
| `$OP_HOME/config/stack/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | rw | OpenCode auth state |
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
| `OP_ASSISTANT_TOKEN` | `OP_ASSISTANT_TOKEN` from `stack.env` | Assistant-scoped auth token |
| `OP_UID` / `OP_GID` | `stack.env` | Entrypoint privilege drop target |

Notes:

- The assistant has no Docker socket mount.
- The assistant mounts `vault/user/` directory (rw) to `/etc/vault/`, not the full `vault/` tree.
- The entrypoint starts as root only long enough to normalize permissions and optional SSH setup, then drops privileges.

### Guardian

Compose source: `.openpalm/config/stack/core.compose.yml`

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
| `CHANNEL_<NAME>_SECRET` | `config/stack/guardian.env` (via env_file) | Channel HMAC verification secrets |

Notes:

- Guardian is internal-only from the host perspective.
- It is the only bridge between addon ingress networks and `assistant_net`.
- Guardian loads `config/stack/guardian.env` as a compose `env_file` for channel HMAC secrets. The same file is bind-mounted at `GUARDIAN_SECRETS_PATH` for mtime-based hot-reload. Non-secret config (`OP_ADMIN_TOKEN`) is passed via `${VAR}` substitution in the compose `environment:` block.

### Scheduler co-process

The scheduler is no longer a separate compose service. It runs as a Bun
co-process inside the `assistant` container, launched by
`core/assistant/entrypoint.sh`.

Scheduling control plane (crond started by `core/assistant/entrypoint.sh`):

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/stash/tasks` | `/akm/tasks` | rw | AKM task markdown files |
| `$OP_HOME/cache/akm` | `/akm-cache` | rw | Per-run task logs |
| `$OP_HOME/state/akm` | `/akm-op` | rw | akm state.db (execution history) |
| `$OP_HOME/state/logs` | `/openpalm/logs` | rw | akm-tasks-sync.log |

Notes:

- `crond` runs in the background; no network port, no Docker socket.
- `akm tasks sync` registers task files with the user crontab at boot and every 60 s.
- Manual trigger: `POST /admin/automations/<name>/run` (admin spawns `akm tasks run <name>` directly).

---

## Admin (host process)

Admin is a host-only Bun.serve server started by `openpalm admin serve`. It has no container, no Docker socket mount, and no `$OP_HOME` volume bind — it accesses everything directly as a host process.

Bind address: `127.0.0.1:${OP_HOST_ADMIN_PORT:-3880}` (loopback only — never reachable from containers or LAN)

Key env (host process, not container):

| Variable | Value / source | Purpose |
|---|---|---|
| `PORT` | `OP_HOST_ADMIN_PORT` or `3880` | Admin HTTP listen port |
| `OP_HOME` | resolved from host env | OpenPalm home directory |
| `ADMIN_TOKEN` | `$OP_HOME/state/admin/token` | Admin API auth token |

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

All addon and channel services use `user: "${OP_UID:-1000}:${OP_GID:-1000}"` to ensure bind-mounted files are owned by the host user. All shipped channel overlays depend on guardian and receive only their own HMAC secret via `${VAR}` substitution from `config/stack/guardian.env` (passed as a compose `--env-file`).

---

## Docker Networks

| Network | Connected services | Purpose |
|---|---|---|
| `assistant_net` | `assistant` (also hosts the scheduler co-process), `guardian` | Core internal service mesh |
| `channel_lan` | `guardian` and LAN-facing channel/addon edges | Default channel ingress network |
| `channel_public` | `guardian` only in core; public-facing overlays can join it intentionally | Public ingress isolation |

---

## Core Stack Variables From `stack.env`

These variables are consumed by Compose and service env blocks.

| Variable | Purpose |
|---|---|
| `OP_HOME` | Host OpenPalm root used in bind mounts |
| `OP_UID`, `OP_GID` | Runtime UID/GID for bind-mounted file ownership |
| `OP_IMAGE_NAMESPACE`, `OP_IMAGE_TAG` | Image selection |
| `OP_ADMIN_BIND_ADDRESS`, `OP_ADMIN_PORT` | Admin host bind |
| `OP_ADMIN_OPENCODE_BIND_ADDRESS`, `OP_ADMIN_OPENCODE_PORT` | Admin OpenCode host bind |
| `OP_ASSISTANT_BIND_ADDRESS`, `OP_ASSISTANT_PORT` | Assistant host bind |
| `OP_ASSISTANT_SSH_BIND_ADDRESS`, `OP_ASSISTANT_SSH_PORT` | Assistant SSH host bind |
| `OP_CHAT_BIND_ADDRESS`, `OP_CHAT_PORT` | Chat addon host bind |
| `OP_API_BIND_ADDRESS`, `OP_API_PORT` | API addon host bind |
| `OP_VOICE_BIND_ADDRESS`, `OP_VOICE_PORT` | Voice addon host bind |
| `OP_ADMIN_TOKEN` | Admin auth token |
| `OP_ASSISTANT_TOKEN` | Assistant operational token (also used by the scheduler co-process for admin API calls) |
| `OP_OPENCODE_PASSWORD` | OpenCode server password |
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
blocks. The assistant receives raw provider API keys directly for OpenCode
compatibility. Channels receive only their own HMAC secret via `${VAR}`
substitution from `guardian.env`.
