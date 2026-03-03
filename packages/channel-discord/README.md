# @openpalm/channel-discord

Production-ready Discord adapter for OpenPalm.

This channel supports:
- Discord interactions endpoint (`/discord/interactions`) with Ed25519 signature verification
- Built-in slash commands: `/ask`, `/health`, `/help`, `/clear`
- Optional custom slash commands (`DISCORD_CUSTOM_COMMANDS`)
- Guild/role/user allowlists + user blocklist
- Deferred responses for assistant calls that can exceed Discord's 3-second interaction deadline
- Backward-compatible REST webhook endpoint (`/discord/webhook`)

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/discord/interactions` | Discord interactions endpoint |
| `POST` | `/discord/webhook` | Legacy webhook adapter |
| `GET` | `/health` | Health check |

## Discord bot setup

1. Create an app at https://discord.com/developers/applications
2. In **General Information**, copy:
   - **Application ID** → `DISCORD_APPLICATION_ID`
   - **Public Key** → `DISCORD_PUBLIC_KEY`
3. In **Bot**, create/reset token and copy it to `DISCORD_BOT_TOKEN`
4. Invite the bot with scopes:
   - `bot`
   - `applications.commands`
5. Set the Interactions endpoint URL to:
   - `https://<your-openpalm-host>/discord/interactions`
6. Install the `discord` channel in OpenPalm (`/admin/channels/install`) and set env values in your stack env/config.

> `DISCORD_PUBLIC_KEY` is required in production. Without it, `/discord/interactions` returns `503 missing_public_key` unless `DISCORD_ALLOW_UNSIGNED_INTERACTIONS=true` is explicitly set for local/dev use.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CHANNEL_DISCORD_SECRET` | yes | HMAC secret for guardian forwarding (admin-managed) |
| `DISCORD_PUBLIC_KEY` | yes (production) | Verifies Discord interaction signatures |
| `DISCORD_ALLOW_UNSIGNED_INTERACTIONS` | no | Set `true` only for local/dev to allow unsigned interaction requests |
| `DISCORD_APPLICATION_ID` | yes (for command registration) | Discord application ID |
| `DISCORD_BOT_TOKEN` | yes (for command registration) | Bot token used to register commands |
| `DISCORD_REGISTER_COMMANDS` | no | Set `false` to disable startup slash-command registration |
| `DISCORD_ALLOWED_GUILDS` | no | Comma-separated guild allowlist |
| `DISCORD_ALLOWED_ROLES` | no | Comma-separated role allowlist |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `DISCORD_BLOCKED_USERS` | no | Comma-separated user blocklist |
| `DISCORD_CUSTOM_COMMANDS` | no | JSON array of custom slash command defs |

## Custom commands (`DISCORD_CUSTOM_COMMANDS`)

```json
[
  {
    "name": "summarize",
    "description": "Summarize a topic",
    "options": [
      { "name": "topic", "description": "Topic to summarize", "type": 3, "required": true }
    ],
    "promptTemplate": "Please summarize: {{topic}}"
  }
]
```

## Registry overlay

`registry/channels/discord.yml`
