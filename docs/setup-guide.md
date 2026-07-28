# Setup Guide

OpenPalm has two recommended setup paths:

1. Run `setup.sh` or `setup.ps1` and complete the browser wizard.
2. Run `openpalm install --file` with a version 2 setup spec for an unattended install.

Both paths create the complete runtime layout. Copying `packages/skeleton/`
alone is not a complete install because state, private secrets, cache paths, and
other runtime files are generated during installation.

## Prerequisites

Install Docker with Compose V2 and ensure the daemon is running:

```bash
docker info
docker compose version
```

See [System Requirements](system-requirements.md) for platform details.

## Interactive Setup

### Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

### Windows

```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

The installer downloads and verifies the CLI, runs `openpalm install`, and
opens the setup wizard on the loopback-only host UI. The wizard configures:

- the UI login password
- OpenCode provider credentials and models
- AKM LLM and embedding settings
- optional first-party addons
- flat access controls for the UI, assistant API, Guardian, and compatible API

The normal home-install control is `access.networkAccess`. Advanced controls
are `access.assistantDirect`, `access.guardianNetwork`, and
`access.guardianOpenaiApi`. These are independent booleans, not presets.

## Headless Setup

Create a version 2 YAML or JSON setup spec and run:

```bash
openpalm install --file ./setup-spec.yaml
```

A minimal fresh-install spec is:

```yaml
version: 2
security:
  uiLoginPassword: change-me-please
connections: []
access:
  networkAccess: false
  assistantDirect: false
  guardianNetwork: false
  guardianOpenaiApi: false
```

Provider, model, owner, addon, and portal credential fields are optional. See
[Manual and Headless Install](operations/manual-headless-install.md) for a full
example and validation rules.

Use `--no-start` when another process will run Compose later:

```bash
openpalm install --file ./setup-spec.yaml --no-start
```

## Deployment Truth

The installed stack has three ownership layers:

- Managed Compose files: `~/.openpalm/system/stack/core.compose.yml`,
  `services.compose.yml`, and `portals.compose.yml`
- User overlay: `~/.openpalm/config/stack/custom.compose.yml`
- App-owned runtime record and sole Compose env file:
  `~/.openpalm/state/stack.env`

First-party addon IDs are recorded in `OP_ENABLED_ADDONS`. OpenPalm commands
translate them to Compose profiles. Raw Docker Compose does not, so manual
commands must include matching `--profile addon.<id>` arguments or an explicit
`COMPOSE_PROFILES` value.

## Access Settings

Setup writes flat bind settings rather than a shared bind cascade:

- `OP_UI_BIND_ADDRESS`
- `OP_ASSISTANT_BIND_ADDRESS`
- `OP_GUARDIAN_BIND_ADDRESS`
- `OP_API_BIND_ADDRESS`

There is no global bind inheritance, SSH listener, or separate chat listener.
Voice remains loopback-only, and the Guardian-hosted compatible
API uses `OP_API_PORT` (default `3821`).

## After Setup

```bash
openpalm status
openpalm logs assistant
```

Default URLs:

| URL | Purpose |
|---|---|
| <http://localhost:3800/> | Assistant UI served by the assistant container |
| <http://localhost:3810/> | Assistant OpenCode server |
| <http://127.0.0.1:3880/host> | Host admin UI after `openpalm admin` |
| <http://localhost:3821/> | Guardian-hosted compatible API when enabled |
| <http://localhost:8880/> | Voice API when enabled |

## Power-User Compose

Generate the installation first, preferably with `openpalm install --file
... --no-start`, then use the fixed file list in the
[Manual Compose Runbook](operations/manual-compose-runbook.md). This preserves
the same on-disk contract as CLI-managed installs without requiring the CLI for
day-to-day Compose commands.

## Existing 0.10.x Installs

The historical [0.10.x to 0.11.0 upgrade guide](operations/upgrade-0.10-to-0.11.md)
remains the reference for that migration. It is not a fresh-install procedure.

## Next Steps

| Guide | Purpose |
|---|---|
| [Managing OpenPalm](managing-openpalm.md) | Day-to-day operations |
| [Manual Compose Runbook](operations/manual-compose-runbook.md) | Raw Compose commands and profile handling |
| [How It Works](how-it-works.md) | Runtime and security model |
| [Core Principles](technical/core-principles.md) | Architectural invariants |
