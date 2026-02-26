# OpenPalm CLI Documentation

## Overview

OpenPalm is a Bun-compiled command-line tool for managing the OpenPalm platform. The CLI provides commands for installation, service management, updates, and stack rendering/apply.

All installer logic is centralized in the CLI binary. The shell scripts (`install.sh` and `install.ps1`) are thin wrappers that download the pre-compiled CLI and delegate to `openpalm install`.

**Package Information:**
- npm package name: `openpalm`
- Version: 0.3.4
- Runtime requirement: Bun >= 1.2.0

## Installation

OpenPalm can be installed using one of four methods:

### 1. Bash (Linux/macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/install.sh | bash
```

This downloads the `openpalm` CLI binary to `~/.local/bin/` and runs `openpalm install`.

### 2. PowerShell (Windows)

```powershell
pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"
```

This downloads the `openpalm` CLI binary to `%LOCALAPPDATA%\OpenPalm\` (automatically added to PATH) and runs `openpalm install`.

## Commands

### `install`

Install and start the OpenPalm stack.

```bash
openpalm install [options]
```

**Options:**
- `--runtime <docker|podman>` - Specify container runtime (auto-detected if not provided)
- `--port <number>` - Use an alternative ingress port (default: 80). Useful when port 80 is already in use
- `--no-open` - Skip opening browser after installation
- `--ref <branch|tag>` - Git ref for asset download
- `--force` - Overwrite existing installation

**Wrapper scripts** (`install.sh` and `install.ps1`) also accept `--port` / `-Port` and forward it to the CLI:
```bash
# Bash
curl -fsSL .../install.sh | bash -s -- --port 8080

# PowerShell
& .\install.ps1 -Port 8080
```

**Pre-flight Checks:**

Before starting, the installer automatically checks for issues using typed preflight codes. Each check returns a stable code and severity (`fatal` or `warning`) so the installer can make deterministic decisions without parsing message text:

| Check | Code | Severity | Behavior |
|---|---|---|---|
| Disk space < 3 GB | `disk_low` | `warning` | Prints warning, continues |
| Port already in use | `port_conflict` | `fatal` | Aborts (suggests `--port`) |
| Daemon not running | `daemon_unavailable` | `fatal` | Aborts with start guidance |
| Daemon check failed | `daemon_check_failed` | `fatal` | Aborts with report link |

**Installation Steps:**

1. Run pre-flight checks
2. Detect container runtime (with actionable guidance if missing)
3. Generate `.env` file with secure tokens
4. Display admin token prominently
5. Create XDG directory tree
6. Seed configuration files (embedded templates -- no network download)
7. Render full stack artifacts (compose, caddy, env)
8. Pull container images
9. Start all services
10. Wait for admin health check
11. Print next steps and operational commands

### `uninstall`

Stop and remove OpenPalm services and data.

```bash
openpalm uninstall [options]
```

**Options:**
- `--runtime <docker|podman>` - Specify container runtime
- `--remove-all` - Remove all data and configurations
- `--remove-images` - Remove downloaded container images
- `--yes` - Skip confirmation prompts

### `update`

Pull latest container images and recreate containers with new versions.

```bash
openpalm update
```

### `start`

Start OpenPalm services. Optionally specify individual services to start.

```bash
openpalm start [service...]
```

**Examples:**
```bash
openpalm start              # Start all services
openpalm start caddy        # Start only Caddy service
openpalm start admin api    # Start Admin and API services
```

### `stop`

Stop OpenPalm services. Optionally specify individual services to stop.

```bash
openpalm stop [service...]
```

**Examples:**
```bash
openpalm stop               # Stop all services
openpalm stop postgres      # Stop only PostgreSQL service
openpalm stop admin api     # Stop Admin and API services
```

### `restart`

Restart OpenPalm services. Optionally specify individual services to restart.

```bash
openpalm restart [service...]
```

**Examples:**
```bash
openpalm restart            # Restart all services
openpalm restart admin # Restart only Admin service
```

### `logs`

View container logs with real-time following (tail 50 lines).

```bash
openpalm logs [service...]
```

**Examples:**
```bash
openpalm logs               # View logs from all services
openpalm logs admin         # View logs from Admin service
openpalm logs caddy api     # View logs from Caddy and API services
```

### `status`

Show the status of all OpenPalm containers.

```bash
openpalm status
openpalm ps                 # Alias
```

### `service`

Domain-based service lifecycle command. Uses local compose execution by default, and switches to admin API mode when admin URL/token env vars are configured.

```bash
openpalm service <up|stop|restart|logs|update|status> [service...]
```

**Examples:**
```bash
openpalm service restart assistant
openpalm service logs gateway --tail 200
openpalm service status
```

### `channel`

Domain-based channel management command.

```bash
openpalm channel configure <channel-name> [options]
```

**Examples:**
```bash
openpalm channel configure chat --exposure lan
```

### `render`

Render stack artifacts (compose, caddy, env files) from the current stack spec without applying them. Useful for previewing what `apply` will write.

```bash
openpalm render
```

### `apply`

Render and apply stack artifacts, then reconcile running services. This is the primary command for updating a running stack after configuration changes.

```bash
openpalm apply
```

### `version`

Print the OpenPalm CLI version.

```bash
openpalm version
openpalm --version
openpalm -v
```

### `help`

Show help information.

```bash
openpalm help
openpalm --help
openpalm -h
```

## Global Flags

The following flags are available for all commands:

- `--version`, `-v` - Print version information
- `--help`, `-h` - Show help information

## Configuration

OpenPalm uses XDG Base Directory specification for storing data and configuration:

- **Data Directory:** `~/.local/share/openpalm/` (or `$OPENPALM_DATA_HOME`)
- **Config Directory:** `~/.config/openpalm/` (or `$OPENPALM_CONFIG_HOME`)
- **State Directory:** `~/.local/state/openpalm/` (or `$OPENPALM_STATE_HOME`)

These directories can be customized by setting the corresponding environment variables.

## Admin API mode variables

- `OPENPALM_ADMIN_API_URL` (preferred), `ADMIN_APP_URL`, `GATEWAY_URL`
- `OPENPALM_ADMIN_TOKEN` (preferred), `ADMIN_TOKEN`
- `OPENPALM_ADMIN_TIMEOUT_MS` (default: `15000`)
- `OPENPALM_ALLOW_INSECURE_ADMIN_HTTP=1` (only when explicitly needed)

CLI also reads `${OPENPALM_STATE_HOME}/assistant/.env` as a fallback for admin URL/token values.

## Container Runtimes

OpenPalm supports two container runtimes:

- **Docker** - Cross-platform container runtime
- **Podman** - Daemonless container runtime

**Auto-detection Order:**
1. Docker
2. Podman

The runtime can be explicitly specified using the `--runtime` flag on commands that support it.

## Building from Source

OpenPalm can be built from source using Bun:

### Basic Build

```bash
bun build packages/cli/src/main.ts --compile --outfile dist/openpalm
```

### Cross-Platform Builds

Build for specific platforms using the `--target` flag:

**Linux x64:**
```bash
bun build packages/cli/src/main.ts --compile --target=bun-linux-x64 --outfile dist/openpalm-linux-x64
```

**Linux ARM64:**
```bash
bun build packages/cli/src/main.ts --compile --target=bun-linux-arm64 --outfile dist/openpalm-linux-arm64
```

**macOS x64 (Intel):**
```bash
bun build packages/cli/src/main.ts --compile --target=bun-darwin-x64 --outfile dist/openpalm-darwin-x64
```

**macOS ARM64 (Apple Silicon):**
```bash
bun build packages/cli/src/main.ts --compile --target=bun-darwin-arm64 --outfile dist/openpalm-darwin-arm64
```

**Windows x64:**
```bash
bun build packages/cli/src/main.ts --compile --target=bun-windows-x64 --outfile dist/openpalm-windows-x64.exe
```

**Windows ARM64:**
```bash
bun build packages/cli/src/main.ts --compile --target=bun-windows-arm64 --outfile dist/openpalm-windows-arm64.exe
```

## Support

For issues, questions, or contributions, please visit the OpenPalm GitHub repository.
