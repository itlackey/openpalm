# Setup Guide

Get OpenPalm running on your machine in under five minutes.

---

## Prerequisites

You need **one thing** installed before starting: a container runtime.

| Your computer | What to install | Link |
|---|---|---|
| **Windows** | Docker Desktop | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| **Mac** | Docker Desktop _or_ OrbStack | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) / [orbstack.dev](https://orbstack.dev/download) |
| **Linux** | Docker Engine | Run `curl -fsSL https://get.docker.com \| sh` |

After installing, open the app and wait for it to finish starting (you'll see a green/running indicator).

---

## Install

Copy-paste **one** command into your terminal and the installer does the rest:

**Windows (PowerShell 7+):**
```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

**Mac or Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

### What happens when you run the installer

1. Checks your system for Docker, Docker Compose, curl, and openssl
2. Creates the `~/.openpalm/` directory tree and downloads core assets (compose file, Caddyfile)
3. Generates an admin token (or lets you set your own) and seeds missing default config files
4. Pulls and starts the admin service, then opens the setup wizard in your browser
5. The wizard walks you through connecting your AI provider and choosing channels (see [Setup Walkthrough](setup-walkthrough.md) for a detailed screen-by-screen guide)
6. When you finish the wizard, the full stack starts automatically

No code to clone. You can run fully from the UI if you want, and edit files directly any time. Existing user config files are never overwritten on subsequent runs; only missing defaults are seeded.

### Installer options

Run `scripts/setup.ps1 --help` (Windows) or `scripts/setup.sh --help` (Mac/Linux) for all flags:

| Flag | Effect |
|---|---|
| `--force` | Skip confirmation prompts (useful for scripted updates) |
| `--version TAG` | Download assets from a specific GitHub ref (default: `main`) |
| `--no-start` | Set up files but don't start Docker services |
| `--no-open` | Don't open the admin UI in a browser after install |

Custom path via environment variable:

```bash
OP_HOME=/opt/openpalm bash setup.sh
```

---

## Update

Re-run the same install command to update:

```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

The installer re-downloads core assets and restarts the admin service. Your config, components, and data are preserved -- automatic lifecycle operations never overwrite existing user files (they may seed missing defaults).

To pull the latest container images without re-running setup:

```bash
curl -X POST http://localhost:8100/admin/containers/pull \
  -H "x-admin-token: $ADMIN_TOKEN"
```

Or use `--force` for non-interactive updates:

```bash
setup.sh --force
```

```powershell
.\scripts\setup.ps1 --force
```

---

## After Setup

Once the wizard completes, your stack is running. Here's where everything lives:

### Access the UI

| URL | What |
|---|---|
| `http://localhost/` | Admin dashboard (via Caddy) |
| `http://localhost/opencode/` | OpenCode assistant UI |
| `http://localhost:8100/` | Admin API (direct, no proxy) |
| `http://localhost:8765/docs` | Memory API docs |

All ports are localhost-bound by default. Nothing is publicly exposed unless you explicitly change the access scope.

### Your files

`~/.openpalm/` (`OP_HOME`) is your persistent home directory.
Allowed writers are: direct edits, explicit admin UI/API config actions, and
authenticated assistant API actions on user request. See
[core-principles.md](technical/core-principles.md) for the full filesystem contract.
Key subdirectories:

| Path | Purpose |
|---|---|
| `vault/user.env` | LLM provider API keys |
| `vault/system.env` | Admin token, HMAC secrets, system config |
| `config/components/` | Installed components (channels, services) |
| `config/automations/` | Scheduled automations -- see [Managing OpenPalm](managing-openpalm.md#automations) |
| `config/assistant/` | OpenCode extensions -- tools, plugins, skills, and config |
| `data/` | Service-managed data (memory, caddy, assistant, etc.) |
| `logs/` | Audit and debug logs |

You normally do not need to touch `data/` directly. See [directory-structure.md](technical/directory-structure.md) for the complete layout.

### Path default

| Variable | Default |
|---|---|
| `OP_HOME` | `~/.openpalm` |

---

## Common Tasks

**Change an LLM API key:**
1. Edit `~/.openpalm/vault/user.env`
2. Restart admin: `docker compose restart admin`

Or use the Connections page in the admin UI, or ask the assistant to perform the same authenticated config update through the admin API.

**Add a component (channel/service):**
Install from the registry via the admin UI, or manually add a component directory to `~/.openpalm/config/components/` and restart admin.

**Check container status:**
```bash
curl http://localhost:8100/admin/containers/list \
  -H "x-admin-token: $ADMIN_TOKEN"
```

**View audit logs:**
```bash
tail -f ~/.openpalm/logs/admin-audit.jsonl
```

**Backup:**
```bash
tar czf openpalm-backup.tar.gz ~/.openpalm
```

See [managing-openpalm.md](managing-openpalm.md) for the full operations guide.

---

## Troubleshooting

### Docker not found

The installer requires Docker Engine (Linux) or Docker Desktop (Mac). Verify it's running:

```bash
docker info
```

If you see a permission error on Linux, add your user to the `docker` group:

```bash
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
```

### Admin won't start

Check if the port is already in use:

```bash
lsof -i :8100
```

Check admin container logs:

```bash
docker logs openpalm-admin-1
```

### Setup wizard doesn't open

Navigate manually to `http://localhost:8100/setup`. If the admin isn't healthy yet, wait a moment — it pulls images on first start which can take time on slow connections.

### Containers keep restarting

Check logs for the failing container:

```bash
docker compose logs <service-name>
```

Common causes:
- Missing API key in `vault/user.env` (assistant needs at least one LLM provider key)
- Port conflict with another service on the host
- Insufficient disk space for container data

### Reset to fresh state

To start over completely:

```bash
# Stop everything
docker compose down -v

# Remove all OpenPalm data (DESTRUCTIVE — removes your config, data, and state)
rm -rf ~/.openpalm

# Re-run the installer
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

```powershell
# Stop everything
docker compose down -v

# Remove all OpenPalm data (DESTRUCTIVE — removes your config, data, and state)
Remove-Item -Recurse -Force "$env:USERPROFILE\.openpalm"

# Re-run the installer
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

---

## Next Steps

| Guide | What's inside |
|---|---|
| [Setup Walkthrough](setup-walkthrough.md) | Detailed screen-by-screen walkthrough of the setup wizard |
| [Managing OpenPalm](managing-openpalm.md) | Day-to-day administration: secrets, channels, access control, extensions |
| [How It Works](how-it-works.md) | Architecture overview and data flow |
| [Directory Structure](technical/directory-structure.md) | Host paths, XDG tiers, volume mounts |
| [Community Channels](community-channels.md) | Building custom channel adapters |
| [Core Principles](technical/core-principles.md) | Security invariants and architectural rules |
| [API Spec](technical/api-spec.md) | Admin API endpoint reference |
