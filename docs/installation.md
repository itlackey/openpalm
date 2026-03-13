# Installation

Install OpenPalm using the one-liner installer for your platform. The script downloads a standalone Bun-compiled binary — no Bun, Node.js, or other runtime needs to be present on the host.

---

## Prerequisites

Docker Engine (Linux) or Docker Desktop (macOS / Windows) must be installed and running before you start. See [system-requirements.md](system-requirements.md) for minimum versions and hardware specs.

---

## One-liner Install

### Linux and macOS

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

The script detects your platform and architecture, downloads the correct `openpalm` binary from the GitHub release, places it in `~/.local/bin/openpalm`, and runs `openpalm install`.

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

The script downloads the matching Windows CLI binary from the GitHub release and places it in `%LOCALAPPDATA%\openpalm\bin\openpalm.exe`, then runs `openpalm install`.

---

## Environment Variables

These variables are read by the setup scripts before downloading the binary.

| Variable | Default | Description |
|---|---|---|
| `OPENPALM_VERSION` | latest release | Pin a specific release tag, e.g. `v0.9.0-rc11`. |
| `OPENPALM_INSTALL_DIR` | `~/.local/bin` (Linux/macOS) or `%LOCALAPPDATA%\openpalm\bin` (Windows) | Directory where the `openpalm` binary is placed. Must be on `PATH` for the CLI to work without a full path. |

Example — pin a specific version:

```bash
OPENPALM_VERSION=v0.9.0-rc11 curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

Example — custom install location:

```bash
OPENPALM_INSTALL_DIR=/usr/local/bin curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

---

## What Happens During Install

`openpalm install` performs the following steps in order:

1. Creates the XDG directory tree (`CONFIG_HOME`, `DATA_HOME`, `STATE_HOME`).
2. Probes the host environment and writes `DATA_HOME/host.json` (see below).
3. Downloads core assets (compose file, Caddyfile, schema files) to `STATE_HOME/artifacts/`.
4. Seeds missing default config files in `CONFIG_HOME` (never overwrites existing user files).
5. Generates an admin token and writes it to `CONFIG_HOME/secrets.env` if one is not already set.
6. Validates `CONFIG_HOME/secrets.env` against the schema (non-fatal on first install).
7. Pulls and starts the admin service, then opens the setup wizard in your browser.

The setup wizard walks you through connecting an AI provider and enabling channels. When you finish, the full stack starts automatically.

---

## host.json

During install, `detectHostInfo()` probes the local environment and writes a JSON file to `DATA_HOME/host.json`. This file is read by the admin setup wizard to determine which model runner options to present.

| Field | Description |
|---|---|
| `platform` | Operating system (e.g. `linux`, `darwin`, `win32`) |
| `arch` | CPU architecture (e.g. `x64`, `arm64`) |
| `docker.available` | Whether the `docker` binary was found on `PATH` |
| `docker.running` | Whether `docker info` succeeded (daemon is reachable) |
| `ollama.running` | Whether Ollama is listening at `http://localhost:11434` |
| `lmstudio.running` | Whether LM Studio is listening at `http://localhost:1234` |
| `llamacpp.running` | Whether llama.cpp is listening at `http://localhost:8080` |
| `timestamp` | ISO 8601 timestamp of when detection ran |

The file is overwritten on every install and update — it reflects the current state of the host at install time.

---

## Validating Configuration

The `openpalm validate` command checks `CONFIG_HOME/secrets.env` against the schema at `assets/secrets.env.schema`. It downloads the `varlock` binary on first use and caches it in `STATE_HOME/bin/`.

```bash
openpalm validate
```

Output is human-readable. The command exits `0` when all required variables are present and valid, and exits non-zero when there are validation errors. Warnings are printed but do not affect the exit code.

---

## CLI Command Reference

| Command | Description |
|---|---|
| `openpalm install` | Full install or update: creates directories, downloads assets, starts the stack |
| `openpalm validate` | Validates `CONFIG_HOME/secrets.env` against the schema |
| `openpalm start` | Start all stack services |
| `openpalm stop` | Stop all stack services |
| `openpalm restart` | Restart all stack services |
| `openpalm logs [service]` | Stream container logs (all services, or a specific one) |
| `openpalm status` | Show running container status |
| `openpalm update` | Pull latest images and restart services |
| `openpalm uninstall` | Stop services and remove OpenPalm data directories |
| `openpalm service` | Manage individual services (start, stop, restart a single container) |

Run `openpalm --help` or `openpalm <command> --help` for flags and options.

---

## XDG Path Defaults

| Variable | Default (Linux/macOS) | Purpose |
|---|---|---|
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` | User-owned persistent config (secrets, channels, assistant config) |
| `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` | Service data (memory DB, Caddy certs, `host.json`) |
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` | Generated runtime artifacts (compose files, Caddyfile, audit logs) |

On Windows the defaults follow `%APPDATA%` / `%LOCALAPPDATA%` conventions.

Automatic lifecycle operations (install, update, setup reruns) are non-destructive for existing files in `CONFIG_HOME` — they only seed missing defaults.

---

## Next Steps

| Guide | Description |
|---|---|
| [setup-walkthrough.md](setup-walkthrough.md) | Screen-by-screen walkthrough of the setup wizard |
| [system-requirements.md](system-requirements.md) | CPU, RAM, disk, and network requirements |
| [managing-openpalm.md](managing-openpalm.md) | Day-to-day administration: secrets, channels, access control |
| [troubleshooting.md](troubleshooting.md) | Common problems and solutions |
