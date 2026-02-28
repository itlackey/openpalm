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

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

**Mac or Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

### What happens when you run the installer

1. Checks your system for Docker, Docker Compose, curl, and openssl
2. Creates the XDG directory tree and downloads core assets (compose file, Caddyfile)
3. Generates an admin token (or lets you set your own) and seeds `secrets.env`
4. Pulls and starts the admin service, then opens the setup wizard in your browser
5. The wizard walks you through connecting your AI provider and choosing channels
6. When you finish the wizard, the full stack starts automatically

No config files to edit. No code to clone. Your secrets are never overwritten on subsequent runs.

### Installer options

Run `scripts/setup.ps1 --help` (Windows) or `scripts/setup.sh --help` (Mac/Linux) for all flags:

| Flag | Effect |
|---|---|
| `--force` | Skip confirmation prompts (useful for scripted updates) |
| `--version TAG` | Download assets from a specific GitHub ref (default: `main`) |
| `--no-start` | Set up files but don't start Docker services |
| `--no-open` | Don't open the admin UI in a browser after install |

Custom paths via environment variables:

```bash
OPENPALM_CONFIG_HOME=/opt/openpalm/config \
OPENPALM_DATA_HOME=/opt/openpalm/data \
OPENPALM_STATE_HOME=/opt/openpalm/state \
  bash setup.sh
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

The installer re-downloads core assets and restarts the admin service. Your secrets, channels, and data are preserved — `CONFIG_HOME/secrets.env` is never overwritten.

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
| `http://localhost/openmemory/` | OpenMemory dashboard |
| `http://localhost:8100/` | Admin API (direct, no proxy) |

All ports are localhost-bound by default. Nothing is publicly exposed unless you explicitly change the access scope.

### Your files

All user-editable files live under `CONFIG_HOME` (default `~/.config/openpalm`):

| Path | Purpose |
|---|---|
| `secrets.env` | Admin token and LLM provider API keys |
| `channels/` | Channel compose overlays (`.yml`) and Caddy routes (`.caddy`) |
| `opencode/` | OpenCode extensions — tools, plugins, skills, and config |

You never need to touch the other two directories (`DATA_HOME` for service data, `STATE_HOME` for assembled runtime). See [directory-structure.md](directory-structure.md) for the complete layout.

### XDG path defaults

| Variable | Default |
|---|---|
| `OPENPALM_CONFIG_HOME` | `~/.config/openpalm` |
| `OPENPALM_DATA_HOME` | `~/.local/share/openpalm` |
| `OPENPALM_STATE_HOME` | `~/.local/state/openpalm` |
| `OPENPALM_WORK_DIR` | `~/openpalm` |

---

## Common Tasks

**Change an LLM API key:**
1. Edit `~/.config/openpalm/secrets.env`
2. Restart admin: `docker compose restart admin`

Or use the Connections page in the admin UI — no file editing required.

**Add a channel:**
Install from the registry via the admin UI, or manually drop a `.yml` (and optional `.caddy`) into `~/.config/openpalm/channels/` and restart admin.

**Check container status:**
```bash
curl http://localhost:8100/admin/containers/list \
  -H "x-admin-token: $ADMIN_TOKEN"
```

**View audit logs:**
```bash
tail -f ~/.local/state/openpalm/audit/admin-audit.jsonl
```

**Backup:**
```bash
tar czf openpalm-backup.tar.gz \
  ~/.config/openpalm \
  ~/.local/share/openpalm
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
- Missing API key in `secrets.env` (assistant needs at least one LLM provider key)
- Port conflict with another service on the host
- Insufficient disk space for container data

### Reset to fresh state

To start over completely:

```bash
# Stop everything
docker compose down -v

# Remove all OpenPalm data (DESTRUCTIVE — removes your config, data, and state)
rm -rf ~/.config/openpalm ~/.local/share/openpalm ~/.local/state/openpalm

# Re-run the installer
curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash
```

```powershell
# Stop everything
docker compose down -v

# Remove all OpenPalm data (DESTRUCTIVE — removes your config, data, and state)
Remove-Item -Recurse -Force "$env:USERPROFILE\\.config\\openpalm", "$env:USERPROFILE\\.local\\share\\openpalm", "$env:USERPROFILE\\.local\\state\\openpalm"

# Re-run the installer
irm https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.ps1 | iex
```

---

## Next Steps

| Guide | What's inside |
|---|---|
| [Managing OpenPalm](managing-openpalm.md) | Day-to-day administration: secrets, channels, access control, extensions |
| [How It Works](how-it-works.md) | Architecture overview and data flow |
| [Directory Structure](directory-structure.md) | Host paths, XDG tiers, volume mounts |
| [Community Channels](community-channels.md) | Building custom channel adapters |
| [Core Principles](core-principles.md) | Security invariants and architectural rules |
| [API Spec](api-spec.md) | Admin API endpoint reference |
