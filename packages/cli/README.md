# @openpalm/cli

Bun CLI for bootstrapping and managing an OpenPalm installation. The CLI is the primary orchestrator -- all commands work without the admin container. When admin is running, commands optionally delegate to the admin API.

## Self-Sufficient Mode

The CLI operates directly against Docker Compose without requiring an admin container:

- **Install** -- creates the `~/.openpalm/` home layout, downloads assets, serves the setup wizard locally via `Bun.serve()`, writes files to their final locations, and starts core services
- **All lifecycle commands** -- refresh files in `~/.openpalm/` when needed, then run Docker Compose directly
- **Admin delegation** -- the `install` command checks for a running admin and delegates if reachable. Other commands operate directly via Docker Compose.

The admin container is optional. Use `--with-admin` to enable the admin addon overlay in the compose file set.

## Commands

| Command | Description |
|---|---|
| `openpalm install` | Bootstrap `~/.openpalm/`, download assets, run setup wizard, start core services |
| `openpalm uninstall` | Stop and remove the stack (preserves config and data) |
| `openpalm update` | Pull latest images and recreate containers |
| `openpalm upgrade` | Alias for `update` |
| `openpalm self-update` | Replace the installed CLI binary with the latest release build |
| `openpalm addon <enable|disable|list>` | Manage registry addons directly from the CLI |
| `openpalm admin <enable|disable|status>` | Manage the admin addon directly from the CLI |
| `openpalm start [svc...]` | Start all or named services |
| `openpalm start --with-admin` | Start all services including admin UI and docker-socket-proxy |
| `openpalm stop [svc...]` | Stop all or named services |
| `openpalm restart [svc...]` | Restart all or named services |
| `openpalm logs [svc...]` | Tail last 100 log lines |
| `openpalm status` | Show container status |
| `openpalm service <sub> [svc...]` | Alias -- subcommands: `start`, `stop`, `restart`, `logs`, `status`, `update` |
| `openpalm validate` | Validate vault env files against their schemas (requires prior install) |
| `openpalm scan` | Scan for leaked secrets in config files |

### Install options

`--force` skip "already installed" check and create a backup of the current `OP_HOME`, `--version TAG` install a specific ref (default: current CLI version), `--no-start` prepare files only, `--no-open` skip browser launch.

### Admin addon

Admin and docker-socket-proxy start only when explicitly requested:

```bash
openpalm admin enable           # Enable the admin addon and start its services
openpalm admin disable          # Stop and disable the admin addon
openpalm admin status           # Show whether the admin addon is enabled
openpalm addon enable chat      # Enable a registry addon and start its services
openpalm addon disable chat     # Stop and disable a registry addon
openpalm addon list             # Show available addons and whether they are enabled
```

## Setup Wizard

On first install, the CLI serves a setup wizard on port `8100` via `Bun.serve()`. That temporary setup port is separate from the admin container, which defaults to `http://localhost:3880` once installed. The wizard runs entirely in the browser (vanilla HTML/JS) and calls `performSetup()` from `@openpalm/lib` to write secrets, connection profiles, memory config, and other files to their final locations. No admin container is involved.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OP_HOME` | `~/.openpalm` | Root of all OpenPalm state |
| `OP_WORK_DIR` | `~/openpalm` | Assistant working directory |
| `OP_ADMIN_API_URL` | `http://localhost:3880` | Admin API endpoint (for optional delegation) |
| `OP_ADMIN_TOKEN` | (from `vault/stack/stack.env`) | Admin API auth token |

## How It Works

1. **Bootstrap** (first install) -- creates the `~/.openpalm/` tree, downloads core assets from GitHub, seeds `vault/user/user.env` and `vault/stack/stack.env`, materializes the runtime registry catalog under `registry/`, serves the setup wizard, writes `stack/core.compose.yml`, enables requested addons under `stack/addons/`, and starts core services via `docker compose up`
2. **Running stack** -- commands refresh files in `~/.openpalm/` when needed, then execute Docker Compose directly.
3. **Admin absent** -- all commands work identically. Admin is never required for any operation.

Follows the file-assembly principle: copies whole files, never renders templates. See [`core-principles.md`](../../docs/technical/core-principles.md).

## Building

```bash
bun run build                  # Current platform -> dist/openpalm-cli
bun run build:linux-x64        # Cross-compile (also: linux-arm64, darwin-x64, darwin-arm64, windows-x64, windows-arm64)
```

## Development

```bash
cd packages/cli
bun run start -- install --no-start
bun test
```

See also: [`scripts/setup.sh`](../../scripts/setup.sh) and [`scripts/setup.ps1`](../../scripts/setup.ps1). Both installers support `--cli-only` when you only want to install or refresh the CLI binary without touching the stack or `OP_HOME`.
