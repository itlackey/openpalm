# system/stack/

This directory contains the managed runtime stack composition. OpenPalm runs
from the fixed managed file set here plus the user-owned overlay at
`$OP_HOME/config/stack/custom.compose.yml`.

## Quick start

```bash
# Run the core stack by hand
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
docker compose \
  --project-name openpalm \
  --env-file "$OP_HOME/knowledge/env/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  up -d

# Enable built-in optional services with profiles
docker compose \
  --project-name openpalm \
  --env-file "$OP_HOME/knowledge/env/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.chat \
  up -d
```

See the [Manual Compose Runbook](../../../../docs/operations/manual-compose-runbook.md) for preflight,
status, logs, and all other operations.

## Common services

The assistant is the only always-on core container. The guardian is enabled by
portal-style addon profiles such as `addon.chat` or `addon.api`.

| Service | Activation | Host port | Purpose |
|---------|------------|-----------|---------|
| `assistant` | Always on | `3800 -> 3000` (chat UI), `3810 -> 4096` (OpenCode) | OpenCode runtime without Docker socket; also hosts the UI and automation scheduler co-processes |
| `guardian` | Portal/addon profiles | `3830 -> 3830` and `3831 -> 3831` (localhost by default) | Principal-authenticated ingress, direct listener, and admin listener |

## Addons

Built-in optional services are defined in `services.compose.yml` and
`portals.compose.yml`, then enabled with `addon.*` Compose profiles.
`custom.compose.yml` is the operator-owned place for extra containers or manual
overlays.

| Addon | Host port | Purpose |
|-------|-----------|---------|
| `api` | `3821 -> 8182` | Guardian-hosted OpenAI/Anthropic-compatible API facade |
| `chat` | `3820 -> 8182` | Guardian-hosted OpenAI-compatible chat edge |
| `discord` | none | Discord bot adapter |
| `ollama` | `11434` | Local LLM inference server |
| `slack` | none | Slack bot adapter |
| `voice` | `${OP_VOICE_PORT_HOST:-8880}:8880` | AI voice (TTS + STT) |

## Networks

| Network | Purpose |
|---------|---------|
| `portal_net` | First-party portal adapter network |
| `assistant_net` | Internal core-service communication |

## Files in this directory

| File | Purpose | Owner |
|------|---------|-------|
| `core.compose.yml` | Core service definition (always used) | System (managed via CLI/admin) |
| `services.compose.yml` | Optional first-party services | System (managed via CLI/admin) |
| `portals.compose.yml` | Optional first-party portals | System (managed via CLI/admin) |
| `$OP_HOME/config/stack/custom.compose.yml` | User custom services and overlays | User |

This directory holds managed compose assembly only — **no secrets, no env files,
and no user-owned overlays**.

## Env files

Compose receives **only one env file**, from outside this directory:
- `$OP_HOME/knowledge/env/stack.env` (akm `env:stack`) — Non-secret runtime configuration only

Secrets live in `knowledge/secrets/` (including OpenCode `auth.json`) and are
granted to services through Compose `secrets:` entries or direct bind mounts. Do
not add other `--env-file` arguments to the compose command.
