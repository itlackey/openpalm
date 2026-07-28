# Installation

OpenPalm's installer creates more than the files shipped in
`packages/skeleton/`. It materializes the managed stack, app state, private
secrets, cache directories, and runtime files required by the CLI and UI.

Do not use a raw copy of `packages/skeleton/` as an installation.

## Prerequisites

- Docker Engine or Docker Desktop with Compose V2
- `curl` on Linux/macOS, or PowerShell 5.1+ on Windows

See [System Requirements](system-requirements.md) for supported platforms and
hardware guidance.

## Recommended Install

### Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

### Windows

Run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

The script downloads and verifies the matching `openpalm` CLI, then runs
`openpalm install`. The browser setup flow creates the complete `OP_HOME`
(default `~/.openpalm/`) and starts the selected services.

## Headless Install

For an unattended or CI installation, provide a version 2 JSON or YAML setup
spec:

```bash
openpalm install --file ./setup-spec.yaml
```

Use `--no-start` to generate the installation without starting containers:

```bash
openpalm install --file ./setup-spec.yaml --no-start
```

See [Manual and Headless Install](operations/manual-headless-install.md) for the
current spec shape.

## Runtime Layout

| Path | Purpose |
|---|---|
| `~/.openpalm/system/stack/` | Managed `core.compose.yml`, `services.compose.yml`, and `portals.compose.yml` |
| `~/.openpalm/config/stack/custom.compose.yml` | The only user-owned Compose overlay |
| `~/.openpalm/system/assistant/` | Managed assistant OpenCode config mounted at `/etc/opencode` |
| `~/.openpalm/system/guardian/` | Managed Guardian OpenCode config mounted at `/etc/opencode` |
| `~/.openpalm/config/assistant/` | User OpenCode global config for the assistant |
| `~/.openpalm/config/guardian/` | User Guardian model config |
| `~/.openpalm/config/akm/` | AKM configuration |
| `~/.openpalm/state/stack.env` | Sole Compose `--env-file`; non-secret values and enabled-addon state |
| `~/.openpalm/private/secrets/` | UI, Guardian, API, portal, bot, and OpenCode-server secrets |
| `~/.openpalm/knowledge/secrets/auth.json` | Assistant-readable OpenCode provider credentials |
| `~/.openpalm/knowledge/env/user.env` | AKM user env, loaded on demand rather than by Compose or the assistant entrypoint |
| `~/.openpalm/knowledge/tasks/` | AKM scheduled task files |
| `~/.openpalm/data/` | Durable service data and lifecycle backups |
| `~/.openpalm/cache/` | Regenerable container caches |
| `~/.openpalm/workspace/` | Shared assistant workspace mounted at `/work` |

`config/` is user-owned. Automatic lifecycle operations may refresh `system/`
and app-owned `state/`, but do not overwrite existing user configuration.

## Addons and Raw Compose

OpenPalm records first-party addons in `OP_ENABLED_ADDONS` within
`state/stack.env` and translates those IDs to `--profile addon.<id>` when the
CLI or host UI invokes Compose.

Docker Compose does not interpret `OP_ENABLED_ADDONS`. A raw
`docker compose` command must pass each active `--profile addon.<id>` itself, or
set `COMPOSE_PROFILES` explicitly. See the
[Manual Compose Runbook](operations/manual-compose-runbook.md).

## Verify

```bash
openpalm status
```

The default assistant UI is <http://localhost:3800/>. The optional host admin
surface is started with `openpalm admin` at <http://127.0.0.1:3880/host>.

## Next Steps

| Guide | Description |
|---|---|
| [Setup Guide](setup-guide.md) | Interactive and file-based setup |
| [Manual Compose Runbook](operations/manual-compose-runbook.md) | Explicit Compose operations after installation |
| [Password & Secret Management](password-management.md) | Current secret boundaries and rotation |
| [Troubleshooting](troubleshooting.md) | Common problems and diagnostics |
