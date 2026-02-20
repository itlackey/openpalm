## Implementation Plan: Bun Single-Executable CLI Tool

> Full plan: [`plan.md` on branch `claude/bun-cli-tool-dWvjm`](https://github.com/itlackey/openpalm/blob/claude/bun-cli-tool-dWvjm/plan.md)

### Summary

A new `cli/` workspace will produce a single compiled Bun binary (`openpalm`) that replaces the bash/PowerShell install/uninstall scripts and adds the management subcommands requested in this issue.

### Commands (Issue #58)

| Command | Description |
|---------|-------------|
| `openpalm install` | Full installer (replaces `install.sh`) — detects runtime, generates `.env`, seeds configs, pulls images, starts stack |
| `openpalm update` | Pull latest images and recreate containers |
| `openpalm start` | Start a previously stopped stack |
| `openpalm stop` | Stop the stack (without removing containers) |
| `openpalm restart` | Restart the stack |
| `openpalm logs [service]` | Tail container logs (all or specific service) |
| `openpalm status` | Show container status (`docker compose ps`) |
| `openpalm uninstall` | Stop containers, optionally remove images/data (replaces `uninstall.sh`) |
| `openpalm extensions <install\|uninstall\|list>` | Manage extensions via admin API |

### Architecture

```
cli/
├── package.json
├── tsconfig.json
├── src/
│   ├── main.ts                  # Entry point — arg parser, command dispatch
│   ├── commands/
│   │   ├── install.ts           # Full installer
│   │   ├── uninstall.ts         # Uninstaller
│   │   ├── update.ts            # Pull + recreate
│   │   ├── start.ts             # Start stack
│   │   ├── stop.ts              # Stop stack
│   │   ├── restart.ts           # Restart stack
│   │   ├── logs.ts              # Tail logs
│   │   ├── status.ts            # Container status
│   │   └── extensions.ts        # Extension management
│   ├── lib/
│   │   ├── compose.ts           # Compose command builder & executor
│   │   ├── runtime.ts           # Runtime detection (Docker/Podman/OrbStack)
│   │   ├── env.ts               # .env file read/write/upsert
│   │   ├── paths.ts             # XDG base directory resolution
│   │   ├── assets.ts            # Asset bootstrapping
│   │   ├── detect-providers.ts  # AI provider auto-detection (#53)
│   │   ├── tokens.ts            # Secure token generation
│   │   └── ui.ts                # Terminal output helpers
│   └── types.ts
└── test/
```

### Build & Distribution

The CLI compiles to platform-specific single executables via `bun build --compile`:

```bash
bun build cli/src/main.ts --compile --target=bun-linux-x64 --outfile dist/openpalm-linux-x64
bun build cli/src/main.ts --compile --target=bun-darwin-arm64 --outfile dist/openpalm-darwin-arm64
# etc.
```

Binaries are attached to GitHub Releases. The one-liner install becomes:

```bash
curl -fsSL https://github.com/itlackey/openpalm/releases/latest/download/openpalm-$(uname -s | tr A-Z a-z)-$(uname -m) -o /tmp/openpalm && chmod +x /tmp/openpalm && /tmp/openpalm install
```

During `openpalm install`, the binary copies itself to `~/.local/bin/openpalm` so subsequent commands are just `openpalm <command>`.

### Backwards Compatibility

The existing `install.sh` is kept as a thin wrapper that downloads the compiled binary and runs `openpalm install`, preserving the `curl | bash` flow for users who already have it bookmarked.

### Implementation Steps

1. Scaffold `cli/` workspace, add to root workspaces
2. Implement shared lib modules (runtime, paths, env, compose, tokens, ui)
3. Implement `install` command (port from install.sh)
4. Implement management commands (update, restart, logs, stop, start, status)
5. Implement `uninstall` command (port from uninstall.sh)
6. Port `extensions-cli.ts` into `extensions` command
7. Add build scripts and cross-platform targets
8. Write unit tests
9. Update documentation
