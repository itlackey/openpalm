# @openpalm/channel-slack

Slack adapter for OpenPalm using Socket Mode (no public URL required).

This channel supports:
- Socket Mode connection (outbound WebSocket — no inbound firewall rules needed)
- Direct messages (no mention required)
- Channel @mentions with threaded replies
- Built-in slash commands: `/ask`, `/clear`, `/help`
- Per-session conversation queuing (serialized follow-ups)
- User/channel allowlists + user blocklist
- Hourglass reaction as a thinking indicator
- Username resolution with caching
- Long message splitting at 4000 characters with code block preservation

## Conversation behavior

- **DMs**: Send the bot a direct message — no mention needed. Each DM conversation maintains its own session.
- **Channel mentions**: @mention the bot in a channel to start a conversation. The bot always replies in a thread.
- **Thread continuation**: Once the bot is active in a thread, it continues using that thread's session context.
- **Threaded mentions**: If you @mention the bot inside an existing thread, it replies in that same thread.
- `/ask` posts a "processing" message that is updated in-place with the response.

## `/clear` behavior

- `/clear` sends a guardian control request to clear the active session for the current channel and user scope.
- If queued follow-ups exist for that session, they are dropped after a successful clear.

## Request workflow

- DM flow: filter bot/subtype messages → permission check → resolve session key → queue or run → forward to guardian → post reply.
- Mention flow: permission check → strip bot mention → resolve thread → forward to guardian with thread session key → post reply in thread.
- Slash command flow: acknowledge → permission check → resolve session key → queue or run → post thinking message → forward to guardian → update thinking message with reply.
- If a user sends another message while the bot is processing, the follow-up is queued and processed after the current request completes.
- Long assistant replies are split into Slack-safe chunks up to 4000 characters, with code block boundary preservation.

## Thinking indicator

- For DM and mention conversations, the bot adds an :hourglass: reaction while processing, removed when the reply is posted.
- For `/ask` commands, a "Processing your request..." message is shown and replaced with the response.

## Slack app setup

1. Create a Slack app at https://api.slack.com/apps
2. Enable **Socket Mode** and generate an App-Level Token (`xapp-...`) with `connections:write` scope → `SLACK_APP_TOKEN`
3. Add bot token scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `channels:history`, `groups:history`, `reactions:write`, `reactions:read`, `users:read`, `commands`
4. Subscribe to bot events: `app_mention`, `message.im`
5. (Optional) Create slash commands: `/ask`, `/clear`, `/help`
6. Install the app to your workspace and copy the Bot User OAuth Token (`xoxb-...`) → `SLACK_BOT_TOKEN`
7. Install the `slack` channel in OpenPalm (`/admin/channels/install` or via the admin UI)

See [docs/slack-setup.md](../../docs/slack-setup.md) for the full step-by-step guide.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CHANNEL_SLACK_SECRET` | yes | HMAC secret for guardian forwarding (admin-managed) |
| `SLACK_BOT_TOKEN` | yes | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | yes | App-Level Token for Socket Mode (`xapp-...`) |
| `SLACK_ALLOWED_CHANNELS` | no | Comma-separated channel ID allowlist |
| `SLACK_ALLOWED_USERS` | no | Comma-separated user ID allowlist |
| `SLACK_BLOCKED_USERS` | no | Comma-separated user ID blocklist |

## Built-in commands

| Command | Behavior |
|---|---|
| `/ask <message>` | Sends a prompt to OpenPalm and replies with the response |
| `/clear` | Clears the current conversation session and drops queued follow-ups |
| `/help` | Lists available commands |

## Registry component

`registry/components/slack/compose.yml`
