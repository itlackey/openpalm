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
