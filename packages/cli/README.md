# openpalm CLI

CLI tool for installing, managing, and operating an OpenPalm stack. Published to npm as `openpalm`.

## Installation

```bash
npx openpalm install
# or
bunx openpalm install
```

## Commands

| Command | Description |
|---|---|
| `install` | Install and start the OpenPalm stack |
| `uninstall` | Stop and remove OpenPalm |
| `update` | Pull latest images and recreate containers |
| `start [service...]` | Start services |
| `stop [service...]` | Stop services |
| `restart [service...]` | Restart services |
| `logs [service...]` | View container logs |
| `status` | Show container status |
| `service <up\|stop\|restart\|logs\|update\|status>` | Domain-based service operations |
| `channel <add\|configure>` | Domain-based channel operations |
| `extensions <install\|uninstall\|list>` | Manage extensions |
| `dev preflight` | Validate development environment |
| `dev create-channel` | Scaffold a new channel adapter |

## Install options

- `--runtime <docker|podman>` — Force container runtime
- `--no-open` — Don't auto-open browser after install
- `--ref <branch|tag>` — Git ref for asset download

## Building

Cross-platform compiled binaries:

```bash
bun run build                 # Default platform
bun run build:linux-x64       # Linux x64
bun run build:linux-arm64     # Linux ARM64
bun run build:darwin-x64      # macOS x64
bun run build:darwin-arm64    # macOS ARM64
bun run build:windows-x64     # Windows x64
bun run build:windows-arm64   # Windows ARM64
```

Binaries are output to `dist/`.

## Development

```bash
# Run directly from source
bun run src/main.ts install

# Run tests
cd packages/cli && bun test
```

## Dependencies

Depends on `@openpalm/lib` (workspace package) for shared utilities like path resolution, runtime detection, and compose generation.

## Execution modes (same commands for local and remote admin)

Domain commands automatically choose execution mode:

- **Local mode (default):** if admin API env vars are not explicitly set, service commands run locally via compose.
- **Remote admin API mode:** if admin API env vars are set, domain commands call admin over HTTP (`x-admin-token`), so callers do not need Docker socket access.
- **Assistant env fallback:** CLI also reads `${OPENPALM_STATE_HOME}/assistant/.env` for admin URL/token values.

Environment variables (all optional):

- `OPENPALM_ADMIN_API_URL` (preferred), `ADMIN_APP_URL`, or `GATEWAY_URL` for admin endpoint resolution.
- `OPENPALM_ADMIN_TOKEN` (preferred) or `ADMIN_TOKEN` for authentication.
- `OPENPALM_ADMIN_TIMEOUT_MS` request timeout (default `15000`).
- `OPENPALM_ALLOW_INSECURE_ADMIN_HTTP=1` to allow public/non-private HTTP URLs (not recommended).

Examples:

```bash
# Local default service execution
openpalm service restart assistant

# Remote admin API execution (same command shape)
export OPENPALM_ADMIN_API_URL=http://admin:8100
export OPENPALM_ADMIN_TOKEN=...
openpalm service restart assistant

# Domain commands for channels
openpalm channel add /path/to/channel.yaml
openpalm channel configure chat --exposure lan
```
