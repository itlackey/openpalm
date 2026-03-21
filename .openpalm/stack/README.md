# stack/

Self-contained Docker Compose foundation for running OpenPalm. The core
compose file defines 4 services; addons are layered on with `-f` overlays.

## Quick start

```bash
# Start core services only
cd ~/.openpalm/stack
docker compose -f core.compose.yml \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  up -d

# Or use the wrapper script
./start.sh                      # Core only
./start.sh chat admin           # Core + addons
./start.sh --stop               # Stop everything
./start.sh --status             # Show service status
```

## Core services

| Service | Port | Purpose |
|---------|------|---------|
| `memory` | 3898 | Bun.js memory service with sqlite-vec vector store |
| `assistant` | 3800 | OpenCode AI runtime (no Docker socket) |
| `guardian` | 3899 | Channel ingress — HMAC verification, replay protection, rate limiting |
| `scheduler` | 3897 | Automation engine — runs cron jobs from `config/automations/` |

## Addons

Each addon is a compose overlay in `addons/<name>/compose.yml` with a
companion `.env.schema` documenting its configuration variables.

| Addon | Port | Network | Purpose |
|-------|------|---------|---------|
| `admin` | 3880 | admin_docker_net | Web UI + API (Docker socket proxy) |
| `api` | 3882 | channel_lan | OpenAI/Anthropic-compatible API facade |
| `chat` | 3881 | channel_lan | Browser-based chat widget |
| `discord` | — | channel_lan | Discord bot (gateway-based) |
| `ollama` | 11434 | assistant_net | Local LLM inference server |
| `openviking` | 1933 | assistant_net | Knowledge management engine |
| `slack` | — | channel_lan | Slack bot (socket mode) |
| `voice` | 3810 | channel_lan | Voice interface (STT/LLM/TTS) |

## Networks

| Network | Purpose |
|---------|---------|
| `channel_lan` | LAN-restricted channel traffic (bound to 127.0.0.1) |
| `channel_public` | Publicly accessible channels (opt-in, bound to 0.0.0.0) |
| `assistant_net` | Internal communication between core services |
| `admin_docker_net` | Isolated network for admin + Docker socket proxy |
