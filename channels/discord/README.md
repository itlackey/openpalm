# Discord Channel

The `channel-discord` adapter connects a Discord bot to the OpenPalm assistant. It handles Discord interactions (slash commands, buttons, autocomplete) and a REST webhook endpoint, with support for guild/role/user permissions, custom commands, deferred responses, and structured logging.

## Architecture

This channel uses Discord's **Interactions Endpoint** model (HTTP webhooks), not the Gateway WebSocket. This keeps the service lightweight, stateless, and consistent with the project's containerized microservice architecture.

- **Slash commands** are the primary interface (`/ask`, `/health`, `/help`, `/clear`, plus custom commands)
- **Deferred responses** handle assistant queries that exceed Discord's 3-second deadline
- **Permission constraints** control which servers, roles, and users can interact with the bot
- **Custom commands** map to configurable prompt templates sent to the assistant

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health status with command and permission info |
| `POST /discord/interactions` | Discord Interactions Endpoint (slash commands, buttons, autocomplete) |
| `POST /discord/webhook` | REST webhook for external integrations |

### POST /discord/webhook

```json
{ "userId": "...", "text": "...", "channelId": "...", "guildId": "..." }
```

## Built-in Slash Commands

| Command | Description |
|---|---|
| `/ask <message>` | Send a message to the assistant |
| `/health` | Check the assistant's health status |
| `/help` | Show available commands and usage info |
| `/clear` | Start a fresh conversation (clears session context) |

## Custom Commands

Define additional slash commands via the `DISCORD_CUSTOM_COMMANDS` environment variable. Each command maps to a prompt template sent to the assistant.

```json
[
  {
    "name": "summarize",
    "description": "Summarize a topic",
    "options": [
      { "name": "topic", "description": "The topic to summarize", "type": 3, "required": true }
    ],
    "promptTemplate": "Please summarize the following topic: {{topic}}"
  },
  {
    "name": "translate",
    "description": "Translate text to another language",
    "options": [
      { "name": "text", "description": "Text to translate", "type": 3, "required": true },
      { "name": "language", "description": "Target language", "type": 3, "required": true }
    ],
    "promptTemplate": "Translate the following to {{language}}: {{text}}",
    "ephemeral": true
  }
]
```

Option type values follow the Discord API: `3` = String, `4` = Integer, `5` = Boolean. See [Discord docs](https://discord.com/developers/docs/interactions/application-commands#application-command-object-application-command-option-type) for all types.

## Permissions

Control who can use the bot with environment variables. When an allowlist is empty, that dimension is unrestricted. Blocklists always take priority.

| Variable | Description |
|---|---|
| `DISCORD_ALLOWED_GUILDS` | Comma-separated guild (server) IDs. Only these servers can use the bot. |
| `DISCORD_ALLOWED_ROLES` | Comma-separated role IDs. Users must have at least one of these roles. |
| `DISCORD_ALLOWED_USERS` | Comma-separated user IDs. Only these users can use the bot. |
| `DISCORD_BLOCKED_USERS` | Comma-separated user IDs. These users are always blocked (overrides allowlists). |

**Evaluation order:** blocked users → user allowlist → guild allowlist → role allowlist.

Example:
```env
DISCORD_ALLOWED_GUILDS=123456789,987654321
DISCORD_ALLOWED_ROLES=111111111
DISCORD_BLOCKED_USERS=999999999
```

## Caddy ingress

- Route: `/channels/discord*` → rewrites to `/discord/webhook`
- Access: LAN by default (togglable to public via Admin API)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8184` | Port the server listens on |
| `GUARDIAN_URL` | `http://guardian:8080` | Guardian URL |
| `CHANNEL_DISCORD_SECRET` | (required) | HMAC shared secret for signing payloads |
| `DISCORD_BOT_TOKEN` | (required) | Discord bot token |
| `DISCORD_PUBLIC_KEY` | (required) | Discord application public key (for signature verification) |
| `DISCORD_APPLICATION_ID` | (recommended) | Discord application ID (enables slash command registration) |
| `DISCORD_ALLOWED_GUILDS` | (empty) | Comma-separated guild IDs to accept interactions from |
| `DISCORD_ALLOWED_ROLES` | (empty) | Comma-separated role IDs required to use the bot |
| `DISCORD_ALLOWED_USERS` | (empty) | Comma-separated user IDs allowed to use the bot |
| `DISCORD_BLOCKED_USERS` | (empty) | Comma-separated user IDs blocked from the bot |
| `DISCORD_CUSTOM_COMMANDS` | (empty) | JSON array of custom slash command definitions |
| `DISCORD_REGISTER_COMMANDS` | `true` | Set to `false` to skip slash command registration on startup |
| `DISCORD_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## Setup

1. Create a Discord application at [discord.com/developers/applications](https://discord.com/developers/applications).
2. Copy the **Application ID** and **Public Key** from the General Information page.
3. Create a bot under the Bot section, copy the **Bot Token**.
4. Save these values as `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`.
5. Invite the bot to your server with the `applications.commands` and `bot` scopes, plus Send Messages permission.
6. Set the Interactions Endpoint URL in the Discord developer portal to your public URL + `/discord/interactions`.
7. The bot will automatically register slash commands on startup.

Manage credentials via `POST /channels/config` with `service: "channel-discord"`.

## File Structure

| File | Purpose |
|---|---|
| `server.ts` | Main entry point, HTTP routing, Discord interaction handling, permission checks, startup |

## Related

- [API Reference](../../docs/api-spec.md) — Full endpoint and payload details
- [Guardian README](../../core/guardian/README.md) — How signed payloads are processed
