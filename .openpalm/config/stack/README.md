# config/stack/

This directory contains the runtime stack composition and configuration. OpenPalm runs from `core.compose.yml`
plus whichever addon compose files you include from `addons/`.

## Quick start

```bash
# Run the core stack by hand
cd ~/.openpalm/config/stack
docker compose \
  --project-name openpalm \
  --env-file ../stack.env \
  --env-file ../../vault/user/user.env \
  --env-file guardian.env \
  -f core.compose.yml \
  up -d

# Add addons by adding more -f files
docker compose \
  --project-name openpalm \
  --env-file ../stack.env \
  --env-file ../../vault/user/user.env \
  --env-file guardian.env \
  -f core.compose.yml \
  -f addons/chat/compose.yml \
  -f addons/admin/compose.yml \
  up -d

```

See the [Manual Compose Runbook](../../docs/operations/manual-compose-runbook.md) for preflight,
status, logs, and all other operations.

## Core services

| Service | Host port | Purpose |
|---------|-----------|---------|
| `assistant` | `3800 -> 4096` | OpenCode runtime without Docker socket; also hosts the automation scheduler co-process (no port) |
| `guardian` | none (`8080` internal) | Signed ingress and channel traffic gateway |

## Addons

Each addon is a compose overlay in `addons/<name>/compose.yml`. Compose file
selection is the deployment model. `../stack.yml` is optional tooling
metadata that can help choose addons, but it does not replace these files.

Repo addon sources live under `.openpalm/registry/addons/`. At runtime,
`addons/` should contain enabled addons only.

| Addon | Host port | Purpose |
|-------|-----------|---------|
| `admin` | `3880 -> 8100` | Admin UI/API |
| `api` | `3821 -> 8182` | OpenAI/Anthropic-compatible API facade |
| `chat` | `3820 -> 8181` | OpenAI-compatible chat edge |
| `discord` | none | Discord bot adapter |
| `ollama` | `11434` | Local LLM inference server |
| `openviking` | none | Knowledge management engine |
| `slack` | none | Slack bot adapter |
| `voice` | `3810 -> 8186` | Voice channel |

## Networks

| Network | Purpose |
|---------|---------|
| `channel_lan` | Internal/LAN-facing channel traffic |
| `assistant_net` | Internal core-service communication |

## Files in this directory

| File | Purpose | Owner |
|------|---------|-------|
| `stack.yml` | Capabilities only (metadata) | User, explicit admin actions |
| `stack.env` | System-managed environment variables (API keys, etc.) | CLI/admin (automated) |
| `guardian.env` | Channel HMAC secrets (hot-loaded at runtime) | CLI/admin (automated) |
| `core.compose.yml` | Core service definition (always used) | System (managed via CLI/admin) |
| `addons/` | Enabled addon compose overlays | CLI/admin (via install/enable operations) |
