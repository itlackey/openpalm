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
      portals.compose.yml Optional first-party portals (profile-gated)
      custom.compose.yml User custom services/overlays
    assistant/         OpenCode user tools, plugins, skills, commands
    guardian/          Guardian OpenCode global config (mounted at /etc/opencode)
    akm/               AKM config directory

  knowledge/
    env/               User-managed env config (akm env:user — user.env)
    secrets/           Stack-managed file secrets (akm secret — Compose grants)
      auth.json        OpenCode provider credentials (shared by assistant + guardian)
    tasks/             Scheduled automation task files (*.yml)

  data/
    assistant/         Assistant home and local runtime state
    ui/                Operator UI build (@openpalm/ui), seeded/updated from npm
    guardian/          Guardian nonce and rate-limit state
    akm/cache/         AKM cache and task logs
    akm/data/          AKM databases and durable data
    logs/              Service logs and audit output
    backups/           Snapshot backups (created by CLI/admin during upgrades)
    rollback/          Rollback snapshots

  workspace/           Shared `/work` mount
  openpalm.sh          Power-user helper: docker compose up/down/restart/upgrade (bash)
  openpalm.ps1         Power-user helper: docker compose up/down/restart/upgrade (PowerShell)
```

> `openpalm.sh` / `openpalm.ps1` are example convenience wrappers around the
> same `docker compose` invocation the CLI and admin UI use. The canonical
> orchestrator remains the `openpalm` CLI and the admin UI; the helpers let
> power users drive the stack directly. Their `upgrade` only pulls images and
> recreates containers — it does not refresh shipped assets or the UI build the
> way `openpalm update` does.

## Repo source asset structure (.openpalm/)

This repo directory contains source assets embedded by the CLI during build. These are **not** the runtime layout:

```text
.openpalm/               Repo source assets (embedded by CLI)
  config/
    stack/               Seed files for runtime config/stack/
      core.compose.yml   Core Compose file copied to OP_HOME
      services.compose.yml Optional services Compose file
      portals.compose.yml Optional portals Compose file
      custom.compose.yml User-editable custom Compose stub
    assistant/           Seed files for config/assistant/ (OpenCode config)
    guardian/            Guardian OpenCode global config (opencode.jsonc → /etc/opencode)
  knowledge/             Built-in AKM stash assets (skills, tasks, env, secrets)
  openpalm.sh            Power-user docker compose helper (bash)
  openpalm.ps1           Power-user docker compose helper (PowerShell)
```

## Quick start

Recommended install path:

```bash
openpalm install
```

Manual setup:

```bash
cp -r .openpalm/ ~/.openpalm/
$EDITOR ~/.openpalm/knowledge/env/stack.env
mkdir -m 700 -p ~/.openpalm/knowledge/secrets
# Create required secret files here, mode 0600, before enabling addons.
docker compose \
  --project-name openpalm \
  --env-file ~/.openpalm/knowledge/env/stack.env \
  -f ~/.openpalm/config/stack/core.compose.yml \
  -f ~/.openpalm/config/stack/services.compose.yml \
  -f ~/.openpalm/config/stack/portals.compose.yml \
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
| `config/` | User | User edits and explicit admin actions |
| `config/stack/` | System/User | CLI/admin manage fixed runtime assets; users edit `custom.compose.yml` |
| `knowledge/env/` | User | User edits `user.env` directly or via admin UI user-env updates |
| `knowledge/secrets/` | System | Stack-managed file secrets (Compose grants); written by CLI/admin |
| `knowledge/tasks/` | User/Services | User creates task markdown; assistant registers with OS cron |
| `data/` | Services | Containers and processes at runtime |
| `workspace/` | Services | Durable shared data (not a secret store) |

## Runtime notes

- Docker Compose global env file: `knowledge/env/stack.env` (system-managed, non-secret).
- Service secrets live under `knowledge/secrets/` and are granted narrowly through Compose `secrets:` with `*_FILE` environment variables.
- The assistant workspace is `workspace/`, mounted at `/work`.
- The CLI always runs from the host and manages Docker Compose directly. Admin UI is a host process started by `openpalm` — no container is needed.
- Scheduled automations are stored as markdown task files in `knowledge/tasks/` and registered with OS cron by the assistant at startup via `akm tasks sync`.
