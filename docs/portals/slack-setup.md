# Slack adapter

Slack is an optional Socket Mode adapter and MCP client of Guardian.

## 1. Create the Slack app

Create an app in the Slack API console and:

1. enable Socket Mode;
2. create an app-level token with `connections:write`;
3. grant the bot `app_mentions:read`, `chat:write`, and the history scopes
   needed for the channel types you will allow;
4. subscribe to `app_mention` plus the message events needed for those channel
   types; and
5. install the app to the workspace.

Write the bot and app tokens to the host:

```text
~/.openpalm/state/secrets/slack_bot_token
~/.openpalm/state/secrets/slack_app_token
```

Both files must be mode 0600. Do not store the values in Compose environment
variables.

## 2. Configure a default-deny scope

Edit `config/stack/custom.compose.yml`:

```yaml
services:
  slack:
    environment:
      SLACK_ALLOWED_CHANNELS: "C0123456789"
      SLACK_ALLOWED_USERS: ""
      SLACK_BLOCKED_USERS: ""
```

Values are comma-separated Slack IDs. Every non-empty allowlist must match. A
blocked user always loses access. Configure users alone to allow direct
messages; a DM cannot satisfy a channel constraint. The adapter refuses all use
when both allowlists are empty.

## 3. Enable and verify

```bash
openpalm credential set-policy slack chat
openpalm config portal slack --credential slack --no-apply
openpalm addon enable slack
openpalm status
openpalm logs
```

`chat` is the safe default for a shared chat platform. `read` additionally lets
the agent inspect non-secret content in `/stash` and `/work`; `full` inherits Assistant tool
permissions and should be used only when both the Slack allowlist and every
permitted user are trusted to trigger state-changing work.

The selected credential currently applies to every allowed Slack user. User-
or channel-specific credential mapping and OAuth are planned follow-up features.

Mention the app in an allowed channel or message it directly when the user
scope permits that. Thread replies retain an opaque Guardian conversation
handle. Send `/clear` or `!clear` to reset it.

The Slack adapter is intentionally a conversational subset of the MCP catalog.
If a `full` agent pauses for a permission decision, the adapter tells the user
to complete that explicit decision with a full MCP client; chat text is never
treated as permission approval.

Continuity state is stored at `data/portal/slack/portal.db`.
