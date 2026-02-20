# OpenPalm CLI Documentation

## Overview

OpenPalm is a Bun-compiled command-line tool for managing the OpenPalm platform. The CLI provides commands for installation, service management, updates, and extension handling.

**Package Information:**
- npm package name: `openpalm`
- Version: 0.0.5
- Runtime requirement: Bun >= 1.0.0

## Installation

OpenPalm can be installed using one of four methods:

### 1. Bash (Linux/macOS)

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.sh | bash
```

### 2. PowerShell (Windows)

```powershell
pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/assets/state/scripts/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"
```

### 3. npx (Node.js)

```bash
npx openpalm install
```

### 4. bunx (Bun)

```bash
bunx openpalm install
```

## Commands

### `install`

Install and start OpenPalm with a 4-phase staged installation process.

```bash
openpalm install [options]
```

**Options:**
- `--runtime <docker|podman|orbstack>` - Specify container runtime (auto-detected if not provided)
- `--no-open` - Skip opening browser after installation
- `--ref <branch|tag>` - Install from specific git branch or tag

**Installation Phases:**

1. **Phase 1: Setup**
   - Detect container runtime
   - Download assets
   - Generate `.env` file
   - Create directories
   - Seed configurations
   - Detect AI providers

2. **Phase 2: Core Services**
   - Start core services: Caddy, PostgreSQL, Admin
   - Perform health checks
   - Open browser (unless `--no-open` is specified)

3. **Phase 3: Image Preparation**
   - Pull remaining container images

4. **Phase 4: Full Stack**
   - Bring up complete service stack

### `uninstall`

Stop and remove OpenPalm services and data.

```bash
openpalm uninstall [options]
```

**Options:**
- `--runtime <docker|podman|orbstack>` - Specify container runtime
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

### `extensions`

Manage OpenPalm extensions and plugins.

```bash
openpalm extensions <subcommand> [options]
openpalm ext <subcommand> [options]  # Alias
```

**Subcommands:**

#### `extensions install`

Install an extension by plugin ID.

```bash
openpalm extensions install --plugin <id>
```

#### `extensions uninstall`

Uninstall an extension by plugin ID.

```bash
openpalm extensions uninstall --plugin <id>
```

#### `extensions list`

List all installed extensions.

```bash
openpalm extensions list
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

## Container Runtimes

OpenPalm supports three container runtimes:

- **Docker** - Cross-platform container runtime
- **Podman** - Daemonless container runtime
- **OrbStack** - macOS-only lightweight container runtime

**Auto-detection Order:**
1. OrbStack (macOS only)
2. Docker
3. Podman

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

## Support

For issues, questions, or contributions, please visit the OpenPalm GitHub repository.
