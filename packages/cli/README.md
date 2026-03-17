# @openpalm/cli

Bun CLI for bootstrapping and managing an OpenPalm installation. The CLI is the primary orchestrator -- all commands work without the admin container. When admin is running, commands optionally delegate to the admin API.

## Self-Sufficient Mode

The CLI operates directly against Docker Compose without requiring an admin container:

- **Install** -- creates XDG dirs, downloads assets, serves the setup wizard locally via `Bun.serve()`, stages artifacts, starts core services
- **All lifecycle commands** -- stage artifacts from `@openpalm/lib` using `FilesystemAssetProvider`, then run Docker Compose directly
- **Admin delegation** -- the `install` command checks for a running admin and delegates if reachable. Other commands operate directly via Docker Compose.

The admin container is optional. Use `--with-admin` to include the admin UI profile.

## Commands

| Command | Description |
|---|---|
| `openpalm install` | Bootstrap XDG dirs, download assets, run setup wizard, start core services |
| `openpalm uninstall` | Stop and remove the stack (preserves config and data) |
| `openpalm update` | Pull latest images and recreate containers |
| `openpalm start [svc...]` | Start all or named services |
| `openpalm start --with-admin` | Start all services including admin UI and docker-socket-proxy |
| `openpalm stop [svc...]` | Stop all or named services |
| `openpalm restart [svc...]` | Restart all or named services |
| `openpalm logs [svc...]` | Tail last 100 log lines |
| `openpalm status` | Show container status |
| `openpalm service <sub> [svc...]` | Alias -- subcommands: `start`, `stop`, `restart`, `logs`, `status`, `update` |
| `openpalm validate` | Validate `secrets.env` against the schema (requires prior install) |
| `openpalm scan` | Scan for leaked secrets in config files |

### Install options

`--force` skip "already installed" check, `--version TAG` install a specific ref (default: current CLI version), `--no-start` prepare files only, `--no-open` skip browser launch.

### Admin profile

Admin and docker-socket-proxy use Docker Compose profiles. They start only when explicitly requested:

```bash
openpalm start --with-admin     # Start core + admin profile
openpalm start admin            # Start admin service specifically
openpalm stop admin             # Stop admin service specifically
```

## Setup Wizard

On first install, the CLI serves a setup wizard on port 8100 via `Bun.serve()`. The wizard runs entirely in the browser (vanilla HTML/JS) and calls `performSetup()` from `@openpalm/lib` to write secrets, connection profiles, memory config, and stage artifacts. No admin container is involved.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | User config + secrets |
| `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` | Persistent service data |
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | Assembled runtime |
| `OPENPALM_WORK_DIR` | `~/openpalm` | Assistant working directory |
| `OPENPALM_ADMIN_API_URL` | `http://localhost:8100` | Admin API endpoint (for optional delegation) |
| `OPENPALM_ADMIN_TOKEN` | (from `secrets.env`) | Admin API auth token |

## How It Works

1. **Bootstrap** (first install) -- creates XDG directory tree, downloads core assets from GitHub, seeds `secrets.env` and `stack.env`, serves setup wizard, stages artifacts via `@openpalm/lib`, starts core services via `docker compose up`
2. **Running stack** -- commands stage artifacts locally using `FilesystemAssetProvider`, then execute Docker Compose directly.
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

See also: [`scripts/setup.sh`](../../scripts/setup.sh) (shell-based installer).
