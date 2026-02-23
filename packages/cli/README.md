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
| `extensions <install\|uninstall\|list>` | Manage extensions |
| `admin command --type <type> [--payload <json>]` | Execute authenticated Admin API commands |
| `dev preflight` | Validate development environment |
| `dev create-channel` | Scaffold a new channel adapter |

## Install options

- `--runtime <docker|podman|orbstack>` — Force container runtime
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

## Admin API mode (assistant-safe orchestration path)

The `admin command` subcommand calls the admin container over HTTP using `x-admin-token` auth, so callers do not need Docker socket access.

Environment variables (all optional):

- `OPENPALM_ADMIN_API_URL` (preferred), `ADMIN_APP_URL`, or `GATEWAY_URL` for admin endpoint resolution.
- `OPENPALM_ADMIN_TOKEN` (preferred) or `ADMIN_TOKEN` for authentication.
- `OPENPALM_ADMIN_TIMEOUT_MS` request timeout (default `15000`).
- `OPENPALM_ALLOW_INSECURE_ADMIN_HTTP=1` to allow public/non-private HTTP URLs (not recommended).

Examples:

```bash
# Start a specific service
openpalm admin command --type service.up --payload '{"service":"channel-discord"}'

# Stop a specific service
openpalm admin command --type service.stop --payload '{"service":"channel-discord"}'

# Restart/update a specific service
openpalm admin command --type service.restart --payload '{"service":"assistant"}'
openpalm admin command --type service.update --payload '{"service":"assistant"}'

# Read service logs and current stack status
openpalm admin command --type service.logs --payload '{"service":"gateway","tail":200}'
openpalm admin command --type service.status

# Trigger automation and configure channels
openpalm admin command --type automation.trigger --payload '{"id":"example-job"}'
openpalm admin command --type channel.configure --payload '{"channel":"discord","exposure":"lan"}'
```
