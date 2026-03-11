# @openpalm/cli

Bun CLI for bootstrapping and managing an OpenPalm installation. Handles the initial install (directory creation, asset download, secret seeding) and delegates to the Admin API once the stack is running.

## Commands

| Command | Description |
|---|---|
| `openpalm install` | Bootstrap XDG dirs, download assets, start admin + docker-socket-proxy, open setup wizard |
| `openpalm uninstall` | Stop and remove the stack (preserves config and data) |
| `openpalm update` | Pull latest images and recreate containers |
| `openpalm start [svc...]` | Start all or named services |
| `openpalm stop [svc...]` | Stop all or named services |
| `openpalm restart [svc...]` | Restart all or named services |
| `openpalm logs [svc...]` | Tail last 100 log lines |
| `openpalm status` | Show container status |
| `openpalm service <sub> [svc...]` | Alias — subcommands: `start`, `stop`, `restart`, `logs`, `status`, `update` |

### Install options

`--force` skip "already installed" check, `--version TAG` install a specific ref (default `main`), `--no-start` prepare files only, `--no-open` skip browser launch.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | User config + secrets |
| `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` | Persistent service data |
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | Assembled runtime |
| `OPENPALM_WORK_DIR` | `~/openpalm` | Assistant working directory |
| `OPENPALM_ADMIN_API_URL` | `http://localhost:8100` | Admin API endpoint |
| `OPENPALM_ADMIN_TOKEN` | (from `secrets.env`) | Admin API auth token |

## How it works

1. **Bootstrap** (no stack running) — creates XDG directory tree, downloads `docker-compose.yml` + `Caddyfile` from GitHub, seeds `secrets.env` and `stack.env`, starts core services via `docker compose`
2. **Running stack** — all commands delegate to the Admin API (`/admin/install`, `/admin/containers/*`, etc.) using `x-admin-token` auth

Follows the file-assembly principle: copies whole files, never renders templates. See [`docs/core-principles.md`](../../docs/core-principles.md).

## Building

```bash
bun run build                  # Current platform → dist/openpalm-cli
bun run build:linux-x64        # Cross-compile (also: linux-arm64, darwin-x64, darwin-arm64, windows-x64, windows-arm64)
```

## Development

```bash
cd packages/cli
bun run start -- install --no-start
bun test
```

See also: [`scripts/install.sh`](../../scripts/install.sh) (binary installer), [`scripts/setup.sh`](../../scripts/setup.sh) (shell-based installer).
