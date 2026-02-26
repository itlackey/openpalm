# OpenPalm CLI Documentation

## Overview

OpenPalm is a Bun-compiled command-line tool for managing the OpenPalm platform. The CLI provides commands for installation, service management, and updates.

All installer logic is centralized in the CLI binary. The shell scripts (`install.sh` and `install.ps1`) are thin wrappers that download the pre-compiled CLI and delegate to `openpalm install`.

**Package Information:**
- npm package name: `openpalm`
- Runtime requirement: Bun >= 1.2.0

## Installation

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
- `--port <number>` - Use an alternative ingress port (default: 80). Useful when port 80 is already in use
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
2. Detect Docker
3. Generate `.env` file with secure tokens
4. Display admin token prominently
5. Create XDG directory tree
6. Seed configuration files (embedded templates -- no network download)
7. Copy embedded full-stack compose to state directory
8. Write Caddy JSON config with routing
9. Pull container images
10. Start all services
11. Health check admin and gateway
12. Print next steps and operational commands

### `uninstall`

Stop and remove OpenPalm services and data.

```bash
openpalm uninstall [options]
```

**Options:**
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

### `stop`

Stop OpenPalm services. Optionally specify individual services to stop.

```bash
openpalm stop [service...]
```

### `restart`

Restart OpenPalm services. Optionally specify individual services to restart.

```bash
openpalm restart [service...]
```

### `logs`

View container logs with real-time following (tail 50 lines).

```bash
openpalm logs [service...]
```

### `status`

Show the status of all OpenPalm containers.

```bash
openpalm status
openpalm ps                 # Alias
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

## Configuration

OpenPalm uses XDG Base Directory specification for storing data and configuration:

- **Data Directory:** `~/.local/share/openpalm/` (or `$OPENPALM_DATA_HOME`)
- **Config Directory:** `~/.config/openpalm/` (or `$OPENPALM_CONFIG_HOME`)
- **State Directory:** `~/.local/state/openpalm/` (or `$OPENPALM_STATE_HOME`)

These directories can be customized by setting the corresponding environment variables.

## Container Runtime

OpenPalm uses **Docker** as its container runtime. Docker must be installed and running before installation.

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
