# @openpalm/channel-slack

Slack Socket Mode adapter for OpenPalm.
It normally runs via the `addon.slack` Compose profile and connects outbound to Slack, so no public inbound URL is required.

## Features

- Socket Mode WebSocket connection
- Direct messages and channel @mentions
- Threaded replies for channel conversations
- Slash commands: `/ask`, `/clear`, `/help`
- Global shortcut: `Ask OpenPalm` modal entry point
- Message shortcut: `Ask OpenPalm about this message` with prefilled context
- App Home onboarding tab with quick usage guidance
- Per-session request queueing and thinking indicators

## Deployment model

- Shipped service definition: `.openpalm/config/stack/channels.compose.yml`, profile `addon.slack`
- Non-secret values: `~/.openpalm/knowledge/env/stack.env`
- Secret values: files under `~/.openpalm/knowledge/secrets/`

Manual start example:

```bash
cd "$HOME/.openpalm/config/stack"
docker compose \
  --project-name openpalm \
  --env-file stack.env \
  -f core.compose.yml \
  -f services.compose.yml \
  -f channels.compose.yml \
  -f custom.compose.yml \
  --profile addon.slack \
  up -d
```

The service definition uses explicit non-secret environment entries and Docker secret grants. It does not use service-level `env_file`.

The Slack channel container uses `CHANNEL_SECRET_FILE` to sign guardian messages. The guardian uses `CHANNEL_SLACK_SECRET_FILE` to verify Slack channel messages.

See `docs/channels/slack-setup.md` for the full setup guide.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CHANNEL_SECRET_FILE` | system-managed | Slack channel outbound guardian HMAC secret file path |
| `CHANNEL_SLACK_SECRET_FILE` | system-managed | Guardian verification HMAC secret file path for Slack |
| `SLACK_BOT_TOKEN_FILE` | yes | Bot User OAuth token file path |
| `SLACK_APP_TOKEN_FILE` | yes | App-level Socket Mode token file path |
| `SLACK_ALLOWED_CHANNELS` | no | Comma-separated channel allowlist |
| `SLACK_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `SLACK_BLOCKED_USERS` | no | Comma-separated user blocklist |

Secret values are stored as files and exposed only through `*_FILE` variables. The schema may collect `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` for setup, but setup persists them under `knowledge/secrets/` and the runtime receives `SLACK_BOT_TOKEN_FILE` and `SLACK_APP_TOKEN_FILE`, not raw tokens.

## Slack app configuration

Required bot scopes:

- `app_mentions:read`
- `chat:write`
- `im:history`
- `channels:history`
- `groups:history`
- `users:read`
- `commands`

Required event subscriptions:

- `app_mention`
- `message.im`
- `message.channels`
- `message.groups`
- `app_home_opened`

Required Interactivity setup:

- Enable **Interactivity & Shortcuts** in your Slack app
- Add a global shortcut with callback ID `ask_openpalm`
- Add a message shortcut with callback ID `ask_openpalm_message`
- Socket Mode apps can use any placeholder Request URL for interactivity

The adapter does not require reaction scopes.

## Conversation behavior

- DMs are per-user sessions
- Channel mentions reply in a thread
- Follow-ups sent while a session is busy are queued
- `/clear` clears the active session and drops queued follow-ups
