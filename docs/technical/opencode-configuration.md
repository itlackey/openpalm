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
- `~/.openpalm/knowledge/env/stack.env` provides non-secret runtime and resolved capability env values.
- `~/.openpalm/knowledge/secrets/` stores file-based service secrets; provider keys are stored in OpenCode auth state or narrow secret files.
- `~/.openpalm/knowledge/env/user.env` is the AKM user env backing file, not a Compose env file.
- Project-local OpenCode config inside `/work` still works per normal OpenCode behavior, but OpenPalm's container wiring is controlled by Compose.

---

## Assistant Runtime Wiring

### Mounts

| Host path | Container path | Purpose |
|---|---|---|
| `~/.openpalm/config/assistant/` | `/etc/opencode` | OpenCode config, tools, plugins, skills, commands |
| `~/.openpalm/config/akm/` | `/etc/akm` | AKM config |
| `~/.openpalm/knowledge/secrets/auth.json` | `/home/opencode/.local/share/opencode/auth.json` | Host-managed OpenCode auth copy |
| `~/.openpalm/knowledge/` | `/stash` | AKM stash (memory, skills, env, secrets; read via akm) |
| `~/.openpalm/data/assistant/` | `/home/opencode` | Assistant home |
| `~/.openpalm/data/akm/cache/` | `/opt/akm/cache` | AKM cache and task logs |
| `~/.openpalm/data/akm/data/` | `/opt/akm/data` | AKM databases and durable data |
| `~/.openpalm/workspace/` | `/work` | Shared workspace |

### Key environment variables

| Variable | Value | Purpose |
|---|---|---|
| `OPENCODE_CONFIG_DIR` | `/etc/opencode` | OpenPalm-managed OpenCode config root |
| `OPENCODE_PORT` | `4096` | Assistant OpenCode HTTP port |
| `OPENCODE_AUTH` | `false` | Disabled by default because host exposure is loopback-only |
| `OPENCODE_ENABLE_SSH` | from `stack.env` | Optional SSH server toggle |
| `HOME` | `/home/opencode` | Runtime home |
| `AKM_STASH_DIR` | `/stash` | Shared akm stash bind-mounted from `${OP_HOME}/knowledge` (memory + skills) |
| `AKM_CONFIG_DIR` | `/etc/akm` | AKM config directory |
| `AKM_CACHE_DIR` | `/opt/akm/cache` | AKM cache directory |
| `AKM_DATA_DIR` | `/opt/akm/data` | AKM durable data directory |

### Operational notes

- The assistant starts in `/work`.
- The assistant has no Docker socket mount.
- Memory + skills are served via the bind-mounted akm stash; there is no separate memory service.
- The entrypoint normalizes permissions, optionally enables SSH, then drops privileges to `OP_UID:OP_GID`.
- The assistant can consume external MCP servers via the top-level `mcp` block in `config/assistant/opencode.jsonc`; this is consume-only. OpenCode does not expose its own MCP server.
- Treat MCP config edits like any other OpenCode startup config change: restart the assistant container after changing `opencode.jsonc` so the new server list is loaded.

## Guardian Runtime Wiring

The guardian image also ships OpenCode (same `OPENCODE_VERSION` as the assistant) for its opt-in **content-validation** moderator.

| Host path | Container path | Purpose |
|---|---|---|
| `~/.openpalm/config/guardian/` | `/etc/opencode` | Moderator OpenCode config (`opencode.jsonc`, `instructions/moderation.md`) |
| `~/.openpalm/knowledge/secrets/auth.json` | `/opt/openpalm/guardian/.local/share/opencode/auth.json` (ro) | Shared provider credentials (same file the assistant uses) |

- Started on loopback `127.0.0.1:4097` by the guardian entrypoint only when `GUARDIAN_CONTENT_VALIDATION` is enabled.
- Pins a small model in `config/guardian/opencode.jsonc`; reuses the assistant's provider via the shared `auth.json`.
- Tools are denied (`bash`/`edit`/`webfetch`) — it is a classifier, not an agent.

---

---

## Configuration Layers

There are three practical layers to remember:

1. `/etc/opencode` - OpenPalm-managed runtime config mounted from `config/assistant/`
2. Project-local OpenCode config inside `/work` - optional per-project overrides managed by normal OpenCode behavior

OpenPalm's filesystem and mount contract decides what is available to each layer;
Compose remains the source of truth for that contract.

---

## Security Boundary

- The assistant has no Docker socket.
- The assistant mounts `knowledge/` at `/stash` for the shared AKM stash (memory, skills, env, secrets). User secrets are accessed via the akm CLI, not a separate `/etc/vault/` mount.
- Stack-level secrets live as files under `knowledge/secrets/` and are granted only to services that need them. `stack.env` is non-secret Compose/runtime configuration.
- Admin is a host process. It accesses the Docker socket directly on the host — no container is involved in admin operations.

---

## Day-To-Day Changes

- Add tools, plugins, commands, or skills under `~/.openpalm/config/assistant/`.
- Update provider keys through OpenCode auth state or file-based secret management; keep model-related non-secret env in `~/.openpalm/knowledge/env/stack.env`.
- Change service wiring by editing the compose file set in `~/.openpalm/config/stack/`.
- Verify the exact runtime by reading `~/.openpalm/config/stack/core.compose.yml` and any addon overlays used for startup.
