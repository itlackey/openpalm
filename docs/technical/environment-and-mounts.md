# Environment Variables, Mounts, and Network Wiring

This document mirrors the current shipped runtime: repo assets under
`packages/skeleton/` and runtime files under `OP_HOME`.

Primary sources:

- `.openpalm/config/stack/core.compose.yml`
- `.openpalm/config/stack/services.compose.yml`
- `.openpalm/config/stack/portals.compose.yml`
- `.openpalm/config/stack/custom.compose.yml`
- `containers/*/entrypoint.sh` and service source where runtime defaults matter

When this document conflicts with older prose elsewhere, the compose files win.

---

## Host-Level Layout

OpenPalm stores runtime state under `OP_HOME`, which defaults to `~/.openpalm`.

| Host path | Purpose |
|---|---|
| `~/.openpalm/config/` | User-editable, non-secret config |
| `~/.openpalm/config/stack/` | Live compose assembly; `core.compose.yml`, `services.compose.yml`, `portals.compose.yml`, and `custom.compose.yml` |
| `~/.openpalm/knowledge/` | AKM knowledge base (user-managed: `env/`, `secrets/`, `tasks/`) |
| `~/.openpalm/knowledge/env/` | User-managed env config (`user.env`, AKM env backing store) |
| `~/.openpalm/knowledge/secrets/` | System-managed file secrets (akm secret — Compose grants) |
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
--env-file "$OP_HOME/knowledge/env/stack.env"
```

That means the effective env model is:

- `knowledge/env/stack.env` - system-managed non-secret runtime env (paths, UID/GID, image tags, bind ports, profiles, feature flags, owner identity)
- `knowledge/secrets/` - system-managed secret files, directory mode `0700`, file mode `0600`; granted to containers with Compose `secrets:` and exposed as `*_FILE` variables
- `knowledge/env/user.env` - AKM env backing file for user-managed secrets; never a Compose env-file

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
| `$OP_HOME/knowledge/secrets/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | rw | Host-managed OpenCode auth copy |
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
| Networks | `assistant_net` |

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | OpenPalm-managed OpenCode config root |
| `OPENCODE_PORT` | `4096` | OpenCode web server listen port |
| `OPENCODE_AUTH` | `false` | Auth disabled because host binding is loopback-only by default |
| `HOME` | `/home/opencode` | Runtime home |
| `AKM_STASH_DIR` | `/stash` | AKM stash location hint |
| `AKM_CONFIG_DIR` | `/etc/akm` | AKM config directory |
| `AKM_CACHE_DIR` | `/opt/akm/cache` | AKM cache directory |
| `AKM_DATA_DIR` | `/opt/akm/data` | AKM durable data directory |
| `OP_UID` / `OP_GID` | `stack.env` | Direct runtime uid/gid mapping |

Notes:

- The assistant has no Docker socket mount.
- The assistant reads user secrets via `akm env:user` — there is no `/etc/vault/` container mount.
- The entrypoint starts as root only long enough to normalize permissions and optional SSH setup, then drops privileges.

### Guardian

Compose source: `.openpalm/config/stack/core.compose.yml`

Mounts:

| Host path | Container path | Mode | Purpose |
|---|---|---|---|
| `$OP_HOME/data/guardian` | `/opt/openpalm/guardian` | rw | Runtime nonce / rate-limit state |
| `$OP_HOME/config/guardian` | `/etc/opencode` | rw | Guardian OpenCode global config (`OPENCODE_CONFIG_DIR`) |
| `$OP_HOME/knowledge/secrets/auth.json` | `/opt/openpalm/guardian/.local/share/opencode/auth.json` | ro | Shared OpenCode provider credentials (same file the assistant mounts) |
| `$OP_HOME/data/logs` | `/opt/openpalm/logs` | rw | Guardian audit log directory |
| `$OP_HOME/knowledge/secrets/<guardian-or-principal-secret>` | `/run/secrets/<name>` | ro | Guardian and portal/direct principal secret files granted by Compose |

Ports and networks:

| Item | Value |
|---|---|
| Container port | `8080` |
| Host bind | `${OP_BIND_ADDRESS:-127.0.0.1}:${OP_GUARDIAN_PORT:-3830}` plus `127.0.0.1:${OP_GUARDIAN_ADMIN_PORT:-3831}` |
| Networks | `portal_net`, `assistant_net` |

Key env:

| Variable | Value / source | Purpose |
|---|---|---|
| `HOME` | `/opt/openpalm/guardian` | Writable runtime home |
| `PORT` | `8080` | HTTP listen port |
| `OP_ASSISTANT_URL` | `http://assistant:4096` | Assistant forward target |
| `OPENCODE_TIMEOUT_MS` | `0` | Guardian-side timeout override |
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Moderator OpenCode config dir (from `config/guardian`) |
| `GUARDIAN_AUDIT_PATH` | `/opt/openpalm/logs/guardian-audit.log` | Audit log path |
| `PORTAL_<NAME>_SECRET_FILE` | `/run/secrets/portal_<name>_secret` | Portal principal seed secret file |
| `GUARDIAN_CONTENT_VALIDATION` | `0` | Enable opt-in, fail-closed content validation of inbound messages |
| `GUARDIAN_MODERATION_URL` | `http://127.0.0.1:4097` | Local OpenCode moderator endpoint |
| `GUARDIAN_MODERATION_PORT` | `4097` | Loopback port the entrypoint starts the moderator on |
| `GUARDIAN_MODERATION_THRESHOLD` | `3` | Heuristic risk score at/above which a message escalates to the model |
| `GUARDIAN_MODERATION_TIMEOUT_MS` | `4000` | Per-classification timeout; on expiry the message fails closed |

Notes:

- Guardian's main proxy is localhost-published by default and never exposed publicly unless the bind address is changed deliberately.
- It is the only bridge between addon ingress networks and `assistant_net`.
- Guardian receives only explicitly granted secret files from `knowledge/secrets/`; it must not use service-level `env_file` or raw secret env values.

### Scheduler co-process

The scheduler is no longer a separate compose service. It runs as a Bun
co-process inside the `assistant` container, launched by
`containers/assistant/entrypoint.sh`.

Scheduling control plane (crond started by `containers/assistant/entrypoint.sh`):

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

Bind address: `127.0.0.1:${OP_HOST_UI_PORT:-3880}` (loopback only — never reachable from containers or LAN). Reach it remotely over an SSH tunnel (`ssh -L 3880:localhost:3880 host`) or a reverse proxy. To bind all interfaces for genuine LAN access (including the first-run setup wizard), set `OP_ALLOW_REMOTE_SETUP=1` — this relaxes the Host/Origin allowlist and the setup-localhost-only gate, so only enable it on a trusted network behind a firewall.

Key env (host process, not container):

| Variable | Value / source | Purpose |
|---|---|---|
| `PORT` | `OP_HOST_UI_PORT` or `3880` | Admin HTTP listen port |
| `OP_HOME` | resolved from host env | OpenPalm home directory |
| `OP_UI_LOGIN_PASSWORD` | `$OP_HOME/knowledge/secrets/op_ui_login_password` | Operator admin password promoted into the host admin process environment |
| `OP_ALLOW_REMOTE_SETUP` | unset (`0`) | When `1`/`true`/`yes`: bind `0.0.0.0`, allow any Host/same-origin, and permit remote access to the setup wizard. Off by default (loopback-only). |

---

## Addon Overlays Shipped In The Repo

| Addon | Host bind | Internal port | Network(s) | Notes |
|---|---|---:|---|---|
| `chat` | `${OP_CHAT_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_CHAT_PORT:-3820}` | `8182` | `portal_net` | Guardian image OpenAI-compatible edge (chat profile alias) |
| `api` | `${OP_API_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_API_PORT:-3821}` | `8182` | `portal_net` | Guardian image OpenAI/Anthropic-compatible edge |
| `voice` | `${OP_VOICE_BIND_ADDRESS:-${OP_BIND_ADDRESS:-127.0.0.1}}:${OP_VOICE_PORT_HOST:-8880}` | `8880` | `portal_net` | Voice interface |
| `discord` | none | service-specific | `portal_net` | No host port exposure |
| `slack` | none | service-specific | `portal_net` | No host port exposure |
| `ollama` | none (internal only) | `11434` | `assistant_net` | Mounts `$OP_HOME/data/ollama:/home/ollama/.ollama`; no host port exposed |

Portal services use `user: "${OP_UID:-1000}:${OP_GID:-1000}"` where they write host mounts. The optional guardian-hosted OpenAI-compatible edge talks back to the main guardian over `/oc` using its own principal secret file.

---

## Docker Networks

| Network | Connected services | Purpose |
|---|---|---|
| `assistant_net` | `assistant` (also hosts the scheduler co-process), `guardian` | Core internal service mesh |
| `portal_net` | `guardian` and LAN-facing portal/addon edges | Default portal ingress network |
| `portal_public` | `guardian` only in core; public-facing overlays can join it intentionally | Public ingress isolation |

---

## Core Stack Variables From `stack.env`

These variables are consumed by Compose and service env blocks.

| Variable | Purpose |
|---|---|
| `OP_HOME` | Host OpenPalm root used in bind mounts |
| `OP_UID`, `OP_GID` | Runtime UID/GID for bind-mounted file ownership |
| `OP_IMAGE_NAMESPACE`, `OP_IMAGE_TAG` | Image selection |
| `OP_HOST_UI_PORT` | Admin UI host port (default `3880`); the admin UI runs as a host process, not a container |
| `OP_ASSISTANT_BIND_ADDRESS`, `OP_ASSISTANT_PORT` | Assistant host bind |
| `OP_CHAT_BIND_ADDRESS`, `OP_CHAT_PORT` | Chat addon host bind |
| `OP_API_BIND_ADDRESS`, `OP_API_PORT` | API addon host bind |
| `OP_VOICE_BIND_ADDRESS`, `OP_VOICE_PORT` | Voice addon host bind |
| `OP_OWNER_NAME` | Operator display name |
| `OP_OWNER_EMAIL` | Operator email |

---

## User Secrets From `user.env`

This file is the AKM env backing file for user-managed secrets. It is not
passed to Docker Compose and is not mounted directly into containers.

Provider/model selections and other non-secret preferences live in `stack.env`
or `config/akm/config.json`. System-managed service secrets live as files under
`knowledge/secrets/` and are granted only to the service that needs them.
Secret-like container environment variables must use `*_FILE` paths.
