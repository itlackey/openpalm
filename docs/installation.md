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
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  -f addons/chat/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  up -d
```

That example starts the core stack plus the `admin` and `chat` addons.

---

## Home layout

OpenPalm uses one home directory: `~/.openpalm/` by default.

| Path | Purpose |
|---|---|
| `~/.openpalm/stack/` | Live compose files and helper scripts |
| `~/.openpalm/vault/stack/stack.env` | System-managed stack values and tokens |
| `~/.openpalm/vault/user/user.env` | User-managed provider keys and model settings |
| `~/.openpalm/config/` | User-editable config, automations, assistant extensions |
| `~/.openpalm/data/` | Durable service data |
| `~/.openpalm/logs/` | Logs and audit output |

`~/.openpalm/config/stack.yaml` is optional tooling metadata. It is not the
deployment truth.

---

## Important env files

### `~/.openpalm/vault/user/user.env`

Set the provider keys and model settings your assistant should use.

Common values include:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `ANTHROPIC_API_KEY`
- `SYSTEM_LLM_PROVIDER`
- `SYSTEM_LLM_MODEL`
- `MEMORY_USER_ID`

### `~/.openpalm/vault/stack/stack.env`

This file holds system-managed values such as:

- `OP_ADMIN_TOKEN`
- `ASSISTANT_TOKEN`
- `MEMORY_AUTH_TOKEN`
- `OP_HOME`, `OP_UID`, `OP_GID`
- `OP_ASSISTANT_PORT`, `OP_ADMIN_PORT`, `OP_MEMORY_PORT`, `OP_CHAT_PORT`

Review it before first start, especially if you need different host ports or
paths.

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

### `stack/start.sh`

The copied bundle includes `~/.openpalm/stack/start.sh`, which wraps the same
compose files:

```bash
cd "$HOME/.openpalm/stack"
./start.sh admin chat
./start.sh --status admin chat
./start.sh --stop admin chat
```

### Installer scripts and CLI

If you want a bootstrap shortcut, you can still use the repo setup scripts or
the `openpalm` CLI. They prepare the same `~/.openpalm/` layout and ultimately
run Docker Compose against files in `~/.openpalm/stack/`.

---

## Verify

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  -f core.compose.yml \
  -f addons/admin/compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  ps
```

Default host ports are documented in [system-requirements.md](system-requirements.md).

---

## Next steps

| Guide | Description |
|---|---|
| [manual-setup.md](manual-setup.md) | Fully explicit compose workflow |
| [setup-guide.md](setup-guide.md) | Convenience-oriented setup flow |
| [password-management.md](password-management.md) | Secret layout and token handling |
| [troubleshooting.md](troubleshooting.md) | Common problems and fixes |
