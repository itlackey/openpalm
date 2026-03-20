# @openpalm/channel-discord

Production-ready Discord adapter for OpenPalm.

This channel supports:
- Discord interactions endpoint (`/discord/interactions`) with Ed25519 signature verification
- Built-in slash commands: `/ask`, `/queue`, `/health`, `/help`, `/clear`
- Optional custom slash commands (`DISCORD_CUSTOM_COMMANDS`)
- Mention-to-thread conversations for channel messages
- Thread-scoped or channel-scoped guardian session keys
- Guild/role/user allowlists + user blocklist
- Deferred responses for assistant calls that can exceed Discord's 3-second interaction deadline
- Typing indicators, queued follow-ups, and split replies for long assistant output
- Backward-compatible REST webhook endpoint (`/discord/webhook`)

## Conversation behavior

- Mention the bot in a normal channel to start a Discord thread. The thread name is taken from the first line of your message and auto-archives after 1 hour.
- Once the bot has started participating in that thread, follow-up messages in the same thread do not need another mention.
- Mention-driven thread conversations are scoped to the Discord thread, so each thread gets its own backend session.
- `/ask` does not create a thread. It replies to the slash command directly in the current channel or DM.
- Slash-command conversations use the current thread when one exists; otherwise they use a channel-plus-user session scope.

## `/clear` behavior

- `/clear` sends a guardian control request with the active session key and clears the cached backend conversation for the current Discord conversation scope.
- In a thread, it clears that thread's conversation only.
- In slash-command flows outside a thread, it clears the current channel-plus-user conversation scope.
- If queued follow-ups exist for that same session, they are dropped after a successful clear.

## Request workflow

- Mention flow: permission check -> create or reuse thread -> show typing -> forward to guardian with a thread session key -> post the assistant reply back into the thread.
- Slash command flow: permission check -> defer the interaction reply -> forward to guardian with the current session key -> edit the deferred reply and send follow-up chunks if needed.
- `/queue` adds a follow-up prompt for the current conversation when work is already in progress; if the session is idle, it runs immediately.
- Messages posted into an active tracked thread while the bot is still working are queued automatically.
- Long assistant replies are split into Discord-safe chunks up to 2000 characters, with basic code block preservation.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/discord/interactions` | Discord interactions endpoint |
| `POST` | `/discord/webhook` | Legacy webhook adapter |
| `GET` | `/health` | Health check |

## Discord bot setup

1. Create an app at https://discord.com/developers/applications
2. In **General Information**, copy:
   - **Application ID** → `DISCORD_APPLICATION_ID`
   - **Public Key** → `DISCORD_PUBLIC_KEY`
3. In **Bot**, create/reset token and copy it to `DISCORD_BOT_TOKEN`
4. Invite the bot with scopes:
    - `bot`
    - `applications.commands`
5. Set the Interactions endpoint URL to:
   - `https://<your-openpalm-host>/discord/interactions`
6. Install the `discord` channel in OpenPalm (`/admin/channels/install`) and set env values in your stack env/config.

> `DISCORD_PUBLIC_KEY` is required in production. Without it, `/discord/interactions` returns `503 missing_public_key` unless `DISCORD_ALLOW_UNSIGNED_INTERACTIONS=true` is explicitly set for local/dev use.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `CHANNEL_DISCORD_SECRET` | yes | HMAC secret for guardian forwarding (admin-managed) |
| `DISCORD_PUBLIC_KEY` | yes (production) | Verifies Discord interaction signatures |
| `DISCORD_ALLOW_UNSIGNED_INTERACTIONS` | no | Set `true` only for local/dev to allow unsigned interaction requests |
| `DISCORD_APPLICATION_ID` | yes (for command registration) | Discord application ID |
| `DISCORD_BOT_TOKEN` | yes (for command registration) | Bot token used to register commands |
| `DISCORD_REGISTER_COMMANDS` | no | Set `false` to disable startup slash-command registration |
| `DISCORD_ALLOWED_GUILDS` | no | Comma-separated guild allowlist |
| `DISCORD_ALLOWED_ROLES` | no | Comma-separated role allowlist |
| `DISCORD_ALLOWED_USERS` | no | Comma-separated user allowlist |
| `DISCORD_BLOCKED_USERS` | no | Comma-separated user blocklist |
| `DISCORD_CUSTOM_COMMANDS` | no | JSON array of custom slash command defs |

## Built-in commands

| Command | Behavior |
|---|---|
| `/ask <message>` | Sends a prompt to OpenPalm and replies inline to the slash command |
| `/queue <message>` | Queues a follow-up for the current conversation, or runs immediately if idle |
| `/health` | Runs a lightweight assistant reachability check and replies ephemerally |
| `/help` | Lists built-in and custom commands |
| `/clear` | Clears the current Discord conversation scope in guardian and drops queued follow-ups for that scope |

## Custom commands (`DISCORD_CUSTOM_COMMANDS`)

```json
[
  {
    "name": "summarize",
    "description": "Summarize a topic",
    "options": [
      { "name": "topic", "description": "Topic to summarize", "type": 3, "required": true }
    ],
    "promptTemplate": "Please summarize: {{topic}}"
  }
]
```

## Registry component

`registry/components/discord/compose.yml`
