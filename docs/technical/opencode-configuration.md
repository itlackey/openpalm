# OpenCode Configuration Integration

This document covers how OpenPalm wires OpenCode into the assistant and admin
containers today.

Primary runtime sources:

- `.openpalm/stack/core.compose.yml`
- `.openpalm/stack/addons/admin/compose.yml`
- `core/assistant/entrypoint.sh`
- `core/admin/entrypoint.sh`

---

## What Is Authoritative

- The running assistant is defined by `.openpalm/stack/core.compose.yml`.
- The optional admin-side OpenCode runtime is defined by `.openpalm/stack/addons/admin/compose.yml`.
- `~/.openpalm/config/assistant/` is the user-editable OpenCode extension surface.
- `~/.openpalm/vault/user/user.env` and `~/.openpalm/vault/stack/stack.env` provide runtime env values.
- Project-local OpenCode config inside `/work` still works per normal OpenCode behavior, but OpenPalm's container wiring is controlled by Compose.

---

## Assistant Runtime Wiring

### Mounts

| Host path | Container path | Purpose |
|---|---|---|
| baked into image | `/etc/opencode` | Core OpenCode config and built-in extensions |
| `~/.openpalm/config/assistant/` | `/home/opencode/.config/opencode` | User tools, plugins, skills, commands |
| `~/.openpalm/config/` | `/etc/openpalm` | OpenPalm config tree |
| `~/.openpalm/vault/stack/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | OpenCode auth state |
| `~/.openpalm/vault/user/user.env` | `/etc/openpalm-vault/user.env` | Read-only user secrets file |
| `~/.openpalm/data/assistant/` | `/home/opencode` | Assistant home |
| `~/.openpalm/data/stash/` | `/home/opencode/.akm` | AKM stash |
| `~/.openpalm/data/workspace/` | `/work` | Shared workspace |
| `~/.openpalm/logs/opencode/` | `/home/opencode/.local/state/opencode` | Logs and OpenCode state |

### Key environment variables

| Variable | Value | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Core OpenCode config root |
| `OPENCODE_PORT` | `4096` | Assistant OpenCode HTTP port |
| `OPENCODE_AUTH` | `false` | Disabled by default because host exposure is loopback-only |
| `OPENCODE_ENABLE_SSH` | from `stack.env` | Optional SSH server toggle |
| `HOME` | `/home/opencode` | Runtime home |
| `OP_ADMIN_API_URL` | from `stack.env` / addon wiring | Admin API URL when admin is present |
| `OP_ASSISTANT_TOKEN` | mapped from `ASSISTANT_TOKEN` | Assistant auth token for admin API calls |
| `MEMORY_API_URL` | `http://memory:8765` | Memory service URL |
| `MEMORY_AUTH_TOKEN` | from `stack.env` | Memory auth token |
| `MEMORY_USER_ID` | from env or default | Default memory identity |

### Operational notes

- The assistant starts in `/work`.
- The assistant has no Docker socket mount.
- The assistant mounts only `vault/user/user.env` from the vault boundary, not the full directory.
- The entrypoint normalizes permissions, optionally enables SSH, then drops privileges to `OP_UID:OP_GID`.

---

## Admin OpenCode Wiring

The optional admin addon runs its own OpenCode instance alongside the SvelteKit
admin API/UI process.

### Mounts

| Host path | Container path | Purpose |
|---|---|---|
| baked into image | `/etc/opencode` | Built-in admin OpenCode config |
| `~/.openpalm/` | `/openpalm` | Full OpenPalm home for control-plane access |
| `~/.openpalm/data/admin/` | `/home/node` | Admin home |
| `~/.openpalm/data/workspace/` | `/work` | Shared workspace |

### Key environment variables

| Variable | Value | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | Admin OpenCode config root |
| `OPENCODE_PORT` | `3881` | Admin-side OpenCode port |
| `OPENCODE_AUTH` | `false` | Disabled by default for loopback-only host binding |
| `OP_ADMIN_API_URL` | `http://localhost:8100` | Admin self-reference |
| `DOCKER_HOST` | `tcp://docker-socket-proxy:2375` | Docker API via proxy |

This OpenCode runtime is where the admin-tools plugin is loaded.

---

## Configuration Layers

There are three practical layers to remember:

1. `/etc/opencode` - image-baked core config
2. `/home/opencode/.config/opencode` - user extensions mounted from `config/assistant/`
3. Project-local OpenCode config inside `/work` - optional per-project overrides managed by normal OpenCode behavior

OpenPalm's filesystem and mount contract decides what is available to each layer;
Compose remains the source of truth for that contract.

---

## Security Boundary

- The assistant has no Docker socket.
- The assistant receives only `vault/user/user.env` as a read-only file mount from the vault boundary.
- Stack-level secrets such as `OP_ADMIN_TOKEN` and channel HMAC secrets remain in `vault/stack/stack.env` and are not mounted as files into the assistant.
- Admin-side Docker access is mediated by `docker-socket-proxy` on the isolated `admin_docker_net` network.

---

## Day-To-Day Changes

- Add tools, plugins, commands, or skills under `~/.openpalm/config/assistant/`.
- Update provider keys and model-related env in `~/.openpalm/vault/user/user.env`.
- Change service wiring by editing the compose file set in `~/.openpalm/stack/`.
- Verify the exact runtime by reading `~/.openpalm/stack/core.compose.yml` and any addon overlays used for startup.
