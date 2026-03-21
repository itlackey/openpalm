# Slack Bot Setup

This guide walks through connecting a Slack bot to your OpenPalm instance. By the
end, users in your Slack workspace will be able to interact with your assistant
by mentioning the bot in channels, sending DMs, or using slash commands.

OpenPalm's Slack adapter uses **Socket Mode**, which means no public URL or
inbound firewall rules are required — the bot connects outbound to Slack over a
WebSocket.

---

## Prerequisites

- A running OpenPalm stack (see [setup-guide.md](setup-guide.md))
- A Slack workspace where you have permission to create apps
- Your OpenPalm admin token (`ADMIN_TOKEN`)

---

## 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**.
2. Choose **From scratch**.
3. Give your app a name (e.g. "OpenPalm") and select the workspace to install it in.
4. Click **Create App**.

## 2. Enable Socket Mode

Socket Mode lets the bot receive events over a WebSocket instead of requiring a
public HTTP endpoint.

1. In the left sidebar, click **Socket Mode**.
2. Toggle **Enable Socket Mode** to on.
3. You will be prompted to create an **App-Level Token**. Give it a name (e.g.
   "openpalm-socket") and add the scope `connections:write`.
4. Click **Generate**. Copy the token that starts with `xapp-`. This is your
   `SLACK_APP_TOKEN`. Save it securely — you will not be able to see it again.

## 3. Configure Bot Token Scopes

1. In the left sidebar, click **OAuth & Permissions**.
2. Scroll down to **Scopes** → **Bot Token Scopes** and add the following:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive events when the bot is @mentioned |
| `chat:write` | Send messages and replies |
| `im:history` | Read DM message history |
| `im:read` | Access DM conversations |
| `channels:history` | Read message history in public channels |
| `groups:history` | Read message history in private channels |
| `reactions:write` | Add thinking indicator reactions |
| `reactions:read` | Read reactions (for indicator cleanup) |
| `users:read` | Resolve user display names |
| `commands` | Register slash commands |

## 4. Enable Event Subscriptions

1. In the left sidebar, click **Event Subscriptions**.
2. Toggle **Enable Events** to on. (Socket Mode handles delivery — no Request URL
   is needed.)
3. Under **Subscribe to bot events**, add:
   - `app_mention` — triggers when someone @mentions the bot
   - `message.im` — triggers on direct messages to the bot

   Optionally, if you want the bot to respond in channels without a mention
   (not recommended for most setups):
   - `message.channels` — triggers on messages in public channels the bot is in
   - `message.groups` — triggers on messages in private channels the bot is in

4. Click **Save Changes**.

## 5. Register Slash Commands (Optional)

Slash commands provide a structured way for users to interact with the bot. They
are optional — the bot also responds to @mentions and DMs.

1. In the left sidebar, click **Slash Commands**.
2. Click **Create New Command** for each:

| Command | Short Description | Usage Hint |
|---------|-------------------|------------|
| `/ask` | Send a message to the assistant | `[your message]` |
| `/clear` | Clear the current conversation | _(leave blank)_ |
| `/help` | Show available commands | _(leave blank)_ |

3. For each command, the **Request URL** field can be left as any placeholder
   (e.g. `https://localhost`) — Socket Mode intercepts commands before they reach
   an HTTP endpoint.

## 6. Install the App to Your Workspace

1. In the left sidebar, click **Install App** (or go back to **OAuth & Permissions**).
2. Click **Install to Workspace** and authorize the requested permissions.
3. Copy the **Bot User OAuth Token** that starts with `xoxb-`. This is your
   `SLACK_BOT_TOKEN`. Save it securely.

## 7. Install the Slack Channel in OpenPalm

### Via the Admin UI

1. Open the OpenPalm admin UI in your browser (default: `http://localhost:8100`).
2. Navigate to the **Channels** page.
3. Find **Slack** in the registry list and click **Install**.
4. After installation, go to the **Connections** page (or the channel's
   configuration section) and enter:
   - `SLACK_BOT_TOKEN` — the `xoxb-` token from step 6
   - `SLACK_APP_TOKEN` — the `xapp-` token from step 2

### Via the Admin API

```bash
# Install the Slack channel
curl -X POST http://localhost:8100/admin/channels/install \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "slack"}'
```

Then add the required environment variables to `~/.openpalm/vault/user.env`:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
```

Apply the changes:

```bash
curl -X POST http://localhost:8100/admin/install \
  -H "x-admin-token: $ADMIN_TOKEN"
```

## 8. Verify It Works

1. In the OpenPalm admin UI, go to the **Channels** page and confirm the Slack
   channel shows as **running**.
2. In your Slack workspace:
   - **DM the bot** — send a direct message and verify it responds.
   - **Mention the bot** in a channel — type `@OpenPalm hello` and verify it
     replies in a thread.
   - **Use `/ask`** — type `/ask what is OpenPalm?` and verify the response.
   - **Use `/help`** — verify the command list appears.
   - **Use `/clear`** — verify the conversation is cleared.

### Thread and session behavior

- Mentioning the bot in a channel always replies in a thread. If the mention is
  already inside a thread, the bot continues that thread.
- DMs use a per-user session. Each DM conversation maintains its own context.
- Thread-based channel conversations use a per-thread session, so multiple users
  can collaborate in the same thread with shared context.
- `/ask` posts a "processing" message that is updated with the response when ready.
- `/clear` clears the session for the current channel and user scope.

### Queue behavior

- If you send a message while the bot is still processing a previous one in the
  same session, the new message is queued and processed after the current one
  completes.
- A "Queued" confirmation is posted so you know the message was received.
- `/clear` drops any queued follow-ups for the current session.

### Thinking indicator

- When processing a message, the bot adds an :hourglass: reaction to your message.
- The reaction is removed once the response is posted.
- For `/ask` commands, a "Processing your request..." message is shown and then
  replaced with the response.

---

## 9. Access Control (Optional)

You can restrict which channels or users can interact with the bot by setting
environment variables in `vault/user.env`. All lists are comma-separated Slack IDs.

| Variable | Purpose |
|----------|---------|
| `SLACK_ALLOWED_CHANNELS` | Only respond in these channel IDs |
| `SLACK_ALLOWED_USERS` | Only respond to these user IDs |
| `SLACK_BLOCKED_USERS` | Block these user IDs (takes priority over allowlists) |

When an allowlist is empty, that dimension is unrestricted. For example, setting
only `SLACK_ALLOWED_CHANNELS` restricts by channel but allows all users within
those channels.

**Finding Slack IDs:**
- **Channel ID**: Open the channel, click the channel name at the top, scroll to
  the bottom of the "About" panel — the ID looks like `C01ABCDEF23`.
- **User ID**: Click a user's profile, then click the three dots menu → "Copy
  member ID". It looks like `U01ABCDEF23`.

After changing these values, apply the configuration:

```bash
curl -X POST http://localhost:8100/admin/install \
  -H "x-admin-token: $ADMIN_TOKEN"
```

---

## Troubleshooting

### Bot does not respond to messages

- Verify `SLACK_BOT_TOKEN` (starts with `xoxb-`) and `SLACK_APP_TOKEN` (starts
  with `xapp-`) are both set correctly.
- Confirm **Socket Mode** is enabled in the Slack App settings.
- Check that the required **Event Subscriptions** (`app_mention`, `message.im`)
  are enabled.
- For channel messages, make sure you @mention the bot. The bot does not respond
  to channel messages without a mention (unless you subscribe to `message.channels`).
- Confirm the Slack channel container is running:
  ```bash
  curl http://localhost:8100/admin/containers/list \
    -H "x-admin-token: $ADMIN_TOKEN"
  ```
- Check the Slack channel logs:
  ```bash
  docker compose logs channel-slack --tail 50
  ```

### Bot does not respond to DMs

- Ensure the `im:history` and `im:read` scopes are added to the bot token.
- Ensure `message.im` is subscribed under Event Subscriptions.
- After adding new scopes, you must **reinstall the app** to your workspace
  (OAuth & Permissions → Reinstall to Workspace).

### Slash commands do not appear

- Verify the commands were created in the Slack App settings under **Slash Commands**.
- Slash commands may take a few minutes to propagate.
- Ensure `commands` scope is included in the bot token scopes.
- After adding slash commands, you must **reinstall the app** to your workspace.

### "not_allowed_token_type" error

- The `SLACK_APP_TOKEN` must be an **App-Level Token** (starts with `xapp-`),
  not the bot token.
- The App-Level Token must have the `connections:write` scope.

### Connection or timeout errors

- Check the guardian logs for HMAC or forwarding errors:
  ```bash
  docker compose logs guardian --tail 50
  ```
- Check the Slack channel logs:
  ```bash
  docker compose logs channel-slack --tail 50
  ```

### Permission denied errors

- After changing bot token scopes or event subscriptions, you must **reinstall the
  app** to your workspace for the changes to take effect.

---

## Environment Variable Reference

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SLACK_BOT_TOKEN` | Yes | -- | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | -- | App-Level Token for Socket Mode (`xapp-...`) |
| `SLACK_ALLOWED_CHANNELS` | No | -- | Comma-separated channel ID allowlist |
| `SLACK_ALLOWED_USERS` | No | -- | Comma-separated user ID allowlist |
| `SLACK_BLOCKED_USERS` | No | -- | Comma-separated user ID blocklist |
| `CHANNEL_SLACK_SECRET` | Auto | -- | HMAC secret for guardian (admin-managed) |
