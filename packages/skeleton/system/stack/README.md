# config/stack/

This directory contains the runtime stack composition and configuration. OpenPalm runs from the fixed compose file set: `core.compose.yml`, `services.compose.yml`, `portals.compose.yml`, and `custom.compose.yml`.

## Quick start

```bash
# Run the core stack by hand
cd ~/.openpalm/config/stack
docker compose \
  --project-name openpalm \
  --env-file ../../knowledge/env/stack.env \
  -f core.compose.yml \
  -f services.compose.yml \
  -f portals.compose.yml \
  -f custom.compose.yml \
  up -d

# Enable built-in optional services with profiles
docker compose \
  --project-name openpalm \
  --env-file ../../knowledge/env/stack.env \
  -f core.compose.yml \
  -f services.compose.yml \
  -f portals.compose.yml \
  -f custom.compose.yml \
  --profile addon.chat \
  up -d
```

See the [Manual Compose Runbook](../../docs/operations/manual-compose-runbook.md) for preflight,
status, logs, and all other operations.

## Core services

| Service | Host port | Purpose |
|---------|-----------|---------|
| `assistant` | `3800 -> 4096` | OpenCode runtime without Docker socket; also hosts the automation scheduler co-process (no port) |
| `guardian` | `3830 -> 3830` and `3831 -> 3831` (localhost by default) | Principal-authenticated ingress, direct listener, and admin listener |

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
| `channel_lan` | Compatibility bridge for legacy/custom overlays |
| `assistant_net` | Internal core-service communication |

## Files in this directory

| File | Purpose | Owner |
|------|---------|-------|
| `core.compose.yml` | Core service definition (always used) | System (managed via CLI/admin) |
| `services.compose.yml` | Optional first-party services | System (managed via CLI/admin) |
| `portals.compose.yml` | Optional first-party portals | System (managed via CLI/admin) |
| `custom.compose.yml` | User custom services and overlays | User |

This directory holds compose assembly only — **no secrets and no env files**.

## Env files

Compose receives **only one env file**, from outside this directory:
- `../../knowledge/env/stack.env` (akm `env:stack`) — Non-secret runtime configuration only

Secrets live in `knowledge/secrets/` (including OpenCode `auth.json`) and are
granted to services through Compose `secrets:` entries or direct bind mounts. Do
not add other `--env-file` arguments to the compose command.
