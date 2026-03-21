# @openpalm/channel-discord

Discord bot adapter for OpenPalm.
It runs behind guardian and is normally deployed by including `addons/discord/compose.yml` in your compose file set.

## Features

- Gateway-based Discord bot connection
- Slash commands: `/ask`, `/queue`, `/health`, `/help`, `/clear`
- Mention-to-thread conversations
- Guild, role, and user allowlists plus user blocklist
- Deferred responses, typing indicators, queued follow-ups, and long-reply splitting

## Deployment model

- Compose overlay: `~/.openpalm/stack/addons/discord/compose.yml`
- User-managed values: `~/.openpalm/vault/user/user.env`
- System-managed HMAC secret: `CHANNEL_DISCORD_SECRET` in `~/.openpalm/vault/stack/stack.env`

Manual start example:

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

See `docs/channels/discord-setup.md` for the full walkthrough.

The shipped addon overlay loads `vault/stack/stack.env` and `vault/user/user.env`
with `env_file`, so Discord credentials placed in `user.env` are passed into the container.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CHANNEL_DISCORD_SECRET` | system-managed | Guardian HMAC secret |
| `DISCORD_APPLICATION_ID` | yes for command registration | Discord application ID |
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `DISCORD_REGISTER_COMMANDS` | no | Disable startup command registration when `false` |
| `DISCORD_ALLOWED_GUILDS` | no | Comma-separated guild allowlist |
| `DISCORD_ALLOWED_ROLES` | no | Comma-separated role allowlist |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `DISCORD_BLOCKED_USERS` | no | Comma-separated user blocklist |
| `DISCORD_CUSTOM_COMMANDS` | no | JSON array of custom command definitions |

## Conversation behavior

- Mentioning the bot in a normal channel starts or reuses a Discord thread
- Replies inside that tracked thread keep the same backend session
- `/ask` replies inline and does not create a thread
- `/clear` clears the active conversation scope and drops queued follow-ups for that scope
