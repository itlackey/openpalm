# Discord Bot Setup

This guide walks through connecting a Discord bot to your OpenPalm instance. By the
end, users in your Discord server will be able to interact with your assistant
using slash commands like `/ask` or by mentioning the bot in a channel.

---

## Prerequisites

- A running OpenPalm stack (see [setup-guide.md](setup-guide.md))
- A Discord account with permission to create applications
- Your OpenPalm admin token (`ADMIN_TOKEN`)

---

## 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, give it a name (e.g. "OpenPalm"), and confirm.
3. On the **General Information** page, copy the following values -- you will need
   them later:
   - **Application ID**
   - **Public Key**

## 2. Create the Bot

1. In the left sidebar, click **Bot**.
2. If a bot has not been created automatically, click **Add Bot**.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**. This is
   required for the bot to read message content in channels.
4. Click **Reset Token** (or **Copy** if the token is still visible), and save the
   bot token securely. You will not be able to see it again.

## 3. Install the Discord Channel in OpenPalm

### Via the Admin UI

1. Open the OpenPalm admin UI in your browser (default: `http://localhost:8100`).
2. Navigate to the **Channels** page.
3. Find **Discord** in the registry list and click **Install**.
4. After installation, go to the **Connections** page (or the channel's
   configuration section) and enter the following values:
   - `DISCORD_BOT_TOKEN` -- the bot token from step 2
   - `DISCORD_APPLICATION_ID` -- the application ID from step 1
   - `DISCORD_PUBLIC_KEY` -- the public key from step 1

### Via the Admin API

```bash
# Install the Discord channel
curl -X POST http://localhost:8100/admin/channels/install \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "discord"}'
```

Then add the required environment variables to `~/.openpalm/vault/user.env`:

```env
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_APPLICATION_ID=your-application-id
DISCORD_PUBLIC_KEY=your-public-key
```

Apply the changes:

```bash
curl -X POST http://localhost:8100/admin/install \
  -H "x-admin-token: $ADMIN_TOKEN"
```

## 4. Set Up the Interactions Endpoint (Production)

If your OpenPalm instance is publicly accessible (i.e., has a domain name with
HTTPS), you should configure Discord to send interactions directly to your bot:

1. In the Discord Developer Portal, go to your application's **General Information**
   page.
2. Set the **Interactions Endpoint URL** to:
   ```
   https://<your-openpalm-domain>/discord/interactions
   ```
3. Discord will send a verification ping. If `DISCORD_PUBLIC_KEY` is configured
   correctly, the endpoint will respond and Discord will save the URL.

This enables slash commands to go through Discord's interactions system with
Ed25519 signature verification for security.

> For local development without a public URL, set `DISCORD_ALLOW_UNSIGNED_INTERACTIONS=true`
> in your `vault/user.env`. Do not use this setting in production.

## 5. Invite the Bot to Your Server

1. In the Discord Developer Portal, go to **OAuth2** in the left sidebar.
2. Under **OAuth2 URL Generator**, select the following scopes:
   - `bot`
   - `applications.commands`
3. Under **Bot Permissions**, select at minimum:
   - Send Messages
   - Read Message History
   - Use Slash Commands
   - Embed Links (recommended, for formatted responses)
4. Copy the generated URL and open it in your browser.
5. Select the Discord server you want to add the bot to, and authorize it.

### Quick invite URL

You can also construct the URL manually. Replace `YOUR_APPLICATION_ID` with your
application ID:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=19456&scope=bot%20applications.commands
```

The permission value `19456` includes Send Messages (2048), Embed Links (16384),
and Read Message History (1024). Adjust if you need additional permissions.

## 6. Verify It Works

1. In the OpenPalm admin UI, go to the **Channels** page and confirm the Discord
    channel shows as **running**.
2. In your Discord server, type `/ask` followed by a message. The bot should
    respond with the assistant's reply.
3. Try `/health` to check the assistant connection status.
4. Try `/help` to see all available commands.
5. Mention the bot in a regular channel. The adapter should create a thread for
   that conversation and continue replying inside the thread.

### Thread and session behavior

- Mentioning the bot in a normal channel starts a Discord thread named from the
  first line of your message.
- Once the bot is active in that thread, replies inside the thread do not need a
  fresh mention.
- Mention-driven thread conversations map to a thread-scoped backend session.
- `/ask` stays inline as a slash-command response; it does not create a thread.
- Slash-command conversations use the current thread when one exists; otherwise
  they use a channel-plus-user backend session scope.
- `/clear` clears the active backend conversation for the current Discord
  conversation scope.

### Request feedback and queue behavior

- Mention-driven conversations show Discord typing indicators while OpenPalm is
  working.
- Slash commands use Discord's deferred reply flow so requests can run longer than
  the 3-second interaction deadline.
- Replies longer than Discord's message limit are split into multiple messages.
- `/queue` lets you queue a follow-up prompt for the current conversation.
- If a user posts another message in an active tracked thread while the bot is
  still processing, the follow-up is queued automatically.

### Built-in Slash Commands

| Command  | Description                                        |
|----------|----------------------------------------------------|
| `/ask`   | Send a message to the assistant                    |
| `/queue` | Queue a follow-up for the current conversation     |
| `/health`| Check the assistant's health status                |
| `/help`  | Show available commands and usage information       |
| `/clear` | Clear the current conversation scope and drop queued follow-ups for it |

---

## 7. Access Control (Optional)

You can restrict which guilds, roles, or users can interact with the bot by
setting environment variables in `vault/user.env`. All lists are comma-separated
Discord IDs.

| Variable                 | Purpose                                    |
|--------------------------|--------------------------------------------|
| `DISCORD_ALLOWED_GUILDS` | Only allow interactions from these servers  |
| `DISCORD_ALLOWED_ROLES`  | Only allow users with these roles           |
| `DISCORD_ALLOWED_USERS`  | Only allow these specific users             |
| `DISCORD_BLOCKED_USERS`  | Block these users (takes priority over allowlists) |

When an allowlist is empty, that dimension is unrestricted. For example, setting
only `DISCORD_ALLOWED_GUILDS` restricts by server but allows all users within
those servers.

After changing these values, apply the configuration:

```bash
curl -X POST http://localhost:8100/admin/install \
  -H "x-admin-token: $ADMIN_TOKEN"
```

## 8. Custom Slash Commands (Optional)

You can add custom slash commands by setting `DISCORD_CUSTOM_COMMANDS` to a JSON
array in your `vault/user.env`. Each command can include a prompt template that maps
command options to an assistant prompt.

```env
DISCORD_CUSTOM_COMMANDS='[{"name":"summarize","description":"Summarize a topic","options":[{"name":"topic","description":"Topic to summarize","type":3,"required":true}],"promptTemplate":"Please summarize: {{topic}}"}]'
```

Custom commands are registered with Discord automatically on startup (unless
`DISCORD_REGISTER_COMMANDS=false`). Commands with names that conflict with
built-in commands (`ask`, `health`, `help`, `clear`, `queue`) are ignored. A maximum of
20 custom commands are supported.

Custom commands follow the same execution model as `/ask`: they defer the slash
command response, send a prompt to OpenPalm, and reply inline rather than opening
a Discord thread.

---

## Troubleshooting

### Bot does not respond to messages

- Verify **Message Content Intent** is enabled in the Discord Developer Portal
  under Bot > Privileged Gateway Intents.
- Check that `DISCORD_BOT_TOKEN` is set correctly. Tokens are long strings that
  look like `MTIz...abc`.
- In channel conversations, make sure you either mention the bot to start a new
  thread or continue inside a thread the bot already started tracking.
- Confirm the Discord channel container is running:
  ```bash
  curl http://localhost:8100/admin/containers/list \
    -H "x-admin-token: $ADMIN_TOKEN"
  ```

### Slash commands do not appear

- Ensure both `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN` are set. Both are
  required for automatic command registration.
- Check that `DISCORD_REGISTER_COMMANDS` is not set to `false`.
- Global slash commands can take up to an hour to propagate. Guild-scoped commands
  (when `DISCORD_ALLOWED_GUILDS` is set) appear immediately.

### Interactions endpoint verification fails

- Confirm `DISCORD_PUBLIC_KEY` matches the value shown on the General Information
  page of the Developer Portal.
- The endpoint must be reachable from the internet over HTTPS. Discord will not
  accept HTTP URLs.

### Connection or timeout errors

- Check the guardian logs for HMAC or forwarding errors:
  ```bash
  docker compose logs guardian --tail 50
  ```
- Check the Discord channel logs:
  ```bash
  docker compose logs channel-discord --tail 50
  ```
- If `/clear` fails, check guardian and channel logs to confirm the clear request
  reached guardian successfully.

### Rate limiting

Discord enforces rate limits on bot API calls. The channel adapter handles
standard rate limiting automatically, but if you see 429 errors in the logs:

- Reduce the frequency of requests if possible.
- If using `DISCORD_ALLOWED_GUILDS`, commands are registered per guild instead
  of globally, which uses a separate (per-guild) rate limit bucket.

---

## Environment Variable Reference

| Variable                              | Required | Default | Purpose                                      |
|---------------------------------------|----------|---------|----------------------------------------------|
| `DISCORD_BOT_TOKEN`                   | Yes      | --      | Bot token for command registration            |
| `DISCORD_APPLICATION_ID`              | Yes      | --      | Application ID for command registration       |
| `DISCORD_PUBLIC_KEY`                   | Yes (prod) | --    | Ed25519 public key for signature verification |
| `DISCORD_ALLOW_UNSIGNED_INTERACTIONS` | No       | `false` | Allow unsigned interactions (dev only)         |
| `DISCORD_REGISTER_COMMANDS`           | No       | `true`  | Register slash commands on startup             |
| `DISCORD_ALLOWED_GUILDS`             | No       | --      | Comma-separated guild ID allowlist             |
| `DISCORD_ALLOWED_ROLES`             | No       | --      | Comma-separated role ID allowlist              |
| `DISCORD_ALLOWED_USERS`             | No       | --      | Comma-separated user ID allowlist              |
| `DISCORD_BLOCKED_USERS`             | No       | --      | Comma-separated user ID blocklist              |
| `DISCORD_CUSTOM_COMMANDS`           | No       | --      | JSON array of custom slash command definitions |
| `CHANNEL_DISCORD_SECRET`            | Auto     | --      | HMAC secret for guardian (admin-managed)        |
