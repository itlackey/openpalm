# Discord adapter

Discord is an optional adapter. It never calls Assistant directly; it is an MCP
client of Guardian.

## 1. Create the Discord application

In the Discord developer portal:

1. create an application and bot;
2. enable the Message Content intent;
3. invite the bot with permission to view channels, read message history, and
   send messages; and
4. copy the bot token once.

Write the token on the host:

```bash
install -m 600 /dev/null ~/.openpalm/state/secrets/discord_bot_token
printf '%s' 'BOT_TOKEN' > ~/.openpalm/state/secrets/discord_bot_token
```

Avoid putting the token in shell history; an interactive secret editor or
password-manager command is preferable.

## 2. Configure a default-deny scope

Edit `config/stack/custom.compose.yml` and set at least one allowlist:

```yaml
services:
  discord:
    environment:
      DISCORD_ALLOWED_GUILDS: "guild-id"
      DISCORD_ALLOWED_ROLES: "role-id"
      DISCORD_ALLOWED_USERS: ""
      DISCORD_BLOCKED_USERS: ""
```

Values are comma-separated Discord snowflake IDs. Every non-empty allowlist must
match. For example, configured guild and role lists require both a permitted
guild and a permitted role. A blocked user always loses access.

For direct messages, configure `DISCORD_ALLOWED_USERS` and leave guild/role
lists empty; a DM cannot satisfy a guild or role constraint. The adapter refuses
all use when every allowlist is empty.

## 3. Enable and verify

```bash
openpalm credential set-policy discord chat
openpalm config portal discord --credential discord --no-apply
openpalm addon enable discord
openpalm status
openpalm logs
```

`chat` is the safe default for a shared chat platform. `read` additionally lets
the agent inspect non-secret content in `/stash` and `/work`; `full` inherits Assistant tool
permissions and should be used only when both the Discord allowlist and every
permitted user are trusted to trigger state-changing work.

The selected credential is the fallback for every allowed Discord user. Map an
exact Discord user snowflake to another named credential when that user needs a
different policy:

```bash
openpalm credential add support-read read
openpalm credential map discord 123456789012345678 support-read
openpalm credential mappings discord
```

Remove the override with `openpalm credential unmap discord
123456789012345678`. All guild, role, user, and block-list checks still apply;
a credential mapping never grants portal access. The portal receives only a
generated keyring for its fallback and mapped credentials. OAuth remains a
future identity source for the same registry.

Mention the bot in an allowed server channel or send an allowed direct message.
Replies continue within a per-user channel/thread and credential-scoped
conversation. Changing a user's mapping starts fresh policy continuity. Send
`/clear` or `!clear` to discard that local conversation handle.

The adapter stores only opaque Guardian session handles in
`data/portal/discord/portal.db`.

The Discord adapter is intentionally a conversational subset of the MCP
catalog. If a `full` agent pauses for a permission decision, the adapter tells
the user to complete that explicit decision with a full MCP client; chat text
is never treated as permission approval.
