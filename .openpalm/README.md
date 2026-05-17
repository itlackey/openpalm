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
      stack.yml        Capabilities only (metadata)
      stack.env        System-managed env vars (written by CLI/admin)
      guardian.env     Channel HMAC secrets (written by CLI/admin)
      addons/          Enabled addon overlays
    assistant/         OpenCode user tools, plugins, skills, commands
    akm/               AKM config directory
    auth.json          Optional auth metadata

  stash/
    vaults/            User-managed secrets (akm vault:user)
    tasks/             Scheduled automation task files (*.md)

  cache/
    akm/               AKM cache (regenerable)
    guardian/          Guardian cache (regenerable)
    rollback/          Rollback snapshots (regenerable)

  state/
    assistant/         Assistant home and local runtime state
    admin/             Admin runtime home
    guardian/          Guardian nonce and rate-limit state
    akm/               AKM operational data
    logs/              Service logs
    backups/           Snapshot backups (created by CLI/admin during upgrades)
    registry/addons/   Enabled addon metadata (read from source during install)
    registry/automations/  Automation catalog

  workspace/           Shared `/work` mount (durable, shared by services)
```

## Repo source asset structure (.openpalm/)

This repo directory contains source assets embedded by the CLI during build. These are **not** the runtime layout:

```text
.openpalm/               Repo source assets (embedded by CLI)
  stack/                 core.compose.yml source
  registry/              Addon and automation catalog sources
    addons/
    automations/
  stash-seeds/           Built-in stash skills/commands
  config/
    stack/               Seed files for config/stack/
      stack.yml          Template for capabilities (copied at install)
    assistant/           Seed files for config/assistant/
    guardian/            Guardian config placeholders
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
docker compose \
  --project-name openpalm \
  --env-file ~/.openpalm/config/stack/stack.env \
  --env-file ~/.openpalm/config/stack/guardian.env \
  -f ~/.openpalm/config/stack/core.compose.yml \
  -f ~/.openpalm/config/stack/addons/chat/compose.yml \
  up -d
```

Before running that command, enable each addon you want by copying it from the
catalog into the runtime stack, for example:

```bash
cp -r ~/.openpalm/registry/addons/chat ~/.openpalm/config/stack/addons/chat
```

See [Manual Compose Runbook](../docs/operations/manual-compose-runbook.md) for the full reference.

The live stack is defined by `config/stack/core.compose.yml` plus whichever enabled
addon compose files you include from `config/stack/addons/`. `config/stack/stack.yml`
stores capabilities only; it does not replace Compose as the runtime source of
truth.

## Ownership rules

| Directory | Owner | Who writes |
|---|---|---|
| `config/` | User | User edits, explicit admin actions, assistant via authenticated admin API |
| `config/stack/` | System | CLI/admin (stack.env, guardian.env, core.compose.yml, addons/) |
| `stash/vaults/` | User | User edits via akm vault CLI or admin UI secret updates |
| `stash/tasks/` | User/Services | User creates task markdown; assistant registers with OS cron |
| `state/` | Services | Containers and processes at runtime |
| `cache/` | System | Regenerable artifacts (AKM cache, rollback snapshots) |
| `workspace/` | Services | Durable shared data (not a secret store) |

## Runtime notes

- Docker Compose global env files: `config/stack/stack.env` (system-managed) and `config/stack/guardian.env` (channel HMAC secrets).
- Guardian loads channel HMAC secrets from `config/stack/guardian.env` with hot-reload support (via `GUARDIAN_SECRETS_PATH`).
- The assistant workspace is `workspace/`, mounted at `/work`.
- The CLI always runs from the host and manages Docker Compose directly. Admin UI is a host process started by `openpalm` — no container is needed.
- Scheduled automations are stored as markdown task files in `stash/tasks/` and registered with OS cron by the assistant at startup via `akm tasks sync`.
