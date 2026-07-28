# OpenPalm CLI

The `openpalm` CLI installs and manages OpenPalm directly on the host. It owns
the complete runtime layout and invokes Docker Compose without a containerized
admin service or Docker socket proxy.

## Install

Linux and macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

The scripts download and verify the platform binary, then run
`openpalm install`. Use `--cli-only` when you only want to install or refresh
the binary.

Copying `packages/skeleton/` is not an equivalent install; the CLI generates
state, private secrets, cache paths, and runtime files in addition to seeding
release assets.

## Commands

| Command | Purpose |
|---|---|
| `openpalm` | Smart default: install if absent, start if stopped, then serve the normal host UI |
| `openpalm admin` | Serve the loopback-only admin-capable UI at `/host` |
| `openpalm app` | Serve the non-admin app without requiring a local stack |
| `openpalm install` | Generate the home, run the browser wizard, and deploy |
| `openpalm install --file <spec>` | Unattended JSON/YAML version 2 setup |
| `openpalm start [service...]` | Start the stack or named services |
| `openpalm stop [service...]` | Stop the stack or named services |
| `openpalm restart [service...]` | Restart the stack or named services |
| `openpalm logs [service...]` | Show service logs |
| `openpalm status` | Show current container status |
| `openpalm update` | Refresh managed assets and safely reapply containers |
| `openpalm addon enable\|disable\|list` | Manage first-party addon state and profiles |
| `openpalm validate` | Validate current environment/configuration |
| `openpalm audit-secrets` | Validate Compose secret grants |
| `openpalm scan` | Inventory discovered sensitive keys and secret files as set or empty without printing values |
| `openpalm doctor` | Report Docker, port, storage, and cache state |
| `openpalm backups prune --keep <n>` | Prune lifecycle backups with confirmation |
| `openpalm rollback` | Restore the latest lifecycle snapshot |
| `openpalm reset-password` | Reset the UI login password |
| `openpalm uninstall` | Remove containers while preserving host state by default |
| `openpalm self-update` | Replace the host CLI binary |

Run `openpalm <command> --help` for command-specific options.

## Install Options

```bash
openpalm install --file ./setup-spec.yaml
openpalm install --file ./setup-spec.yaml --no-start
openpalm install --force --yes
openpalm install --version 0.13.0
```

`--file` skips the wizard. `--no-start` writes the complete installation but
does not deploy. `--force` backs up an existing home before reconciling it.

## Filesystem Behavior

The CLI creates and manages:

```text
system/stack/{core,services,portals}.compose.yml
config/stack/custom.compose.yml
state/stack.env
private/secrets/
knowledge/secrets/auth.json
knowledge/env/user.env
data/
cache/
workspace/
```

`state/stack.env` is the sole Compose env file and contains no secrets.
Delegated UI, Guardian, API, portal, bot, and OpenCode-server secrets live in
`private/secrets/`. Provider auth remains in `knowledge/secrets/auth.json`.

The CLI translates `OP_ENABLED_ADDONS` to active Compose profiles. This is a
control-plane behavior, not something raw Docker Compose does automatically.

## UI Modes

| Mode | Capability | Default URL |
|---|---|---|
| Assistant container UI | Non-admin | `http://localhost:3800/` |
| Bare `openpalm` / `openpalm app` | Non-admin host UI | `http://localhost:3880/` |
| `openpalm admin` | Host admin, loopback-only | `http://127.0.0.1:3880/host` |

Current UI APIs use `/api/auth/*`, `/api/host/*`, and `/api/assistant/*`.
`/admin/*` intentionally returns `404`.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `OP_HOME` | `~/.openpalm` | Root of OpenPalm state |
| `OP_HOST_UI_PORT` | `3880` | Host UI process port |
| `OP_UI_PORT` | `3800` | Assistant-served UI host port |
| `OP_ASSISTANT_PORT` | `3810` | Assistant OpenCode host port |
| `OP_PROJECT_NAME` | `openpalm` | Compose project name |

The UI password source is
`${OP_HOME}/private/secrets/op_ui_login_password`. Browser auth uses an
`HttpOnly`, `SameSite=Lax` session cookie.

## Development

```bash
cd packages/cli
bun run start -- install --no-start
bun test
bun run build
```

Cross-platform build scripts are declared in `packages/cli/package.json`.

See [Core Principles](../../docs/technical/core-principles.md) for the
filesystem and security contract.
