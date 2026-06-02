# Environment Variables, Mounts, and Network Wiring

This document mirrors the current shipped runtime: repo assets under `.openpalm/`
and runtime files under `OP_HOME`.

Primary sources:

- `.openpalm/config/stack/core.compose.yml`
- `.openpalm/config/stack/services.compose.yml`
- `.openpalm/config/stack/channels.compose.yml`
- `.openpalm/config/stack/custom.compose.yml`
- `core/*/entrypoint.sh` and service source where runtime defaults matter

When this document conflicts with older prose elsewhere, the compose files win.

---

## Host-Level Layout

OpenPalm stores runtime state under `OP_HOME`, which defaults to `~/.openpalm`.

| Host path | Purpose |
|---|---|
| `~/.openpalm/config/` | User-editable, non-secret config |
| `~/.openpalm/config/stack/` | Live compose assembly; non-secret runtime env (`stack.env`), `core.compose.yml`, `services.compose.yml`, `channels.compose.yml`, `custom.compose.yml`, `stack.yml` |
| `~/.openpalm/knowledge/` | AKM knowledge base (user-managed: `vaults/`, `tasks/`) |
| `~/.openpalm/knowledge/vaults/` | User-managed secrets (`user.env`, AKM vault backing store) |
| `~/.openpalm/data/` | Durable service data, logs, lifecycle backups, and rollback snapshots |
| `~/.openpalm/data/logs/` | Audit and debug logs |
| `~/.cache/openpalm/` | Ephemeral system cache |

Current durable data subdirectories used by the shipped stack:

- `data/assistant`
- `data/guardian`
- `data/akm`
- `data/akm/cache`
- `data/akm/data`
- `data/logs`
- `data/backups`
- `data/rollback`
- `knowledge/` (shared akm stash mounted at `/stash` for assistant)
- `workspace/` (shared work area)

Persistent memory and knowledge live in `knowledge/` (the shared akm stash
mounted at `/stash` for the assistant). There is no separate memory service.

---

## Compose Env And Secrets

Docker Compose is invoked with the non-secret stack env file (see [Manual Compose Runbook](../operations/manual-compose-runbook.md)):

```bash
--env-file "$OP_HOME/config/stack/stack.env"
```

That means the effective env model is:

- `config/stack/stack.env` - system-managed non-secret runtime env (paths, UID/GID, image tags, bind ports, profiles, feature flags, owner identity)
- `knowledge/secrets/` - system-managed secret files, directory mode `0700`, file mode `0600`; granted to containers with Compose `secrets:` and exposed as `*_FILE` variables
- `knowledge/vaults/user.env` - AKM vault backing file for user-managed secrets; never a Compose env-file

---

## Core Services

> Memory is not a separate service. Persistent knowledge and recall
> live in the akm stash bind-mounted from the host: `knowledge/` is mounted at `/stash`
> in the assistant container. See
> [`core-principles.md`](core-principles.md) for the rationale.

### Assistant

Compose source: `.openpalm/config/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/config/assistant` | `/etc/opencode` | rw | OpenCode config and assistant extensions |
| `$OP_HOME/config/stack/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | rw | Host-managed OpenCode auth copy |
| `$OP_HOME/config/akm` | `/etc/akm` | rw | AKM config |
| `$OP_HOME/data/assistant` | `/home/opencode` | rw | Assistant persistent home |
| `$OP_HOME/knowledge` | `/stash` | rw | AKM stash |
| `$OP_HOME/data/akm/cache` | `/opt/akm/cache` | rw | AKM cache and task logs |
| `$OP_HOME/data/akm/data` | `/opt/akm/data` | rw | AKM databases and durable data |
| `$OP_HOME/workspace` | `/work` | rw | Shared workspace |
| `assistant-persistent` | `/opt/persistent` | rw | Escape hatch for prefix-style global installs |

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
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | OpenPalm-managed OpenCode config root |
| `OPENCODE_PORT` | `4096` | OpenCode web server listen port |
| `OPENCODE_AUTH` | `false` | Auth disabled because host binding is loopback-only by default |
| `OPENCODE_ENABLE_SSH` | `stack.env` | Optional SSH enablement |
| `HOME` | `/home/opencode` | Runtime home |
| `AKM_STASH_DIR` | `/stash` | AKM stash location hint |
| `AKM_CONFIG_DIR` | `/etc/akm` | AKM config directory |
| `AKM_CACHE_DIR` | `/opt/akm/cache` | AKM cache directory |
| `AKM_DATA_DIR` | `/opt/akm/data` | AKM durable data directory |
| `OP_UID` / `OP_GID` | `stack.env` | Entrypoint privilege drop target |

Notes:

- The assistant has no Docker socket mount.
- The assistant reads user secrets via `akm vault:user` — there is no `/etc/vault/` container mount.
- The entrypoint starts as root only long enough to normalize permissions and optional SSH setup, then drops privileges.

### Guardian

Compose source: `.openpalm/config/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/data/guardian` | `/opt/openpalm/guardian` | rw | Runtime nonce / rate-limit state |
| `$OP_HOME/config/guardian` | `/etc/opencode` | rw | Guardian OpenCode global config (`OPENCODE_CONFIG_DIR`) |
| `$OP_HOME/config/stack/auth.json` | `/opt/openpalm/guardian/.local/share/opencode/auth.json` | ro | Shared OpenCode provider credentials (same file the assistant mounts) |
| `$OP_HOME/data/logs` | `/opt/openpalm/logs` | rw | Guardian audit log directory |
| `$OP_HOME/knowledge/secrets/<guardian-or-channel-secret>` | `/run/secrets/<name>` | ro | Guardian and channel HMAC secret files granted by Compose |

Ports and networks:

| Item | Value |
|---|---|
| Container port | `8080` |
| Host bind | none |
| Networks | `channel_lan`, `channel_public`, `assistant_net` |

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `HOME` | `/opt/openpalm/guardian` | Writable runtime home |
| `PORT` | `8080` | HTTP listen port |
| `OP_ASSISTANT_URL` | `http://assistant:4096` | Assistant forward target |
| `OPENCODE_TIMEOUT_MS` | `0` | Guardian-side timeout override |
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Moderator OpenCode config dir (from `config/guardian`) |
| `GUARDIAN_AUDIT_PATH` | `/opt/openpalm/logs/guardian-audit.log` | Audit log path |
| `CHANNEL_<NAME>_SECRET_FILE` | `/run/secrets/channel_<name>_hmac` | Channel HMAC verification secret file |
| `GUARDIAN_CONTENT_VALIDATION` | `0` | Enable opt-in, fail-closed content validation of inbound messages |
| `GUARDIAN_MODERATION_URL` | `http://127.0.0.1:4097` | Local OpenCode moderator endpoint |
| `GUARDIAN_MODERATION_PORT` | `4097` | Loopback port the entrypoint starts the moderator on |
| `GUARDIAN_MODERATION_THRESHOLD` | `3` | Heuristic risk score at/above which a message escalates to the model |
| `GUARDIAN_MODERATION_TIMEOUT_MS` | `4000` | Per-classification timeout; on expiry the message fails closed |

Notes:

- Guardian is internal-only from the host perspective.
- It is the only bridge between addon ingress networks and `assistant_net`.
- Guardian receives only explicitly granted secret files from `knowledge/secrets/`; it must not use service-level `env_file` or raw secret env values.

### Scheduler co-process

The scheduler is no longer a separate compose service. It runs as a Bun
co-process inside the `assistant` container, launched by
`core/assistant/entrypoint.sh`.

Scheduling control plane (crond started by `core/assistant/entrypoint.sh`):

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/knowledge/tasks` | `/knowledge/tasks` | rw | AKM task markdown files |
| `$OP_HOME/data/akm/cache` | `/opt/akm/cache` | rw | AKM task logs and cache |
| `$OP_HOME/data/akm/data` | `/opt/akm/data` | rw | AKM task history and durable data |

Notes:

- `crond` runs in the background; no network port, no Docker socket.
- `akm tasks sync` registers task files with the user crontab at boot and every 60 s.
- Manual trigger: `POST /admin/automations/<name>/run` (admin spawns `akm tasks run <name>` directly).

---

## Admin (host process)

Admin is a host-only Bun.serve server started by `openpalm`. It has no container, no Docker socket mount, and no `$OP_HOME` volume bind — it accesses everything directly as a host process.

Bind address: `127.0.0.1:${OP_HOST_UI_PORT:-3880}` (loopback only — never reachable from containers or LAN)

Key env (host process, not container):

| Variable | Value / source | Purpose |
|---|---|---|
| `PORT` | `OP_HOST_UI_PORT` or `3880` | Admin HTTP listen port |
| `OP_HOME` | resolved from host env | OpenPalm home directory |
| `OP_UI_LOGIN_PASSWORD` | `$OP_HOME/knowledge/secrets/op_ui_login_password` | Operator admin password promoted into the host admin process environment |

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

All addon and channel services use `user: "${OP_UID:-1000}:${OP_GID:-1000}"` to ensure bind-mounted files are owned by the host user. Shipped channel overlays depend on guardian and receive only their own HMAC secret file through Compose `secrets:` plus a matching `*_FILE` environment variable.

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
| `OP_OWNER_NAME` | Operator display name |
| `OP_OWNER_EMAIL` | Operator email |

---

## User Secrets From `user.env`

This file is the AKM vault backing file for user-managed secrets. It is not
passed to Docker Compose and is not mounted directly into containers.

Provider/model selections and other non-secret preferences live in `stack.env`
or `config/akm/config.json`. System-managed service secrets live as files under
`knowledge/secrets/` and are granted only to the service that needs them.
Secret-like container environment variables must use `*_FILE` paths.
