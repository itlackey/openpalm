# OpenCode Configuration Integration

This document covers how OpenPalm wires OpenCode into the assistant and admin
containers today.

Primary runtime sources:

- `.openpalm/config/stack/core.compose.yml`
- `core/assistant/entrypoint.sh`

---

## What Is Authoritative

- The running assistant is defined by `.openpalm/config/stack/core.compose.yml`.
- The optional admin-side OpenCode runtime is started by `openpalm` as a host subprocess on a random loopback port.
- `~/.openpalm/config/assistant/` is the user-editable OpenCode extension surface.
- `~/.openpalm/config/stack/stack.env` provides runtime provider keys and resolved capability env values.
- `~/.openpalm/vault/user/user.env` is the recommended place for addon overrides and operator-managed values.
- Project-local OpenCode config inside `/work` still works per normal OpenCode behavior, but OpenPalm's container wiring is controlled by Compose.

---

## Assistant Runtime Wiring

### Mounts

| Host path | Container path | Purpose |
|---|---|---|
| baked into image | `/etc/opencode` | Core OpenCode config and built-in extensions |
| `~/.openpalm/config/assistant/` | `/home/opencode/.config/opencode` | User tools, plugins, skills, commands |
| `~/.openpalm/config/` | `/etc/openpalm` | OpenPalm config tree |
| `~/.openpalm/config/stack/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | OpenCode auth state |
| `~/.openpalm/vault/user/` | `/etc/vault/` | User extension vault directory mount |
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
| `OP_ASSISTANT_TOKEN` | mapped from `OP_ASSISTANT_TOKEN` in `stack.env` | Assistant auth token for admin API calls |
| `AKM_STASH_DIR` | `/akm` | Shared akm stash bind-mounted from `${OP_HOME}/data/stash` (memory + skills) |
| `AKM_CACHE_DIR` | `/akm-cache` | akm cache bind-mounted from `${OP_HOME}/data/akm-cache` |

### Operational notes

- The assistant starts in `/work`.
- The assistant has no Docker socket mount.
- Memory + skills are served via the bind-mounted akm stash; there is no separate memory service.
- The entrypoint normalizes permissions, optionally enables SSH, then drops privileges to `OP_UID:OP_GID`.

---

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
- The assistant receives only `vault/user/` as a mount from the vault boundary.
- Stack-level secrets such as `OP_UI_TOKEN` remain in `config/stack/stack.env`. Channel HMAC secrets live in `config/stack/guardian.env`. Neither is mounted as a file into the assistant.
- Admin is a host process. It accesses the Docker socket directly on the host — no container is involved in admin operations.

---

## Day-To-Day Changes

- Add tools, plugins, commands, or skills under `~/.openpalm/config/assistant/`.
- Update provider keys and model-related env in `~/.openpalm/config/stack/stack.env`.
- Change service wiring by editing the compose file set in `~/.openpalm/config/stack/`.
- Verify the exact runtime by reading `~/.openpalm/config/stack/core.compose.yml` and any addon overlays used for startup.
