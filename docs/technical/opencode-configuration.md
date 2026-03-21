# OpenCode Configuration Integration

OpenPalm uses a compose-first, manual-first OpenCode setup. The assistant runs as
an OpenCode container, but the host-owned files under `~/.openpalm/` remain the
source of truth for what gets mounted and how the service starts.

---

## What is authoritative

- The running assistant comes from the compose files under `~/.openpalm/stack/`.
- `~/.openpalm/config/assistant/` is the user-editable OpenCode config surface.
- `~/.openpalm/config/stack.yaml` is optional tooling metadata only. It does not
  change the running assistant unless some helper reads it and turns it into a
  compose command.
- `vault/user/user.env` and `vault/stack/stack.env` provide runtime env values;
  they are not replaced by any XDG or staging model.

---

## Runtime mounts

The core compose file mounts the assistant like this:

| Host path | Container path | Purpose |
|---|---|---|
| `~/.openpalm/config/` | `/etc/openpalm` | Read-only OpenPalm config root |
| `~/.openpalm/config/assistant/` | `/home/opencode/.config/opencode` | User OpenCode config, tools, skills, plugins |
| `~/.openpalm/vault/user/user.env` | `/etc/openpalm-vault/user.env` | Read-only user secrets file |
| `~/.openpalm/data/assistant/` | `/home/opencode/.opencode` | Assistant runtime state |
| `~/.openpalm/data/stash/` | `/home/opencode/.akm` | AKM stash |
| `~/.openpalm/data/workspace/` | `/work` | Working directory |
| `~/.openpalm/logs/opencode/` | `/home/opencode/.local/state/opencode` | Logs and session state |

The assistant also receives `vault/user/user.env` through Compose `env_file`, so
provider keys and related settings are available as environment variables.

---

## Key environment variables

| Variable | Source | Purpose |
|---|---|---|
| `OPENCODE_PORT` | compose | OpenCode web server port inside the container (`4096`) |
| `OPENCODE_AUTH` | compose | Disabled by default; host bind address is the main boundary |
| `OPENCODE_ENABLE_SSH` | `vault/stack/stack.env` | Optional SSH server toggle |
| `OP_ADMIN_API_URL` | compose/addon wiring | Admin API base URL when the admin addon is present |
| `OP_ASSISTANT_TOKEN` | mapped from `ASSISTANT_TOKEN` in `vault/stack/stack.env` | Assistant auth token for admin API calls |
| `MEMORY_API_URL` | compose | Memory service URL |
| `MEMORY_AUTH_TOKEN` | `vault/stack/stack.env` | Memory API auth token |
| `MEMORY_USER_ID` | `vault/user/user.env` | Default memory identity |

Provider keys and model settings such as `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
`SYSTEM_LLM_PROVIDER`, and `SYSTEM_LLM_MODEL` come from
`~/.openpalm/vault/user/user.env`.

---

## Configuration layers

OpenPalm keeps this simple:

1. `~/.openpalm/config/assistant/` - the active OpenCode config directory in the
   current compose setup.
2. Project-level `.opencode/` or `opencode.json` files inside `/work` - optional
   per-project OpenCode config, following normal OpenCode behavior.

The assistant image may still bundle core defaults, but the current stack points
`OPENCODE_CONFIG_DIR` at the mounted user config path.

There is no separate OpenPalm XDG config/data/state split in the current model,
and there is no generated staging/artifacts layer that you need to inspect to
understand the live assistant configuration.

---

## Security boundary

- The assistant has no Docker socket.
- The assistant does not mount the full `vault/` directory; it only gets
  `vault/user/user.env` as a single read-only file.
- System secrets such as `OP_ADMIN_TOKEN` stay in `vault/stack/stack.env` and
  are not broadly exposed to the assistant container.
- All addon and service wiring still flows through the compose file set under
  `~/.openpalm/stack/`.

---

## Day-to-day changes

- Add your own OpenCode tools, skills, or plugins under
  `~/.openpalm/config/assistant/`.
- Change provider keys or model settings in `~/.openpalm/vault/user/user.env`.
- Change which services are available to the assistant by changing the compose
  file set you run from `~/.openpalm/stack/`.

If you want to verify the exact runtime definition, inspect the compose files
directly - especially `~/.openpalm/stack/core.compose.yml` and any addon files
you started with `-f`.
