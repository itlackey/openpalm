# Installation

OpenPalm now documents the compose-first, manual-first setup as the primary
path. The running stack is the exact Docker Compose file set you launch from
`~/.openpalm/config/stack/`.

If you prefer convenience tooling, the CLI can still help bootstrap the same
layout, but it is not the source of truth.

---

## Prerequisites

- Docker Engine or Docker Desktop with Compose V2
- `git` or another way to copy files from this repo
- `curl` only if you plan to use the installer scripts

See [system-requirements.md](system-requirements.md) for version and hardware
details.

---

## Recommended install

```bash
git clone https://github.com/itlackey/openpalm.git
cp -R openpalm/.openpalm "$HOME/.openpalm"

$EDITOR "$HOME/.openpalm/knowledge/env/stack.env"
$EDITOR "$HOME/.openpalm/knowledge/env/user.env"
```

Then start the stack using the compose commands in the [Manual Compose Runbook](operations/manual-compose-runbook.md). That example starts the core stack plus any addons you choose (e.g., `admin` and `chat`).

---

## Home layout

OpenPalm uses one home directory: `~/.openpalm/` by default.

| Path | Purpose |
|---|---|
| `~/.openpalm/config/stack/` | Live compose files |
| `~/.openpalm/knowledge/tasks/` | Available automation task files |
| `~/.openpalm/knowledge/env/stack.env` | System-managed non-secret stack values |
| `~/.openpalm/knowledge/env/user.env` | Optional user-managed extension settings |
| `~/.openpalm/config/` | User-editable config and assistant extensions |
| `~/.openpalm/data/` | Durable service data |
| `~/.openpalm/data/logs/` | Logs and audit output |

First-party addon activation lives in `OP_ENABLED_ADDONS` inside
`~/.openpalm/knowledge/env/stack.env`. Docker Compose deployment still comes
from the fixed compose files and profiles derived by OpenPalm tooling.

---

## Important env files

### `~/.openpalm/knowledge/env/stack.env`

This file holds **non-secret** system-managed runtime values only — host paths,
ports, image tags, and similar Compose substitution variables. It is **not** for
secrets.

Examples of what belongs here:

- `OP_HOME`, `OP_UID`, `OP_GID`
- `OP_ASSISTANT_PORT`, `OP_HOST_UI_PORT`, `OP_CHAT_PORT`
- `OPENAI_BASE_URL` (base URL only, not the key)

**Secrets go elsewhere:**

- Provider API keys (OpenAI, Anthropic, etc.) → `~/.openpalm/knowledge/secrets/auth.json`
  (managed via the Connections tab in the admin UI)
- UI login password → `~/.openpalm/knowledge/secrets/op_ui_login_password`

LLM and embedding model configuration lives in `config/akm/config.json` and is
managed via the AKM tab in the admin UI — not in `stack.env`.

Review `stack.env` before first start if you need different host ports or paths.

### `~/.openpalm/knowledge/env/user.env`

Optional user-managed extension settings. Starts empty; use for custom
preferences and addon-specific values.

---

## Addons

First-party addons are defined in `services.compose.yml` and `channels.compose.yml`
under `~/.openpalm/config/stack/`. They become active when their names are recorded
in `OP_ENABLED_ADDONS` inside `~/.openpalm/knowledge/env/stack.env`; OpenPalm converts those names to Compose
`--profile` arguments at launch time. Custom services and overlays go in
`custom.compose.yml`.

| Addon | Compose file | Profile |
|---|---|---|
| `chat` | `channels.compose.yml` | `addon.chat` |
| `api` | `channels.compose.yml` | `addon.api` |
| `discord` | `channels.compose.yml` | `addon.discord` |
| `slack` | `channels.compose.yml` | `addon.slack` |
| `voice` | `services.compose.yml` | `addon.voice` |
| `ollama` | `services.compose.yml` | `addon.ollama` |

Custom or third-party services go in `~/.openpalm/config/stack/custom.compose.yml`;
they are always included when present and do not require a profile entry.

---

## Optional convenience paths

The primary workflow is always raw `docker compose` as shown above. The
shortcuts below are provided for convenience but are not the canonical form.

For the full compose command reference including convenience shortcuts, see the
[Manual Compose Runbook](operations/manual-compose-runbook.md).

### Installer scripts and CLI

If you want a bootstrap shortcut, you can still use the repo setup scripts or
the `openpalm` CLI. They prepare the same `~/.openpalm/` layout and ultimately
run Docker Compose against files in `~/.openpalm/config/stack/`.

---

## Verify

Check container status using the `ps` command from the [Manual Compose Runbook](operations/manual-compose-runbook.md).

Default host ports are documented in [system-requirements.md](system-requirements.md).

---

## Next steps

| Guide | Description |
|---|---|
| [operations/manual-compose-runbook.md](operations/manual-compose-runbook.md) | Fully explicit compose workflow |
| [setup-guide.md](setup-guide.md) | Convenience-oriented setup flow |
| [password-management.md](password-management.md) | Secret layout and token handling |
| [troubleshooting.md](troubleshooting.md) | Common problems and fixes |
