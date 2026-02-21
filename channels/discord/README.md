# Discord Channel

The `channel-discord` adapter connects a Discord bot to the OpenPalm assistant. It handles Discord webhook payloads and interactions, signs messages with HMAC, and forwards them through the Gateway.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health status |
| `POST /discord/webhook` | Simple webhook from Discord |
| `POST /discord/interactions` | Discord interactions (slash commands, type 1/2) — not routed through Caddy by default |

### POST /discord/webhook

```json
{ "userId": "...", "text": "...", "channelId": "...", "guildId": "..." }
```

## Caddy ingress

- Route: `/channels/discord*` → rewrites to `/discord/webhook`
- Access: LAN by default (togglable to public via Admin API)

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8184` | Port the server listens on |
| `GATEWAY_URL` | `http://gateway:8080` | Gateway URL |
| `CHANNEL_DISCORD_SECRET` | (required) | HMAC shared secret for signing payloads |
| `DISCORD_BOT_TOKEN` | (required) | Discord bot token |

## Setup

1. Create a Discord application at [discord.com/developers/applications](https://discord.com/developers/applications).
2. Create a bot, copy the **Bot Token**, and save it as `DISCORD_BOT_TOKEN` in secrets.
3. Invite the bot to your server with the required permissions (Send Messages, Read Message History).
4. Configure the Interactions Endpoint URL in the Discord developer portal to point to `/channels/discord` (your public URL, if applicable).

Manage credentials via `POST /admin/channels/config` with `service: "channel-discord"`.

## Related

- [API Reference](../../dev/docs/api-reference.md#discord-channel-discord-8184) — Full endpoint and payload details
- [Gateway README](../../gateway/README.md) — How signed payloads are processed
