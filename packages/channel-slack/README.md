# @openpalm/channel-slack

Slack Socket Mode adapter for OpenPalm.
It normally runs via `addons/slack/compose.yml` and connects outbound to Slack, so no public inbound URL is required.

## Features

- Socket Mode WebSocket connection
- Direct messages and channel @mentions
- Threaded replies for channel conversations
- Slash commands: `/ask`, `/clear`, `/help`
- Per-session request queueing and thinking indicators

## Deployment model

- Shipped addon source: `.openpalm/registry/addons/slack/compose.yml`
- Enabled runtime overlay: `~/.openpalm/stack/addons/slack/compose.yml`
- User-managed values: `~/.openpalm/vault/user/user.env`
- System-managed HMAC secret: `CHANNEL_SLACK_SECRET` in `~/.openpalm/vault/stack/guardian.env`

Manual start example:

```bash
cd "$HOME/.openpalm/stack"
docker compose \
  --project-name openpalm \
  --env-file ../vault/stack/stack.env \
  --env-file ../vault/user/user.env \
  -f core.compose.yml \
  -f addons/slack/compose.yml \
  up -d
```

The shipped addon overlay loads `vault/stack/stack.env` and `vault/user/user.env`
with `env_file`, so Slack credentials placed in `user.env` are passed into the container.

See `docs/channels/slack-setup.md` for the full setup guide.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CHANNEL_SLACK_SECRET` | system-managed | Guardian HMAC secret |
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | App-level Socket Mode token (`xapp-...`) |
| `SLACK_ALLOWED_CHANNELS` | no | Comma-separated channel allowlist |
| `SLACK_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `SLACK_BLOCKED_USERS` | no | Comma-separated user blocklist |

## Conversation behavior

- DMs are per-user sessions
- Channel mentions reply in a thread
- Follow-ups sent while a session is busy are queued
- `/clear` clears the active session and drops queued follow-ups
