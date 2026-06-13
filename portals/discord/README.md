# @openpalm/discord-portal

Discord bot adapter for OpenPalm.
It runs behind guardian and is normally enabled via the `addon.discord` Compose profile.

## Features

- Gateway-based Discord bot connection
- Slash commands: `/ask`, `/queue`, `/health`, `/help`, `/clear`
- Mention-to-thread conversations
- Guild, role, and user allowlists plus user blocklist
- Deferred responses, typing indicators, queued follow-ups, and long-reply splitting

## Deployment model

- Shipped service definition: `.openpalm/config/stack/channels.compose.yml`, profile `addon.discord`
- Non-secret values: `~/.openpalm/knowledge/env/stack.env`
- Secret values: files under `~/.openpalm/knowledge/secrets/`

Manual start example:

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  --project-name openpalm \
  --env-file ../../knowledge/env/stack.env \
  -f core.compose.yml \
  -f services.compose.yml \
  -f channels.compose.yml \
  -f custom.compose.yml \
  --profile addon.discord \
  up -d
```

See `docs/channels/discord-setup.md` for the full walkthrough.

The service definition uses explicit non-secret environment entries and Docker secret grants. It does not use service-level `env_file`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OPENCODE_BASE_URL` | no | OpenCode/guardian `/oc` base URL, default `http://guardian:8080/oc` |
| `PRINCIPAL_ID` | system-managed | Guardian principal id used for Basic auth |
| `PRINCIPAL_SECRET_FILE` | system-managed | Shared secret file path used for Basic auth |
| `DISCORD_APPLICATION_ID` | yes for command registration | Discord application ID |
| `DISCORD_BOT_TOKEN_FILE` | yes | Bot token file path |
| `DISCORD_REGISTER_COMMANDS` | no | Disable startup command registration when `false` |
| `DISCORD_ALLOWED_GUILDS` | no | Comma-separated guild allowlist |
| `DISCORD_ALLOWED_ROLES` | no | Comma-separated role allowlist |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `DISCORD_BLOCKED_USERS` | no | Comma-separated user blocklist |
| `DISCORD_CUSTOM_COMMANDS` | no | JSON array of custom command definitions |

Secret values are stored as files and exposed only through `*_FILE` variables. The schema may collect `DISCORD_BOT_TOKEN` for setup, but setup persists it under `knowledge/secrets/` and the runtime receives `DISCORD_BOT_TOKEN_FILE`, not the raw token.

The shipped Compose overlay exposes per-portal overrides through `DISCORD_OPENCODE_BASE_URL`, `DISCORD_PRINCIPAL_ID`, and `DISCORD_PRINCIPAL_SECRET_FILE`; each defaults to the guardian-backed first-party wiring.

## Conversation behavior

- Mentioning the bot in a normal channel starts or reuses a Discord thread
- Replies inside that tracked thread keep the same backend session
- `/ask` replies inline and does not create a thread
- `/clear` clears the active conversation scope and drops queued follow-ups for that scope
