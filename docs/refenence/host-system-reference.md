# OpenPalm Host System Reference

This document describes host directories, how they are created, and how they map into containers.

## XDG layout and overrides

OpenPalm uses XDG-style roots with this precedence:

`OPENPALM_*_HOME` → `XDG_*_HOME/openpalm` → defaults.

| Kind | Default | Env override | Purpose |
|---|---|---|---|
| Data | `~/.local/share/openpalm` | `OPENPALM_DATA_HOME` | Persistent service data + OpenCode user home |
| Config | `~/.config/openpalm` | `OPENPALM_CONFIG_HOME` | User-editable config/env files |
| State | `~/.local/state/openpalm` | `OPENPALM_STATE_HOME` | Runtime compose/workspace/state |

## Directory trees created by installers

### Data (`$OPENPALM_DATA_HOME`)

- `postgres/`
- `qdrant/`
- `openmemory/`
- `shared/`
- `caddy/`
- `admin/`
- `home/` (mounted as OpenCode HOME)

### Config (`$OPENPALM_CONFIG_HOME`)

- `caddy/`
- `channels/`
- `cron/`
- `secrets/`
- `secrets/gateway/`
- `secrets/channels/`
- plus root files like `secrets.env`, `user.env`

### State (`$OPENPALM_STATE_HOME`)

- `opencode-core/`
- `gateway/`
- `caddy/`
- `workspace/`
- `observability/`
- `backups/`
- root files like `docker-compose.yml`, `.env`, uninstall script

## Volume mount normalization

### OpenCode + Admin

| Host path | Container | Mount |
|---|---|---|
| `${OPENPALM_DATA_HOME}/home` | `opencode-core` | `/home/opencode` |
| `${OPENPALM_DATA_HOME}/home` | `admin` | `/app/home` |
| `${OPENPALM_CONFIG_HOME}/cron` | `opencode-core` | `/cron` |
| `${OPENPALM_STATE_HOME}/workspace` | `opencode-core` | `/work` |
| `${OPENPALM_STATE_HOME}/opencode-core` | `opencode-core` | `/state` |

### Other core services

| Host path | Container | Mount |
|---|---|---|
| `${OPENPALM_DATA_HOME}/postgres` | `postgres` | `/var/lib/postgresql/data` |
| `${OPENPALM_DATA_HOME}/qdrant` | `qdrant` | `/qdrant/storage` |
| `${OPENPALM_DATA_HOME}/openmemory` | `openmemory` | `/data` |
| `${OPENPALM_DATA_HOME}/shared` | `openmemory`, `opencode-core`, `admin` | `/shared` |
| `${OPENPALM_DATA_HOME}/caddy` | `caddy` | `/data` |
| `${OPENPALM_STATE_HOME}/caddy` | `caddy` | `/config` |

## OpenCode config model

- Core extensions are image-baked under `/opt/opencode`.
- `OPENCODE_CONFIG_DIR=/opt/opencode` loads immutable OpenPalm-managed core extensions.
- User-global OpenCode state persists in mounted HOME:
  - `/home/opencode/.config/opencode/opencode.json`
  - `/home/opencode/.config/opencode/plugins/`
  - `/home/opencode/.cache/opencode/`
  - `/home/opencode/.local/share/opencode/`

So the host location for user-global OpenCode state is:

`${OPENPALM_DATA_HOME}/home/`

## Installer behavior

Installers seed config templates without overwriting existing files:

- Caddyfile
- channel env files
- secrets env templates
- user env template

They do **not** create or manage a legacy `config/opencode-core` override directory.
