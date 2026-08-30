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

> These `access.*` fields require OpenPalm `0.13.0` or newer. `setup.sh` and
> `setup.ps1` resolve the latest **stable** release by default. On a release
> older than `0.13.0`, an `access` object in a setup spec is silently accepted
> and ignored rather than applied — pin `--version`/`OP_VERSION` to
> `0.13.0` or later if these fields matter to your install.

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

- Managed Compose files in `~/.openpalm/system/stack/`. `core.compose.yml`,
  `services.compose.yml`, and `portals.compose.yml` are the three every deploy
  uses. The directory also ships five conditional overlays that are not part of
  every deploy: `voice.compose.lan.yml` (applied when
  `OP_VOICE_LAN_ACCESS=true`), `voice.compose.rootless.yml` /
  `voice.compose.cdi.yml` (hardware fallbacks the voice bring-up flow selects
  automatically for rootless Docker or CDI-only NVIDIA hosts),
  `guardian.compose.api.yml` (the OpenAI-compatible edge's only host publish,
  applied when `guardianOpenaiApi` or the `api` addon is on), and
  `workspace.compose.loopback.yml` (applied when `OP_UI_BIND_ADDRESS` is a
  concrete address, so OpenCode's web UI still answers on `127.0.0.1`) — eight
  managed files ship in total, not three.
- User overlay: `~/.openpalm/config/stack/custom.compose.yml`
- App-owned runtime record and sole Compose env file:
  `~/.openpalm/state/stack.env`

First-party addon IDs are recorded in `OP_ENABLED_ADDONS`. OpenPalm commands
translate them to Compose profiles. Raw Docker Compose does not, so manual
commands must include matching `--profile addon.<id>` arguments or an explicit
`COMPOSE_PROFILES` value.

## Runtime Layout

Beyond the Compose files above, a complete install also generates:

| Path | Purpose |
|---|---|
| `~/.openpalm/system/assistant/` | Managed assistant OpenCode config mounted at `/etc/opencode` |
| `~/.openpalm/system/guardian/` | Managed Guardian OpenCode config, mounted read-only and republished into the moderator's `/etc/opencode` at boot |
| `~/.openpalm/config/assistant/` | User OpenCode global config for the assistant |
| `~/.openpalm/config/guardian/` | User Guardian model config |
| `~/.openpalm/config/akm/` | AKM configuration |
| `~/.openpalm/state/secrets/` | UI, Guardian, API, portal, bot, and OpenCode-server secrets |
| `~/.openpalm/knowledge/secrets/auth.json` | Assistant-readable OpenCode provider credentials |
| `~/.openpalm/knowledge/env/user.env` | AKM user env, loaded on demand rather than by Compose or the assistant entrypoint |
| `~/.openpalm/knowledge/tasks/` | AKM scheduled task files |
| `~/.openpalm/data/` | Durable service data and lifecycle backups |
| `~/.openpalm/cache/` | Regenerable container caches |
| `~/.openpalm/workspace/` | Shared assistant workspace mounted at `/work` |

`config/` is user-owned. Automatic lifecycle operations may refresh `system/`
and app-owned `state/`, but do not overwrite existing user configuration.

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

## Reaching OpenPalm from Another Device

With `access.networkAccess` on, the assistant UI publishes on every interface,
not just loopback. From a phone, tablet, or another computer on the same
network, open:

```text
http://<name>.local:3800
```

`<name>` is the project name (`openpalm` by default; `OP_PROJECT_NAME` if you
changed it). **The port is not optional** — a browser resolving a bare `.local`
name follows the DNS `A` record it gets, which points at the host, and defaults
to port 80, not 3800. If `.local` names don't resolve on your network (some
routers and older Android builds block mDNS), use the machine's LAN IP
instead:

```text
http://<host-ip>:3800
```

The `<name>.local` advertisement is sent by whichever host `openpalm` process
is running (bare `openpalm`, `openpalm app`, `openpalm admin`, or Electron) —
it is not the container. The assistant container itself keeps serving
`:3800` under Docker's `unless-stopped` restart policy even when no host
process is running, for example right after a reboot before you've relaunched
the CLI or desktop app — but nothing is left to answer the `.local` name until
a host process starts again. The IP URL always works regardless; see
[Troubleshooting → openpalm.local Stopped Resolving](troubleshooting.md#openpalmlocal-stopped-resolving).

Everyone who opens either URL still signs in with the UI login password.

## Power-User Compose

Generate the installation first, preferably with `openpalm install --file
... --no-start`, then use the managed file list (plus any conditional voice
overlay) in the
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
| [Password & Secret Management](password-management.md) | Current secret boundaries and rotation |
| [Troubleshooting](troubleshooting.md) | Common problems and diagnostics |
| [How It Works](how-it-works.md) | Runtime and security model |
| [Core Principles](technical/core-principles.md) | Architectural invariants |
