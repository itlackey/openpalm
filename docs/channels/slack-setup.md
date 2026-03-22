# Slack Bot Setup

This guide connects a Slack bot to OpenPalm's Slack addon.
OpenPalm is compose-first: add the Slack overlay to your compose file set, put Slack tokens in `user.env`, and restart the stack.

## Prerequisites

- A working OpenPalm install; see `docs/manual-setup.md`
- A Slack workspace where you can create apps
- The `slack` addon in your compose file set, or the optional `admin` addon if you want admin-assisted install
- `OP_ADMIN_TOKEN` from `~/.openpalm/vault/stack/stack.env` if you use admin endpoints

## 1. Create the Slack app

1. Go to <https://api.slack.com/apps> and create an app from scratch.
2. Enable **Socket Mode**.
3. Create an app-level token with `connections:write`; save it as `SLACK_APP_TOKEN`.
4. In **OAuth & Permissions**, add these bot scopes:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Read @mentions |
| `chat:write` | Reply in channels and DMs |
| `im:history` | Read DM history |
| `im:read` | Access DM conversations |
| `channels:history` | Read public channel history |
| `groups:history` | Read private channel history |
| `reactions:write` | Thinking indicator |
| `reactions:read` | Reaction cleanup |
| `users:read` | Display-name lookup |
| `commands` | Slash commands |

5. In **Event Subscriptions**, enable events and subscribe to:
   - `app_mention`
   - `message.im`
6. Install the app to the workspace and copy the bot token as `SLACK_BOT_TOKEN`.

## 2. Add Slack secrets to `user.env`

Edit `~/.openpalm/vault/user/user.env`:

```dotenv
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

Optional access controls:

```dotenv
SLACK_ALLOWED_CHANNELS=C01ABCDEF23
SLACK_ALLOWED_USERS=U01ABCDEF23
SLACK_BLOCKED_USERS=U09ZZZZZZ99
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
  -f addons/slack/compose.yml \
  up -d
```

Optional admin-assisted install: use the admin UI or current admin install API if
you prefer tooling over editing the compose file list by hand.

## 4. Optional slash commands

Create these commands in the Slack app if you want them:

- `/ask`
- `/clear`
- `/help`

For Socket Mode, the Request URL can be any placeholder value.

## 5. Verify

- DM the bot
- Mention the bot in a channel and confirm it replies in a thread
- Run `/ask`, `/help`, and `/clear`
- Check logs with `docker compose logs slack`

Conversation notes:

- DMs are per-user sessions
- Channel mentions reply in threads
- Follow-ups sent while a request is running are queued per session
- The adapter uses an hourglass reaction or processing message as a thinking indicator

## Troubleshooting

- No replies: verify `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, Socket Mode, and subscribed events
- DMs fail: verify `im:history`, `im:read`, and `message.im`
- Slash commands missing: add `commands`, create the commands in Slack, then reinstall the app
- `not_allowed_token_type`: `SLACK_APP_TOKEN` must be an app-level `xapp-...` token with `connections:write`
- Forwarding issues: inspect `docker compose logs guardian slack`

## Environment reference

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | App-level Socket Mode token (`xapp-...`) |
| `SLACK_ALLOWED_CHANNELS` | no | Comma-separated channel allowlist |
| `SLACK_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `SLACK_BLOCKED_USERS` | no | Comma-separated user blocklist |
| `CHANNEL_SLACK_SECRET` | system-managed | Guardian HMAC secret from `vault/stack/stack.env` |
