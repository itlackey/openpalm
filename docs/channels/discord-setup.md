# Discord Bot Setup

This guide connects a Discord bot to an OpenPalm stack that you run with Docker Compose.
Compose files are the source of truth; the admin UI/API is optional convenience.

## Prerequisites

- A working OpenPalm install; see `docs/manual-setup.md`
- Discord app/bot creation access
- The `discord` addon included in your compose file set, or an admin addon if you want the optional install API
- `OP_ADMIN_TOKEN` from `~/.openpalm/vault/stack/stack.env` if you use admin endpoints

## 1. Create the Discord app and bot

1. Open <https://discord.com/developers/applications> and create a new application.
2. In **General Information**, copy:
   - `DISCORD_APPLICATION_ID`
3. In **Bot**, create or reset the bot token and copy it as `DISCORD_BOT_TOKEN`.
4. Enable **Message Content Intent** under **Privileged Gateway Intents**.

## 2. Add Discord secrets to `user.env`

Edit `~/.openpalm/vault/user/user.env`:

```dotenv
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_APPLICATION_ID=your-application-id
```

Optional controls:

```dotenv
DISCORD_ALLOWED_GUILDS=123456789012345678
DISCORD_ALLOWED_ROLES=234567890123456789
DISCORD_ALLOWED_USERS=345678901234567890
DISCORD_BLOCKED_USERS=456789012345678901
DISCORD_REGISTER_COMMANDS=true
```

## 3. Start the addon

Manual-first path:

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  -f core.compose.yml \
  -f addons/discord/compose.yml \
  up -d
```

Optional admin-assisted install: use the admin UI or current admin install API if
you prefer tooling over editing the compose file list by hand.

## 4. Invite the bot

In **OAuth2** select:

- `bot`
- `applications.commands`

Recommended bot permissions:

- Send Messages
- Read Message History
- Use Slash Commands
- Embed Links

Invite URL template:

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=19456&scope=bot%20applications.commands
```

## 5. Verify

- Run `/ask`, `/health`, `/help`, and `/clear`
- Mention the bot in a channel to start a thread-scoped conversation
- Check logs with `docker compose logs discord`

Conversation notes:

- Mentions in normal channels create or reuse a Discord thread
- Replies inside that tracked thread keep the same backend session
- `/ask` replies inline and does not create a thread
- `/queue` queues follow-ups for the current conversation when work is already in progress

## Troubleshooting

- No bot replies: confirm `DISCORD_BOT_TOKEN`, Message Content Intent, and that the `discord` service is running
- Slash commands missing: confirm `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, and `DISCORD_REGISTER_COMMANDS!=false`
- Bot still appears offline: confirm the bot token, gateway intents, and that the `discord` container can reach Discord
- Forwarding issues: inspect `docker compose logs guardian discord`

## Environment reference

| Variable | Required | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `DISCORD_APPLICATION_ID` | yes for command registration | Discord application ID |
| `DISCORD_REGISTER_COMMANDS` | no | Disable startup slash-command registration when `false` |
| `DISCORD_ALLOWED_GUILDS` | no | Comma-separated guild allowlist |
| `DISCORD_ALLOWED_ROLES` | no | Comma-separated role allowlist |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `DISCORD_BLOCKED_USERS` | no | Comma-separated user blocklist |
| `DISCORD_CUSTOM_COMMANDS` | no | JSON array of custom slash commands |
| `CHANNEL_DISCORD_SECRET` | system-managed | Guardian HMAC secret from `vault/stack/stack.env` |
