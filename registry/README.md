# registry

Catalog of installable channels and automations. The admin service bundles these at build time and serves them as an in-process catalog.

## Channels (`registry/channels/`)

Each channel consists of a compose overlay (`.yml`) and an optional Caddy route (`.caddy`).

| File | Description |
|---|---|
| `chat.yml` / `chat.caddy` | OpenAI/Anthropic-compatible chat API (`@openpalm/channel-chat`, port 8181) |
| `api.yml` | Full OpenAI + Anthropic API facade (`@openpalm/channel-api`, port 8182) |
| `discord.yml` | Discord interactions + webhook adapter (`@openpalm/channel-discord`, port 8184) |

### Installing a channel

Via admin API:
```bash
curl -X POST http://localhost:8100/admin/channels/install \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "chat"}'
```

Or manually: copy the `.yml` (and optionally `.caddy`) to `~/.config/openpalm/channels/`.

### Adding a new channel

1. Create `registry/channels/<name>.yml` — Docker Compose overlay defining the `channel-<name>` service
2. (Optional) Create `registry/channels/<name>.caddy` — Caddy route (LAN-restricted by default)

The `channel` image (`core/channel/`) runs any npm package that extends `BaseChannel`. Set `CHANNEL_PACKAGE` in the overlay's `environment:` block.

See [`core/assets/README.md`](../core/assets/README.md) and [`docs/community-channels.md`](../docs/community-channels.md) for full details.

## Automations (`registry/automations/`)

Pre-built YAML automations that can be installed to `~/.config/openpalm/automations/` or `~/.local/share/openpalm/automations/`.

| File | Description |
|---|---|
| `health-check.yml` | Checks admin health endpoint every 5 minutes |
| `update-containers.yml` | Pulls and restarts updated container images |
| `prompt-assistant.yml` | Sends a scheduled prompt to the assistant |
| `assistant-daily-briefing.yml` | Sends a daily briefing prompt to the assistant |
| `cleanup-logs.yml` | Cleans up old log files |

Browse and install automations from the **Registry** tab in the admin console, or copy any file directly to `~/.config/openpalm/automations/`.

See [`docs/managing-openpalm.md`](../docs/managing-openpalm.md) for automation configuration details.
