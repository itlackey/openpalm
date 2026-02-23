# OpenPalm Host System Reference

OpenPalm uses a deterministic 3-root contract plus one user workdir mount.

## Canonical roots

| Kind | Default | Env override | Purpose |
|---|---|---|---|
| Data | `~/.local/share/openpalm` | `OPENPALM_DATA_HOME` | Persistent service data |
| Config | `~/.config/openpalm` | `OPENPALM_CONFIG_HOME` | User-edited source-of-truth inputs |
| State | `~/.local/state/openpalm` | `OPENPALM_STATE_HOME` | Rendered stack artifacts + runtime state |

## Inputs (human-edited)

Only these files are edited directly:

- `${OPENPALM_CONFIG_HOME}/openpalm.yaml`
- `${OPENPALM_CONFIG_HOME}/secrets.env`

## Generated outputs

Admin renders and maintains generated stack outputs under:

- `${OPENPALM_STATE_HOME}/docker-compose.yml`
- `${OPENPALM_STATE_HOME}/caddy.json`
- `${OPENPALM_STATE_HOME}/*/.env`

## Persistent data

- `${OPENPALM_DATA_HOME}/postgres`
- `${OPENPALM_DATA_HOME}/qdrant`
- `${OPENPALM_DATA_HOME}/openmemory`
- `${OPENPALM_DATA_HOME}/assistant` (OpenCode HOME)

## OpenCode special cases

- OpenCode home mount: `${OPENPALM_DATA_HOME}/assistant -> /home/opencode`
- OpenCode workdir mount: `${HOME}/openpalm -> /work`

## Compose invariant

OpenPalm always applies compose using the state-root compose file:

- `docker compose -f ${OPENPALM_STATE_HOME}/docker-compose.yml up -d`
