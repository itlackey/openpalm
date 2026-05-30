# ~/.openpalm

This bundle is the shipped OpenPalm home directory skeleton. Copy it to
`~/.openpalm/` (or another location via `OP_HOME`). The repo bundle is the
source asset set; the copied directory becomes the runtime home.

## Runtime directory layout (OP_HOME)

At runtime, after `openpalm install` or manual setup, `OP_HOME` (default `~/.openpalm/`) contains:

```text
~/.openpalm/
  config/
    stack/             Stack configuration and composition
      core.compose.yml Core services (always used)
      services.compose.yml Optional first-party services (profile-gated)
      channels.compose.yml Optional first-party channels (profile-gated)
      custom.compose.yml User custom services/overlays
      stack.yml        Stack schema marker and enabled first-party addons
      stack.env        System-managed non-secret env vars (written by CLI/admin)
    assistant/         OpenCode user tools, plugins, skills, commands
    akm/               AKM config directory
    auth.json          Optional auth metadata

  stash/
    vaults/            User-managed secrets (akm vault:user)
    tasks/             Scheduled automation task files (*.yml)

  state/
    assistant/         Assistant home and local runtime state
    admin/             Admin runtime home
    guardian/          Guardian nonce and rate-limit state
    akm/cache/         AKM cache and task logs
    akm/data/          AKM databases and durable data
    logs/              Service logs and audit output
    backups/           Snapshot backups (created by CLI/admin during upgrades)
    rollback/          Rollback snapshots

  workspace/           Shared `/work` mount
```

## Repo source asset structure (.openpalm/)

This repo directory contains source assets embedded by the CLI during build. These are **not** the runtime layout:

```text
.openpalm/               Repo source assets (embedded by CLI)
  config/
    stack/               Seed files for runtime config/stack/
      core.compose.yml   Core Compose file copied to OP_HOME
      services.compose.yml Optional services Compose file
      channels.compose.yml Optional channels Compose file
      custom.compose.yml User-editable custom Compose stub
      stack.yml          Template stack spec (copied at install)
    assistant/           Seed files for config/assistant/
    guardian/            Guardian config placeholders
  stash/                 Built-in AKM stash assets (skills, tasks, vault path)
```

## Quick start

Recommended install path:

```bash
openpalm install
```

Manual setup:

```bash
cp -r .openpalm/ ~/.openpalm/
$EDITOR ~/.openpalm/config/stack/stack.env
mkdir -m 700 -p ~/.openpalm/stash/vaults/secrets
# Create required secret files here, mode 0600, before enabling addons.
docker compose \
  --project-name openpalm \
  --env-file ~/.openpalm/config/stack/stack.env \
  -f ~/.openpalm/config/stack/core.compose.yml \
  -f ~/.openpalm/config/stack/services.compose.yml \
  -f ~/.openpalm/config/stack/channels.compose.yml \
  -f ~/.openpalm/config/stack/custom.compose.yml \
  --profile addon.chat \
  up -d
```

See [Manual Compose Runbook](../docs/operations/manual-compose-runbook.md) for the full reference.

The live stack is defined by the fixed compose file set in `config/stack/`.
Built-in optional services are activated with Compose profiles; manual custom
services and overlays belong in `custom.compose.yml`.

## Ownership rules

| Directory | Owner | Who writes |
|---|---|---|
| `config/` | User | User edits, explicit admin actions, assistant via authenticated admin API |
| `config/stack/` | System/User | CLI/admin manage fixed runtime assets and `stack.env`; users edit `custom.compose.yml` |
| `stash/vaults/` | User | User edits via akm vault CLI or admin UI secret updates |
| `stash/tasks/` | User/Services | User creates task markdown; assistant registers with OS cron |
| `state/` | Services | Containers and processes at runtime |
| `workspace/` | Services | Durable shared data (not a secret store) |

## Runtime notes

- Docker Compose global env file: `config/stack/stack.env` (system-managed, non-secret).
- Service secrets live under `stash/vaults/secrets/` and are granted narrowly through Compose `secrets:` with `*_FILE` environment variables.
- The assistant workspace is `workspace/`, mounted at `/work`.
- The CLI always runs from the host and manages Docker Compose directly. Admin UI is a host process started by `openpalm` — no container is needed.
- Scheduled automations are stored as markdown task files in `stash/tasks/` and registered with OS cron by the assistant at startup via `akm tasks sync`.
