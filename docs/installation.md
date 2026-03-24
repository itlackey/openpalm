# Installation

OpenPalm now documents the compose-first, manual-first setup as the primary
path. The running stack is the exact Docker Compose file set you launch from
`~/.openpalm/stack/`.

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
$EDITOR "$HOME/.openpalm/vault/stack/stack.env"
$EDITOR "$HOME/.openpalm/vault/user/user.env"
```

Then start the stack using the compose commands in the [Manual Compose Runbook](operations/manual-compose-runbook.md). That example starts the core stack plus any addons you choose (e.g., `admin` and `chat`).

---

## Home layout

OpenPalm uses one home directory: `~/.openpalm/` by default.

| Path | Purpose |
|---|---|
| `~/.openpalm/stack/` | Live compose files and helper scripts |
| `~/.openpalm/vault/stack/stack.env` | System-managed stack values and tokens |
| `~/.openpalm/vault/user/user.env` | User-managed settings (owner info, custom preferences) |
| `~/.openpalm/config/` | User-editable config, automations, assistant extensions |
| `~/.openpalm/data/` | Durable service data |
| `~/.openpalm/logs/` | Logs and audit output |

`~/.openpalm/config/stack.yaml` is optional tooling metadata. It is not the
deployment truth.

---

## Important env files

### `~/.openpalm/vault/stack/stack.env`

This file holds system-managed values and provider API keys:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `ANTHROPIC_API_KEY`
- `SYSTEM_LLM_PROVIDER`
- `SYSTEM_LLM_MODEL`
- `MEMORY_USER_ID`

It also includes system-managed values such as:

- `OP_ADMIN_TOKEN`
- `OP_ASSISTANT_TOKEN`
- `OP_MEMORY_TOKEN`
- `OP_HOME`, `OP_UID`, `OP_GID`
- `OP_ASSISTANT_PORT`, `OP_ADMIN_PORT`, `OP_MEMORY_PORT`, `OP_CHAT_PORT`

Review it before first start, especially if you need different host ports or
paths.

### `~/.openpalm/vault/user/user.env`

Optional user-managed settings such as owner name and email.

---

## Addons

Addons are just more compose files under `~/.openpalm/stack/addons/`.

| Addon | Compose file |
|---|---|
| `admin` | `addons/admin/compose.yml` |
| `chat` | `addons/chat/compose.yml` |
| `api` | `addons/api/compose.yml` |
| `discord` | `addons/discord/compose.yml` |
| `slack` | `addons/slack/compose.yml` |
| `voice` | `addons/voice/compose.yml` |
| `ollama` | `addons/ollama/compose.yml` |
| `openviking` | `addons/openviking/compose.yml` |

If a compose file is not included with `-f`, it is not part of the running
stack.

---

## Optional convenience paths

The primary workflow is always raw `docker compose` as shown above. The
shortcuts below are provided for convenience but are not the canonical form.

For the full compose command reference including convenience shortcuts, see the
[Manual Compose Runbook](operations/manual-compose-runbook.md).

### Installer scripts and CLI

If you want a bootstrap shortcut, you can still use the repo setup scripts or
the `openpalm` CLI. They prepare the same `~/.openpalm/` layout and ultimately
run Docker Compose against files in `~/.openpalm/stack/`.

---

## Verify

Check container status using the `ps` command from the [Manual Compose Runbook](operations/manual-compose-runbook.md).

Default host ports are documented in [system-requirements.md](system-requirements.md).

---

## Next steps

| Guide | Description |
|---|---|
| [technical/manual-setup.md](technical/manual-setup.md) | Fully explicit compose workflow |
| [setup-guide.md](setup-guide.md) | Convenience-oriented setup flow |
| [password-management.md](password-management.md) | Secret layout and token handling |
| [troubleshooting.md](troubleshooting.md) | Common problems and fixes |
