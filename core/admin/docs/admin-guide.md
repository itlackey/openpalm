# Admin Guide

OpenPalm installs in minutes from a single command and is managed entirely through the Admin UI or CLI.

## Installation

Pick whichever method suits your system:

**Bash** (Linux / macOS):
```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/install.sh | bash
```

**PowerShell** (Windows):
```powershell
pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"
```

**npx** / **bunx**:
```bash
npx openpalm install
# or
bunx openpalm install
```

The installer detects your container runtime (Docker, Podman, or OrbStack), generates secure credentials, starts all services, and opens a setup wizard. No config files to edit. See the [CLI documentation](../../docs/cli.md) for all commands.

For implementation details of the installer flow and directory layout, see the [Admin Service README](../README.md).

## Admin console

Access the admin dashboard at `http://localhost`. Log in with the admin password from your `.env` file.

| Page | What it does |
|---|---|
| System status | Service health indicators |
| Config editor | Schema-aware YAML editor |
| Service control | Start / stop / restart containers |
| Plugin management | Install and uninstall npm plugins |
| Secrets | Manage API keys and credentials |
| Automations | Schedule recurring prompts |

### Managing plugins

The admin UI manages OpenCode plugins (the `plugin[]` list in `opencode.json`). Enter an npm package ID and click Install. Skills, agents, commands, and tools are managed manually in the OpenCode config directory.

### Managing secrets

Secrets are key/value credentials stored in `secrets.env`. Channel config values reference secrets via `${SECRET_NAME}`. Stack render/apply fails if a referenced secret key is missing.

### Managing automations

Create scheduled prompts with a name, prompt text, and cron expression. Use **Enable/Disable** to toggle without deleting, **Run Now** to trigger immediately, and **Edit** or **Delete** to manage existing automations.

## Authentication

- Admin password is generated at install time and stored in `.env`
- All admin write operations require the `x-admin-token` header
- The admin panel is LAN-only by default
- The setup wizard offers a `host` scope option for localhost-only access

## Channel security

Channels send HMAC-signed payloads through the Gateway. The Gateway verifies signatures, rate-limits requests, and validates input via the `channel-intake` agent before any message reaches the assistant. See the [Gateway README](../../../core/gateway/README.md) and [Security Guide](../../../docs/security.md) for details.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/uninstall.sh | bash
```

```powershell
pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/uninstall.ps1 -OutFile $env:TEMP/openpalm-uninstall.ps1; & $env:TEMP/openpalm-uninstall.ps1"
```

Use `--remove-all` to delete all config/state/data directories and `--remove-images` to remove container images.
