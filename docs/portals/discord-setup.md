# Discord Bot Setup

The Discord addon runs from the first-party portal image and sends native
OpenCode requests through Guardian. Use a generated OpenPalm installation; do
not bootstrap this addon by copying `packages/skeleton/`.

## Prerequisites

- A working OpenPalm installation
- Permission to create a Discord application and bot
- A configured assistant provider/model

## Create the Discord App

1. Open <https://discord.com/developers/applications> and create an application.
2. Copy the application ID from **General Information**.
3. Open **Bot**, create or reset the bot token, and copy it once.
4. Enable **Message Content Intent** under **Privileged Gateway Intents**.

## Configure Credentials

The bot token is delegated and belongs under `private/secrets/`. The application
ID and access lists are non-secret and belong in `state/stack.env`.

```bash
install -d -m 700 "$HOME/.openpalm/private/secrets"
printf '%s\n' 'your-bot-token' \
  > "$HOME/.openpalm/private/secrets/discord_bot_token"
chmod 600 "$HOME/.openpalm/private/secrets/discord_bot_token"
```

```dotenv
# ~/.openpalm/state/stack.env
DISCORD_APPLICATION_ID=your-application-id
DISCORD_REGISTER_COMMANDS=true
```

Optional access controls:

```dotenv
DISCORD_ALLOWED_GUILDS=123456789012345678
DISCORD_ALLOWED_ROLES=234567890123456789
DISCORD_ALLOWED_USERS=345678901234567890
DISCORD_BLOCKED_USERS=456789012345678901
```

The installer generates `private/secrets/portal_discord_secret`. Guardian and
the Discord adapter receive that shared principal value through narrow Compose
secret grants. Do not move it into the assistant-readable knowledge tree.

You may configure the same fields through the host admin UI instead of editing
files.

## Enable the Addon

```bash
openpalm addon enable discord
```

For raw Compose, use the fixed file list and pass the profile explicitly:

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
docker compose \
  --project-name openpalm \
  --env-file "$OP_HOME/state/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.discord \
  up -d
```

`OP_ENABLED_ADDONS=discord` is translated only by OpenPalm commands. Raw
Compose still needs `--profile addon.discord` or an explicit
`COMPOSE_PROFILES` value.

## Invite the Bot

In Discord **OAuth2**, select these scopes:

- `bot`
- `applications.commands`

Recommended permissions:

- Send Messages
- Read Message History
- Use Slash Commands
- Embed Links

Invite URL template:

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=19456&scope=bot%20applications.commands
```

## Verify

```bash
openpalm status
openpalm logs discord
openpalm logs guardian
```

In Discord, test `/ask`, `/health`, `/help`, and `/clear`, then mention the bot
in a channel.

Conversation behavior:

- A mention in a normal channel creates or reuses a Discord thread.
- Replies in that tracked thread reuse the backend session.
- `/ask` replies inline without creating a thread.
- Follow-ups can queue while a turn is running.

## Troubleshooting

| Symptom | Check |
|---|---|
| Bot is offline | Bot token, Discord gateway reachability, and `discord` container status |
| Slash commands are missing | Application ID, `DISCORD_REGISTER_COMMANDS`, token, and `applications.commands` scope |
| Messages are ignored | Message Content Intent and guild/role/user allowlists |
| Guardian returns `401` | Matching `portal_discord_secret` grants and recreated Guardian/Discord containers |
| Guardian blocks content | Guardian logs and moderation provider/model; validation is on by default |

## Runtime Environment

| Variable | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN_FILE` | Path to the mounted bot-token secret |
| `DISCORD_APPLICATION_ID` | Application ID used for command registration |
| `DISCORD_REGISTER_COMMANDS` | Set `false` to skip startup registration |
| `DISCORD_ALLOWED_GUILDS` | Comma-separated guild allowlist |
| `DISCORD_ALLOWED_ROLES` | Comma-separated role allowlist |
| `DISCORD_ALLOWED_USERS` | Comma-separated user allowlist |
| `DISCORD_BLOCKED_USERS` | Comma-separated user blocklist |
| `PRINCIPAL_SECRET_FILE` | System-managed Guardian principal secret path |

See the [Manual Compose Runbook](../operations/manual-compose-runbook.md) for
profile-safe raw operations.
