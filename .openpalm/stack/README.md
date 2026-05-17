# stack/ (DEPRECATED — moved to config/stack/)

**This directory has been moved to `config/stack/` as part of v0.11.0 restructuring.**

See [`../config/stack/README.md`](../config/stack/README.md) for current documentation.

---

The following documentation is preserved for reference but is OUTDATED:

## Quick start

```bash
# Run the core stack by hand
cd ~/.openpalm/stack
docker compose \
  --project-name openpalm \
  --env-file ../config/stack/stack.env \
  --env-file ../config/stack/guardian.env \
  -f core.compose.yml \
  up -d

# Add addons by adding more -f files
docker compose \
  --project-name openpalm \
  --env-file ../config/stack/stack.env \
  --env-file ../config/stack/guardian.env \
  -f core.compose.yml \
  -f addons/chat/compose.yml \
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
selection is the deployment model. `config/stack/stack.yml` is optional tooling
metadata that can help choose addons, but it does not replace these files.

Repo addon sources live under `.openpalm/registry/addons/`. At runtime,
`stack/addons/` should contain enabled addons only.

| Addon | Host port | Purpose |
|-------|-----------|---------|
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
