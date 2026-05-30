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

- Shipped addon source: `.openpalm/config/stack/channels.compose.yml`
- Enabled runtime overlay: `~/.openpalm/config/stack/addons/discord/compose.yml`
- Non-secret values: `~/.openpalm/config/stack/stack.env`
- Secret values: files under `~/.openpalm/knowledge/vaults/secrets/`

Manual start example:

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  --project-name openpalm \
  --env-file stack.env \
  -f core.compose.yml \
  -f addons/discord/compose.yml \
  up -d
```

See `docs/channels/discord-setup.md` for the full walkthrough.

The shipped addon overlay uses explicit non-secret environment entries and Docker secret grants. It does not use service-level `env_file`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CHANNEL_SECRET_FILE` | system-managed | Discord channel outbound guardian HMAC secret file path |
| `CHANNEL_DISCORD_SECRET_FILE` | system-managed | Guardian verification HMAC secret file path for Discord |
| `DISCORD_APPLICATION_ID` | yes for command registration | Discord application ID |
| `DISCORD_BOT_TOKEN_FILE` | yes | Bot token file path |
| `DISCORD_REGISTER_COMMANDS` | no | Disable startup command registration when `false` |
| `DISCORD_ALLOWED_GUILDS` | no | Comma-separated guild allowlist |
| `DISCORD_ALLOWED_ROLES` | no | Comma-separated role allowlist |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `DISCORD_BLOCKED_USERS` | no | Comma-separated user blocklist |
| `DISCORD_CUSTOM_COMMANDS` | no | JSON array of custom command definitions |

Secret values are stored as files and exposed only through `*_FILE` variables. The schema may collect `DISCORD_BOT_TOKEN` for setup, but setup persists it under `knowledge/vaults/secrets/` and the runtime receives `DISCORD_BOT_TOKEN_FILE`, not the raw token.

## Conversation behavior

- Mentioning the bot in a normal channel starts or reuses a Discord thread
- Replies inside that tracked thread keep the same backend session
- `/ask` replies inline and does not create a thread
- `/clear` clears the active conversation scope and drops queued follow-ups for that scope
