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
| `~/.openpalm/stash/` | AKM knowledge base (user-managed: `vaults/`, `tasks/`) |
| `~/.openpalm/stash/vaults/` | User-managed secrets (`user.env`, AKM vault backing store) |
| `~/.openpalm/state/` | Durable service data |
| `~/.openpalm/cache/logs/` | Audit and debug logs |
| `~/.openpalm/cache/` | Regenerable/control-plane data (akm, logs, backups, rollback snapshots) |
| `~/.cache/openpalm/` | Ephemeral system cache |

Current durable data subdirectories used by the shipped stack:

- `state/assistant`
- `state/guardian`
- `cache/akm`
- `state/akm`
- `cache/logs`
- `cache/backups`
- `stash/` (shared akm stash mounted at `/akm` for assistant)
- `workspace/` (shared work area)

Persistent memory and knowledge live in `stash/` (the shared akm stash
mounted at `/akm` for the assistant). There is no separate memory service.

---

## Compose Env And Secrets

Docker Compose is invoked with the non-secret stack env file (see [Manual Compose Runbook](../operations/manual-compose-runbook.md)):

```bash
--env-file "$OP_HOME/config/stack/stack.env"
```

That means the effective env model is:

- `config/stack/stack.env` - system-managed non-secret runtime env (paths, UID/GID, image tags, bind ports, profiles, feature flags, owner identity)
- `stash/vaults/secrets/` - system-managed secret files, directory mode `0700`, file mode `0600`; granted to containers with Compose `secrets:` and exposed as `*_FILE` variables
- `stash/vaults/user.env` - AKM vault backing file for user-managed secrets; never a Compose env-file

---

## Core Services

> Memory is not a separate service. Persistent knowledge and recall
> live in the akm stash bind-mounted from the host: `stash/` is mounted at `/akm`
> in the assistant container. See
> [`core-principles.md`](core-principles.md) for the rationale.

### Assistant

Compose source: `.openpalm/config/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| baked into image | `/etc/opencode` | image content | Core OpenCode config and built-in extensions |
| `$OP_HOME/config` | `/etc/openpalm` | rw | OpenPalm config tree available inside container |
| `$OP_HOME/config/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | rw | OpenCode auth state |
| `$OP_HOME/state/assistant` | `/home/opencode` | rw | Assistant persistent data |
| `$OP_HOME/stash` | `/akm` | rw | AKM stash |
| `$OP_HOME/state/akm` | `/akm-op` | rw | akm operational data (state.db, execution history) |
| `$OP_HOME/cache/akm` | `/akm-cache` | rw | akm cache and regenerable artifacts |
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
| `OPENCODE_CONFIG_DIR` | `/etc/openpalm/assistant` | OpenPalm-managed OpenCode config root |
| `OPENCODE_PORT` | `4096` | OpenCode web server listen port |
| `OPENCODE_AUTH` | `false` | Auth disabled because host binding is loopback-only by default |
| `OPENCODE_ENABLE_SSH` | `stack.env` | Optional SSH enablement |
| `HOME` | `/home/opencode` | Runtime home |
| `AKM_STASH_DIR` | `/akm` | AKM stash location hint |
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
| `$OP_HOME/state/guardian` | `/app/data` | rw | Runtime nonce / rate-limit state |
| `$OP_HOME/cache/logs` | `/app/audit` | rw | Guardian audit log directory |
| `$OP_HOME/stash/vaults/secrets/<guardian-or-channel-secret>` | `/run/secrets/<name>` | ro | Guardian and channel HMAC secret files granted by Compose |

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
| `GUARDIAN_AUDIT_PATH` | `/app/audit/guardian-audit.log` | Audit log path |
| `CHANNEL_<NAME>_SECRET_FILE` | `/run/secrets/channel_<name>_hmac` | Channel HMAC verification secret file |

Notes:

- Guardian is internal-only from the host perspective.
- It is the only bridge between addon ingress networks and `assistant_net`.
- Guardian receives only explicitly granted secret files from `stash/vaults/secrets/`; it must not use service-level `env_file` or raw secret env values.

### Scheduler co-process

The scheduler is no longer a separate compose service. It runs as a Bun
co-process inside the `assistant` container, launched by
`core/assistant/entrypoint.sh`.

Scheduling control plane (crond started by `core/assistant/entrypoint.sh`):

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/stash/tasks` | `/akm/tasks` | rw | AKM task markdown files |
| `$OP_HOME/state/akm` | `/akm-op` | rw | akm state.db and execution history |
| `$OP_HOME/cache/akm` | `/akm-cache` | rw | akm cache and per-run task logs |

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
| `OP_UI_LOGIN_PASSWORD` | `$OP_HOME/stash/vaults/secrets/op_ui_login_password` | Operator admin password promoted into the host admin process environment |

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
`stash/vaults/secrets/` and are granted only to the service that needs them.
Secret-like container environment variables must use `*_FILE` paths.
