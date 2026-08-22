# Slack Bot Setup

The Slack addon uses Socket Mode and sends native OpenCode requests through
Guardian. Socket Mode connects outbound, so no public Slack request URL is
required.

## Prerequisites

- A working generated OpenPalm installation
- A Slack workspace where you can create apps
- A configured assistant provider/model

## Create the Slack App

1. Go to <https://api.slack.com/apps> and create an app from scratch.
2. Enable **Socket Mode**.
3. Create an app-level `xapp-...` token with `connections:write`.
4. Add the bot scopes below under **OAuth & Permissions**.
5. Enable the event subscriptions below.
6. Enable **Interactivity & Shortcuts**.
7. Enable the **App Home** tab.
8. Install the app to the workspace and copy its `xoxb-...` bot token.

Required bot scopes:

- `app_mentions:read`
- `chat:write`
- `im:history`
- `channels:history`
- `groups:history`
- `users:read`
- `commands`

Event subscriptions:

- `app_mention`
- `message.im`
- `message.channels`
- `message.groups`
- `app_home_opened`

Optional shortcuts:

- Global shortcut `Ask OpenPalm`, callback ID `ask_openpalm`
- Message shortcut `Ask OpenPalm about this message`, callback ID `ask_openpalm_message`

Socket Mode can use a placeholder Request URL for interactivity and slash
commands.

## Configure Credentials

Both Slack tokens are delegated secrets under `state/secrets/`:

```bash
install -d -m 700 "$HOME/.openpalm/state/secrets"
printf '%s\n' 'xoxb-your-bot-token' \
  > "$HOME/.openpalm/state/secrets/slack_bot_token"
printf '%s\n' 'xapp-your-app-token' \
  > "$HOME/.openpalm/state/secrets/slack_app_token"
chmod 600 \
  "$HOME/.openpalm/state/secrets/slack_bot_token" \
  "$HOME/.openpalm/state/secrets/slack_app_token"
```

Optional non-secret controls belong in `state/stack.env`:

```dotenv
SLACK_ALLOWED_CHANNELS=C01ABCDEF23
SLACK_ALLOWED_USERS=U01ABCDEF23
SLACK_BLOCKED_USERS=U09ZZZZZZ99
```

The installer generates `state/secrets/portal_slack_secret` for Guardian
principal authentication. You may configure all of these values through the
host admin UI instead of editing files.

## Enable the Addon

```bash
openpalm addon enable slack
```

For raw Compose, pass the profile explicitly:

```bash
OP_HOME="${OP_HOME:-$HOME/.openpalm}"
docker compose \
  --project-name openpalm \
  --env-file "$OP_HOME/state/stack.env" \
  -f "$OP_HOME/system/stack/core.compose.yml" \
  -f "$OP_HOME/system/stack/services.compose.yml" \
  -f "$OP_HOME/system/stack/portals.compose.yml" \
  -f "$OP_HOME/config/stack/custom.compose.yml" \
  --profile addon.slack \
  up -d
```

`OP_ENABLED_ADDONS=slack` is OpenPalm state, not a Docker Compose profile
instruction. Raw Compose needs `--profile addon.slack` or an explicit
`COMPOSE_PROFILES` value.

## Verify

```bash
openpalm status
openpalm logs slack
openpalm logs guardian
```

Then:

- DM the bot.
- Mention it in a channel and confirm it replies in a thread.
- Run `/ask`, `/help`, and `/clear` if configured.
- Open App Home.
- Test configured global and message shortcuts.

## Troubleshooting

| Symptom | Check |
|---|---|
| No replies | Both token files, Socket Mode, event subscriptions, and container status |
| DMs fail | `im:history` and `message.im` |
| Channel follow-ups fail | Public/private history scopes and matching message events |
| Slash commands fail | `commands` scope, command definitions, and app reinstall |
| `not_allowed_token_type` | App token must be `xapp-...` with `connections:write` |
| Guardian returns `401` | Matching `portal_slack_secret` grants and recreated services |
| Guardian blocks content | Guardian logs and moderation provider/model; validation is on by default |

## Runtime Environment

| Variable | Purpose |
|---|---|
| `SLACK_BOT_TOKEN_FILE` | Mounted `xoxb-...` bot token path |
| `SLACK_APP_TOKEN_FILE` | Mounted `xapp-...` Socket Mode token path |
| `SLACK_ALLOWED_CHANNELS` | Comma-separated channel allowlist |
| `SLACK_ALLOWED_USERS` | Comma-separated user allowlist |
| `SLACK_BLOCKED_USERS` | Comma-separated user blocklist |
| `PRINCIPAL_SECRET_FILE` | System-managed Guardian principal secret path |

See the [Manual Compose Runbook](../operations/manual-compose-runbook.md) for
profile-safe raw operations.
