# stack/

This directory is the runtime stack. OpenPalm runs from `core.compose.yml`
plus whichever addon compose files you include from `addons/`.

## Quick start

```bash
# Run the core stack by hand
cd ~/.openpalm/stack
docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  --env-file ../vault/stack/guardian.env \
  -f core.compose.yml \
  up -d

# Add addons by adding more -f files
docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  --env-file ../vault/stack/guardian.env \
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
| `memory` | `3898 -> 8765` | Bun memory service with sqlite-vec vector store |
| `assistant` | `3800 -> 4096` | OpenCode runtime without Docker socket |
| `guardian` | none (`8080` internal) | Signed ingress and channel traffic gateway |
| `scheduler` | `3897 -> 8090` | Automation engine for `config/automations/` |

## Addons

Each addon is a compose overlay in `addons/<name>/compose.yml`. Compose file
selection is the deployment model. `config/stack.yaml` is optional tooling
metadata that can help choose addons, but it does not replace these files.

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
| `channel_public` | Public channel traffic when an addon opts in |
| `assistant_net` | Internal core-service communication |
| `admin_docker_net` | Isolated network for admin and docker-socket-proxy |
